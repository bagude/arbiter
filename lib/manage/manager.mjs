// manager — the model that answers an observation packet with one instruction (spec §3 and §7),
// the replay harness that scores candidate managers against the recorded ledger, and the serve
// loop that joins the two to a live run.
//
// Everything here is pure over an injected `fetchImpl`: `decide` never reaches for a global
// client, never reads a key from the environment, and never logs one. The CLI supplies both
// (tools/manage.mjs). That is what lets the whole driver be exercised offline — every test in
// test/manage-manager.test.mjs runs against a fake fetch.
//
// The manager's authority ends at the instruction. Nothing in this file touches a workspace, an
// oracle or a transcript: it assembles a packet from records the harness already wrote, asks a
// model for one verb, and hands the answer to the executor, which checks every precondition
// again before anything moves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../jev.mjs";
import { INSTRUCTION_VERBS, MAX_RATIONALE, executeInstruction, registerRunForTrigger } from "./instructions.mjs";
import { assemblePacket, writePacket } from "./packet.mjs";
import { readLedger, reversedSeqs } from "./ledger.mjs";
import { loadTask } from "./task-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");

/** §7: "the first live manager is the most capable model available, so the dataset is labelled
 * by good decisions." Replays name cheaper candidates explicitly. */
export const DEFAULT_MANAGER_MODEL = "claude-opus-5";
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** One instruction is a verb, a small args object and ≤ 500 characters of rationale. */
export const MAX_DECISION_TOKENS = 1024;
/** §4's decision timeout: past it the harness proceeds with the default, so the manager must
 * answer inside the same window the supervisor waits. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.MANAGE_DECISION_TIMEOUT_MS ?? "") > 0 ? Number(process.env.MANAGE_DECISION_TIMEOUT_MS) : 120_000;

const SYSTEM_PROMPT_FILE = path.join(ROOT, "docs", "manage", "manager-system.md");

let systemCache = null;
/** The fixed system prompt (docs/manage/manager-system.md), read once. Resolved from this
 * module's own location, never the cwd: the serve loop is launched from wherever an operator
 * happens to be standing. */
export function systemPrompt(file = SYSTEM_PROMPT_FILE) {
	if (file === SYSTEM_PROMPT_FILE && systemCache) return systemCache;
	const text = fs.readFileSync(file, "utf8");
	if (file === SYSTEM_PROMPT_FILE) systemCache = text;
	return text;
}

/**
 * The one tool the manager may call. The verb is an enum over the contract, and the per-verb arg
 * shapes are described rather than expressed as a JSON-schema `oneOf` keyed on a sibling
 * property: that shape is not something the Messages API validates, so it would read as
 * decoration while the real check happened later anyway. The real check is
 * `validateInstruction`, which runs on the way to execution for every instruction, however it
 * was produced.
 */
export const INSTRUCT_TOOL = {
	name: "instruct",
	description: [
		"Answer this observation packet with exactly one instruction.",
		"",
		"args by verb:",
		"- continue: { runId: string, milestone: string, budgetGrant: { wallSec: number, toolCalls: number } } — a zero grant is allowed and costs nothing.",
		"- correct: { runId: string, message: string }  (message ≤ 2000 chars, delivered to the orchestrator)",
		"- restore: { checkpoint: string, approach: { config?: string, firstAction?: string, message?: string } } — a ck-NNNN checkpoint takes approach.config only; a run:<id>@<call> capture takes firstAction and/or message only.",
		"- compare: { checkpoint: string, branches: [ { label: string, firstAction?: string, message?: string } ], replicates: number } — at least 2 branches with unique labels, replicates a whole number >= 2.",
		"- accept: { milestone: string, checkpoint: string, evidence: string[] } — evidence is run ids; the harness verifies every criterion itself.",
		"- escalate: { reason: string, wants: \"criteria_change\" | \"human_review\" | \"budget\" }",
		"",
		"Use only a verb listed in options.verbsAllowed. Do not include packetId, basedOnStateVersion or idempotencyKey: the harness fills those in.",
	].join("\n"),
	input_schema: {
		type: "object",
		properties: {
			verb: { type: "string", enum: [...INSTRUCTION_VERBS], description: "the single verb, from options.verbsAllowed" },
			args: { type: "object", description: "the args for that verb, exactly as described above" },
			rationale: { type: "string", maxLength: MAX_RATIONALE, description: "what in the packet decided it, for the ledger" },
		},
		required: ["verb", "args", "rationale"],
	},
};

/**
 * The Messages API request for one packet. Kept as its own exported function so a shape fix
 * (a beta flag, an effort level, a thinking setting) is one edit in one place, and so a test can
 * assert what goes on the wire without a network.
 */
export function requestBody({ packet, model = DEFAULT_MANAGER_MODEL, system = systemPrompt() }) {
	return {
		model,
		max_tokens: MAX_DECISION_TOKENS,
		system,
		messages: [{ role: "user", content: JSON.stringify(packet, null, 2) }],
		tools: [INSTRUCT_TOOL],
		tool_choice: { type: "tool", name: "instruct" },
	};
}

/** The three fields the driver owns. §3: the manager never supplies them, and a model that
 * offers them anyway is overridden — they are what the version check and the duplicate rule
 * are built on. */
export function fillInstruction(packet, { verb, args, rationale }) {
	const version = packet?.task?.stateVersion ?? null;
	return {
		packetId: packet?.packetId ?? null,
		basedOnStateVersion: version,
		idempotencyKey: `p${packet?.packetId ?? "?"}-v${version ?? "?"}`,
		verb,
		args,
		rationale,
	};
}

/**
 * §4's default: a slow, broken or absent manager degrades to today's behaviour rather than
 * deadlocking the run. A zero grant spends nothing, so the executor writes no task state at all
 * — it appends the grant and the trailing `decision` entry, which is exactly what releases a
 * paused supervisor.
 */
export function defaultInstruction(packet, { error = null } = {}) {
	const instr = fillInstruction(packet, {
		verb: "continue",
		args: {
			runId: packet?.run?.id ?? packet?.trigger?.runId ?? null,
			milestone: packet?.task?.current?.milestone ?? null,
			budgetGrant: { wallSec: 0, toolCalls: 0 },
		},
		// Bounded hard: a rationale over MAX_RATIONALE is refused as a precondition failure, and
		// the default would then never execute — a paused supervisor would wait out the timeout
		// for a second time over an error message that was too long.
		rationale: clip(`defaulted to continue with a zero grant: ${error ?? "no manager answer"}`, MAX_RATIONALE),
	});
	return { ...instr, defaulted: true, error: error ?? null };
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
/** Whatever an error path says, said safely: redacted, one line, and short enough for a ledger
 * row that is read back into packets. */
const errorText = (s) => clip(redact(String(s ?? "")).replace(/\s+/g, " ").trim(), 300);

const TIMED_OUT = Symbol("timed out");

/** A race, not just an AbortSignal: a transport that ignores the signal (a fake, a proxy, a
 * hung socket that never errors) must still reach the default inside the decision window. */
async function withTimeout(promise, ms) {
	let timer = null;
	try {
		return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); })]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The `instruct` call out of a Messages response, or null. */
export function toolUseOf(message) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks.find((b) => b?.type === "tool_use" && b?.name === INSTRUCT_TOOL.name) ?? null;
}

/**
 * One packet in, one instruction out.
 *
 * Never throws and never returns nothing: every failure — a transport error, a non-2xx, a body
 * that is not JSON, a missing tool call, a verb outside the contract, the decision timeout —
 * becomes the default `continue` with a zero grant and the reason attached, because the run on
 * the other side may be paused waiting for exactly this answer.
 *
 * `apiKey` is passed in and used once, in a header. It is never logged, never put in an error
 * message, and never rendered with the request: the error path stringifies the response body
 * (redacted) and the status, never the request.
 */
export async function decide({
	packet,
	model = DEFAULT_MANAGER_MODEL,
	fetchImpl = globalThis.fetch,
	apiKey = null,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	url = MESSAGES_URL,
	system = undefined,
}) {
	const started = Date.now();
	const manager = (error = null) => ({ model, ms: Date.now() - started, ...(error ? { error } : {}) });
	const fail = (error) => ({ ...defaultInstruction(packet, { error }), manager: manager(error) });

	let res;
	try {
		res = await withTimeout(
			fetchImpl(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": ANTHROPIC_VERSION,
					...(apiKey ? { "x-api-key": apiKey } : {}),
				},
				body: JSON.stringify(requestBody({ packet, model, ...(system === undefined ? {} : { system }) })),
				// Belt as well as braces: the race above bounds the wait, this bounds the socket.
				...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
			}),
			timeoutMs,
		);
	} catch (err) {
		return fail(`the manager call failed: ${errorText(err?.message ?? err)}`);
	}
	if (res === TIMED_OUT) return fail(`no manager answer within ${timeoutMs} ms`);

	let body;
	try {
		if (res?.ok === false) {
			const text = typeof res.text === "function" ? await res.text() : "";
			return fail(`the manager call returned HTTP ${res.status ?? "?"}: ${errorText(text)}`);
		}
		body = await res.json();
	} catch (err) {
		return fail(`the manager's answer could not be read: ${errorText(err?.message ?? err)}`);
	}

	const call = toolUseOf(body);
	if (!call) return fail(`the manager returned no ${INSTRUCT_TOOL.name} call (stop_reason ${JSON.stringify(body?.stop_reason ?? null)})`);
	const input = call.input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return fail("the instruct call carried no arguments object");
	if (!INSTRUCTION_VERBS.includes(input.verb)) return fail(`the manager named verb ${JSON.stringify(input.verb)}, which is not in the contract (${INSTRUCTION_VERBS.join(", ")})`);
	const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args : {};

	return {
		...fillInstruction(packet, { verb: input.verb, args, rationale: clip(String(input.rationale ?? ""), MAX_RATIONALE) }),
		manager: manager(),
	};
}

// ---------- replay (§7) ----------

/**
 * The instruction that actually EXECUTED for a packet, or null.
 *
 * Three filters, and each one is load-bearing: `verified === true` (a refusal is a ledger row
 * too, and a refused verb is not what the harness did), not retracted by a later `reversed` row
 * (an instruction that was recorded and then could not be carried out), and the last such row
 * for the packet (a manager may be refused and then answer the same packet correctly).
 */
export function executedFor(rows, packetId) {
	const retracted = reversedSeqs(rows);
	const matches = rows.filter((r) => r.packetId === packetId && r.verified === true && r.instruction?.verb && !retracted.has(r.seq));
	return matches.length ? matches[matches.length - 1].instruction : null;
}

/** What a replay compares: the verb, plus the one arg that makes the verb mean something
 * different. A `correct` of another run and a `restore` of another checkpoint are not the same
 * decision, however matched the verbs are. */
export function decisionShape(instr) {
	if (!instr) return null;
	const a = instr.args ?? {};
	return {
		verb: instr.verb,
		...(instr.verb === "continue" || instr.verb === "correct" ? { runId: a.runId ?? null } : {}),
		...(instr.verb === "restore" || instr.verb === "compare" || instr.verb === "accept" ? { checkpoint: a.checkpoint ?? null } : {}),
	};
}

/** Did the candidate make the same decision the ledger recorded? The verb first; then the
 * target, but only for the verbs whose target changes what happens (§7's "match correct's runId
 * and restore/compare's checkpoint when the verb matches"). */
export function agrees(expected, got) {
	if (!expected || !got || expected.verb !== got.verb) return false;
	if (expected.verb === "correct") return (expected.runId ?? null) === (got.runId ?? null);
	if (expected.verb === "restore" || expected.verb === "compare") return (expected.checkpoint ?? null) === (got.checkpoint ?? null);
	return true;
}

/** A timestamp a Windows filename can hold — the same shape as a run id. */
export const fileStamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/:/g, "-");

/** The rendered agreement report: overall, per trigger kind, and a verb confusion table. */
export function replayReport(rows, model) {
	const out = [];
	const agreed = rows.filter((r) => r.agree).length;
	out.push(`agreement ${agreed}/${rows.length}${rows.length ? ` (${((agreed / rows.length) * 100).toFixed(0)}%)` : ""} — ${model}`);
	const kinds = [...new Set(rows.map((r) => r.trigger ?? "none"))].sort();
	for (const kind of kinds) {
		const sub = rows.filter((r) => (r.trigger ?? "none") === kind);
		out.push(`  ${kind}: ${sub.filter((r) => r.agree).length}/${sub.length}`);
	}
	const pairs = new Map();
	for (const r of rows) {
		const key = `${r.expected?.verb ?? "none"} -> ${r.got?.verb ?? "none"}`;
		pairs.set(key, (pairs.get(key) ?? 0) + 1);
	}
	out.push("confusion (ledger -> candidate):");
	for (const [key, n] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) out.push(`  ${key}\t${n}`);
	return out.join("\n");
}

/**
 * §7's offline evaluation: replay recorded packets against a candidate manager and score its
 * instructions against what the ledger says the harness actually did.
 *
 * Packets with no executed instruction are skipped rather than counted as disagreements — a
 * packet that was answered by a refusal, or never answered at all, has no label. The rows and
 * the report are written under the task directory, so a candidate's numbers live beside the
 * dataset they were measured on.
 */
export async function replay({ taskDir, packetIds = null, model = DEFAULT_MANAGER_MODEL, fetchImpl = globalThis.fetch, apiKey = null, timeoutMs = DEFAULT_TIMEOUT_MS, url = MESSAGES_URL, decideImpl = decide, out = console.log, now = new Date() }) {
	const ledger = readLedger(taskDir);
	const dir = path.join(taskDir, "packets");
	const ids = (packetIds ?? (fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])) : [])).slice().sort((a, b) => a - b);

	const rows = [];
	const skipped = [];
	for (const packetId of ids) {
		const file = path.join(dir, `${packetId}.json`);
		if (!fs.existsSync(file)) {
			skipped.push({ packetId, why: "no packet file" });
			continue;
		}
		const packet = JSON.parse(fs.readFileSync(file, "utf8"));
		const expected = executedFor(ledger, packetId);
		if (!expected) {
			skipped.push({ packetId, why: "no executed instruction in the ledger" });
			continue;
		}
		const started = Date.now();
		const got = await decideImpl({ packet, model, fetchImpl, apiKey, timeoutMs, url });
		const shapeExpected = decisionShape(expected);
		const shapeGot = decisionShape(got);
		rows.push({
			packetId,
			trigger: packet?.trigger?.kind ?? null,
			expected: shapeExpected,
			got: shapeGot,
			agree: agrees(shapeExpected, shapeGot),
			defaulted: got.defaulted === true,
			error: got.error ?? null,
			ms: got.manager?.ms ?? Date.now() - started,
		});
	}

	const replaysDir = path.join(taskDir, "replays");
	fs.mkdirSync(replaysDir, { recursive: true });
	const file = path.join(replaysDir, `${String(model).replace(/[^A-Za-z0-9._-]/g, "-")}-${fileStamp(now)}.jsonl`);
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
	const report = replayReport(rows, model);
	out(report);
	for (const s of skipped) out(`  skipped packet ${s.packetId}: ${s.why}`);
	out(file);
	return { rows, skipped, file, report };
}

// ---------- serve: the loop that joins a live run to the driver ----------

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

/**
 * The config a run was started with, or null — the same three places packet.mjs looks, for the
 * same reason: only `summary.json` records it, and that is written on the way out.
 */
export function runConfigPath(runDir) {
	for (const name of ["config.json", "arbiter.json"]) {
		if (fs.existsSync(path.join(runDir, name))) return path.join(runDir, name);
	}
	const summaryFile = path.join(runDir, "summary.json");
	if (fs.existsSync(summaryFile)) {
		try {
			const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
			const p = s?.config?.configPath ?? (typeof s?.config === "string" ? s.config : null);
			if (p) return path.isAbsolute(p) ? p : path.join(ROOT, p);
		} catch { /* a truncated summary is not a config */ }
	}
	const line = readJsonl(path.join(runDir, "audit.jsonl")).find((l) => l.type === "config" && typeof l.msg === "string");
	return line ? (path.isAbsolute(line.msg) ? line.msg : path.join(ROOT, line.msg)) : null;
}

/** Does this run's own config name this task? Resolved against the arbiter root, exactly as the
 * supervisor resolves `manage.taskDir` — a relative path in a config means the same directory
 * whatever cwd the serve loop was launched from. */
export function runNamesTask(runDir, taskDir) {
	const configPath = runConfigPath(runDir);
	if (!configPath || !fs.existsSync(configPath)) return false;
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8"))?.manage?.taskDir;
		if (!raw) return false;
		return path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw)) === path.resolve(taskDir);
	} catch {
		return false;
	}
}

/** Does any of this run's trigger events name this task directory? The supervisor puts the
 * resolved `manage.taskDir` on every `packetRequest`, so a live run identifies itself the moment
 * it first triggers — before the task registers it and without a readable config. */
export function runTriggersName(runDir, taskDir) {
	const want = path.resolve(taskDir);
	return triggerEvents(runDir).some((e) => {
		const raw = e?.data?.packetRequest?.taskDir;
		return typeof raw === "string" && raw && path.resolve(raw) === want;
	});
}

/**
 * The runs this loop will answer triggers for.
 *
 * Deliberately narrow: answering an unidentified run's trigger would execute an instruction
 * against the wrong task's ledger. A run is admitted when the task itself registered it, when
 * one of its trigger events names this task directory, when the run's own config names it, or
 * when an operator named it with `--run`.
 */
export function runsForTask({ taskDir, runsDir, adopt = [], configCache = null }) {
	const ids = new Set(adopt.filter(Boolean));
	try {
		for (const id of loadTask(taskDir).current?.activeRuns ?? []) ids.add(id);
	} catch { /* a task directory that cannot be read has no runs */ }
	if (fs.existsSync(runsDir)) {
		for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || ids.has(entry.name)) continue;
			const runDir = path.join(runsDir, entry.name);
			if (!fs.existsSync(path.join(runDir, "lifecycle.jsonl"))) continue;
			// Memoised across ticks when the loop passes a cache, and POSITIVE verdicts only: a run
			// that does not name this task yet may name it a moment later (the supervisor writes what
			// it writes when it writes it), so a cached "no" would be a run this loop never answers.
			// A cached "yes" cannot go stale — a config does not un-name a task.
			if (configCache?.get(entry.name) || runTriggersName(runDir, taskDir) || runNamesTask(runDir, taskDir)) {
				configCache?.set(entry.name, true);
				ids.add(entry.name);
			}
		}
	}
	return [...ids].filter((id) => fs.existsSync(path.join(runsDir, id, "lifecycle.jsonl")));
}

/** Every `manage:trigger` a run has emitted, in order. The index is the handle: the loop's state
 * file records how many of a run's triggers it has answered. */
export function triggerEvents(runDir) {
	return readJsonl(path.join(runDir, "lifecycle.jsonl")).filter((e) => e.ev === "manage:trigger");
}

const stateFile = (taskDir) => path.join(taskDir, "serve.state.json");
const readServeState = (taskDir) => {
	try {
		return JSON.parse(fs.readFileSync(stateFile(taskDir), "utf8"));
	} catch {
		return { handled: {} };
	}
};
const writeServeState = (taskDir, state) => fs.writeFileSync(stateFile(taskDir), JSON.stringify(state, null, 2));

/**
 * Answers ONE trigger: assemble the packet, ask the manager, execute the instruction.
 *
 * Never raises on the manager's account — `decide` turns every failure into the default
 * `continue` — and never raises on the executor's either: a refusal is a return value, and the
 * caller logs it. What can still throw is the packet assembly (a run directory that vanished),
 * and the loop catches that around this call.
 */
export async function handleTrigger({ taskDir, runsDir, runId, event, model, fetchImpl, apiKey, timeoutMs, url, decideImpl = decide, execute = executeInstruction, launchBatch, save, log = () => {} }) {
	const trigger = { kind: event?.data?.kind ?? "run_ended_without_acceptance", runId, detail: event?.data?.packetRequest?.detail ?? {} };
	// Before the packet, exactly as `tools/manage.mjs packet` does it: registration is what makes
	// `continue` and `correct` legal for this run, and the packet must carry the version it
	// produced, because that is the version the instruction will name.
	const registered = registerRunForTrigger(taskDir, trigger, { runsDir });
	if (registered) log(`${runId}: registered for ${trigger.kind} at stateVersion ${registered.stateVersion}`);
	const packet = assemblePacket({ taskDir, runDir: path.join(runsDir, runId), trigger });
	const packetFile = writePacket(taskDir, packet);
	log(`${runId}: ${trigger.kind} → packet ${packet.packetId} (${packetFile})`);

	const decision = await decideImpl({ packet, model, fetchImpl, apiKey, timeoutMs, url });
	const { manager, ...instr } = decision;
	log(`packet ${packet.packetId}: ${instr.verb}${instr.defaulted ? " (defaulted)" : ""} in ${manager?.ms ?? "?"} ms${instr.error ? ` — ${instr.error}` : ""}`);

	const result = execute({ taskDir, instr, packet, runsDir, manager, ...(launchBatch ? { launchBatch } : {}), ...(save ? { save } : {}) });
	log(`packet ${packet.packetId}: ${result.executed ? "executed" : result.duplicate ? "already executed" : `refused (${result.code}): ${result.refusal}`}`);
	return { packet, instr, manager, result };
}

/**
 * Watches every live run of this task for `manage:trigger` events and answers each one exactly
 * once. `--once` handles a single trigger and returns, which is how the loop is tested and how
 * a controller drives one decision by hand.
 *
 * Which triggers have been answered is durable (`serve.state.json`), not in-memory: a loop
 * restarted mid-run must not re-answer the trigger it already answered, and must not skip the
 * one it has not. The packet id would collide anyway (`writePacket` creates exclusively), but
 * the second instruction is the part that matters.
 */
export async function serve({
	taskDir, runsDir, model = DEFAULT_MANAGER_MODEL, fetchImpl = globalThis.fetch, apiKey = null,
	timeoutMs = DEFAULT_TIMEOUT_MS, url = MESSAGES_URL, once = false, adopt = [], pollMs = 2000,
	maxTicks = Infinity, decideImpl = decide, execute = executeInstruction, launchBatch, save,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logFile = null,
}) {
	const file = logFile ?? path.join(taskDir, "serve.log");
	const log = (line) => {
		const text = `[${new Date().toISOString()}] ${line}\n`;
		try { fs.appendFileSync(file, text); } catch { /* the loop must outlive its own log */ }
		console.error(`[serve] ${line}`);
	};
	log(`watching ${runsDir} for ${taskDir} (model ${model}${once ? ", once" : ""})`);

	const handled = [];
	const configCache = new Map();
	for (let tick = 0; tick < maxTicks; tick++) {
		const state = readServeState(taskDir);
		for (const runId of runsForTask({ taskDir, runsDir, adopt, configCache })) {
			const events = triggerEvents(path.join(runsDir, runId));
			const done = Number(state.handled?.[runId] ?? 0);
			for (let i = done; i < events.length; i++) {
				try {
					const out = await handleTrigger({ taskDir, runsDir, runId, event: events[i], model, fetchImpl, apiKey, timeoutMs, url, decideImpl, execute, launchBatch, save, log });
					handled.push(out);
				} catch (err) {
					// A loop that dies on one bad run stops answering every other run's triggers, and
					// the supervisor on the other side waits out its timeout for each of them.
					log(`${runId}: trigger ${i} could not be answered: ${errorText(err?.stack ?? err)}`);
				}
				state.handled = { ...(state.handled ?? {}), [runId]: i + 1 };
				writeServeState(taskDir, state);
				if (once) return { handled, file };
			}
		}
		if (tick + 1 < maxTicks) await sleep(pollMs);
	}
	return { handled, file };
}
