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
import { assemblePacket, triggerIndexOf, writePacket } from "./packet.mjs";
import { readLedger, reversedSeqs } from "./ledger.mjs";
import { loadTask } from "./task-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");

/** §7: "the first live manager is the most capable model available, so the dataset is labelled
 * by good decisions." Replays name cheaper candidates explicitly. */
export const DEFAULT_MANAGER_MODEL = "claude-opus-5";
export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * The output cap for one decision.
 *
 * NOT the size of the answer. Thinking is on by default on the models this driver is pointed at,
 * and thinking tokens count against `max_tokens` like any other output — so a cap sized for "a
 * verb, a small args object and ≤ 500 characters of rationale" is a cap the model can hit before
 * it ever emits the `instruct` call. That comes back HTTP 200 with `stop_reason: "max_tokens"`
 * and no tool block, which this driver reads as "no instruct call" and turns into the default: a
 * ledger of zero-grant continues, labelled by the harness rather than by a manager, which is the
 * one thing §7's dataset must not be.
 */
export const MAX_DECISION_TOKENS = 4096;

/** Forced tool use is a documented hard 400 on these families (`tool_choice` `any` and `tool`),
 * and every packet forces the `instruct` call — so a run pointed at one of them would produce
 * nothing but defaults. Refused at the CLI and inside `decide`, before any request is made. */
export const UNSUPPORTED_MODEL = /^claude-(fable|mythos)-/;
export const unsupportedModelReason = (model) =>
	`${model} rejects a forced tool_choice with a 400, and every packet forces the instruct call — every decision would be a default; use ${DEFAULT_MANAGER_MODEL} (or another non-fable/mythos model)`;

/** §4's deadline: the supervisor holds a paused delivery this long, then defaults and closes the
 * pause. Read the same way the supervisor reads it, so the two agree by construction. */
export const supervisorDeadlineMs = (env = process.env) =>
	Number(env.MANAGE_DECISION_TIMEOUT_MS ?? "") > 0 ? Number(env.MANAGE_DECISION_TIMEOUT_MS) : 120_000;

/** The driver's share of that deadline. Everything else in the round trip — up to `pollMs` to
 * notice the event, packet assembly, the executor's control append, and up to the supervisor's
 * own 2 s control poll to read it — happens inside the same window and is not free, so an answer
 * that arrives at the deadline arrives at a pause that has already closed: the verdict has gone
 * out alone and the correction lands after it, which is exactly what §4 forbids. */
export const DRIVER_BUDGET_FRACTION = 0.75;

/** The driver's own budget: `MANAGE_DRIVER_TIMEOUT_MS` when set, else 0.75 of the supervisor's
 * deadline. Pure over `env` so the relation between the two is testable without a process. */
export const driverTimeoutMs = (env = process.env) => {
	const explicit = Number(env.MANAGE_DRIVER_TIMEOUT_MS ?? "");
	if (explicit > 0) return Math.floor(explicit);
	return Math.floor(supervisorDeadlineMs(env) * DRIVER_BUDGET_FRACTION);
};

export const SUPERVISOR_DEADLINE_MS = supervisorDeadlineMs();
export const DEFAULT_TIMEOUT_MS = driverTimeoutMs();

/** A transient answer, worth exactly one retry inside the driver's budget. */
export const isRetryableStatus = (status) => status === 429 || status === 529 || (status >= 500 && status < 600);
export const RETRY_DELAY_MS = 500;
/** What is left after the wait has to be enough for the retry to be an attempt rather than a
 * gesture: a retry that sleeps into a budget it then has no room to use is the same default,
 * later. */
export const MIN_ATTEMPT_MS = 250;

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
		"- restore: { checkpoint: string, approach: { config?: string, firstAction?: string, message?: string } } — a ck-NNNN checkpoint takes approach.config only; a run:<runId>#<call> capture takes firstAction and/or message, and approach.config only when the packet's run.config is not the config to rerun with (a message needs one whose manage block is enabled). While a run or a batch is still in flight, restore and compare are left out of options.verbsAllowed and cannot be asked for: there is one model server, and a second batch is abandoned after its budget is charged. Answer with correct or escalate instead; the two verbs return in the next packet once pendingRuns and pendingBatches are empty.",
		"- compare: { checkpoint: string, branches: [ { label: string, firstAction?: string, message?: string } ], replicates: number } — the checkpoint is a run:<runId>#<call> capture (never a ck-NNNN one: there is no recorded inference in an accepted workspace); at least 2 branches with unique labels, replicates a whole number >= 2.",
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
	retryDelayMs = RETRY_DELAY_MS,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
	const started = Date.now();
	const deadline = started + timeoutMs;
	const manager = (extra = {}) => ({ model, ms: Date.now() - started, ...extra });
	const fail = (error) => ({ ...defaultInstruction(packet, { error }), manager: manager({ error }) });

	// Before the request, not after a 400: forcing the instruct call is the whole contract here.
	if (UNSUPPORTED_MODEL.test(String(model))) return fail(unsupportedModelReason(model));

	let res = null;
	let body = null;
	for (let attempt = 0; ; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return fail(`no manager answer within ${timeoutMs} ms`);
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
					// Bounded by what is LEFT of the budget, not by the whole of it, so a retry cannot
					// run past the deadline the first attempt already spent part of.
					...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(remaining) } : {}),
				}),
				remaining,
			);
		} catch (err) {
			// A transport error is not retried: it is the one failure a second identical request is
			// least likely to answer, and the budget is better spent letting the default land early.
			return fail(`the manager call failed: ${errorText(err?.message ?? err)}`);
		}
		if (res === TIMED_OUT) return fail(`no manager answer within ${timeoutMs} ms`);

		if (res?.ok === false) {
			const status = Number(res.status ?? 0);
			let text = "";
			try {
				text = typeof res.text === "function" ? await res.text() : "";
			} catch { /* a body that cannot be read is still an HTTP failure */ }
			const why = `the manager call returned HTTP ${res.status ?? "?"}: ${errorText(text)}`;
			// One retry, and only for the answers a retry is for. Rate limits and overloads are the
			// transient case the SDKs retry for free and raw fetch does not; spending the whole
			// decision window on a 429 that a half-second wait would have cleared is the packet
			// answered by the harness instead of the manager.
			if (attempt === 0 && isRetryableStatus(status) && deadline - Date.now() - retryDelayMs >= MIN_ATTEMPT_MS) {
				await sleep(retryDelayMs);
				continue;
			}
			return fail(why);
		}

		try {
			body = await res.json();
		} catch (err) {
			return fail(`the manager's answer could not be read: ${errorText(err?.message ?? err)}`);
		}
		break;
	}

	const call = toolUseOf(body);
	if (!call) return fail(`the manager returned no ${INSTRUCT_TOOL.name} call (stop_reason ${JSON.stringify(body?.stop_reason ?? null)})`);
	const input = call.input;
	if (!input || typeof input !== "object" || Array.isArray(input)) return fail("the instruct call carried no arguments object");
	if (!INSTRUCTION_VERBS.includes(input.verb)) return fail(`the manager named verb ${JSON.stringify(input.verb)}, which is not in the contract (${INSTRUCTION_VERBS.join(", ")})`);
	const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args : {};

	return {
		...fillInstruction(packet, { verb: input.verb, args, rationale: clip(String(input.rationale ?? ""), MAX_RATIONALE) }),
		// `usage` is kept because §5's row is `{ model, ms, usd }` and nothing charges `usd` today:
		// the token counts are the only thing a later price table can derive it from, and they exist
		// exactly once, here, in a response body this function otherwise drops.
		manager: manager({ usage: body?.usage ?? null }),
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
	// `accept` belongs with the other two: accepting a milestone at one checkpoint and accepting it
	// at another are different decisions, and only one of them can be the one the harness verified.
	if (expected.verb === "restore" || expected.verb === "compare" || expected.verb === "accept") return (expected.checkpoint ?? null) === (got.checkpoint ?? null);
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
export function runsForTask({ taskDir, runsDir, adopt = [], admitCache = null }) {
	const ids = new Set(adopt.filter(Boolean));
	try {
		for (const id of loadTask(taskDir).current?.activeRuns ?? []) ids.add(id);
	} catch { /* a task directory that cannot be read has no runs */ }
	if (fs.existsSync(runsDir)) {
		for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || ids.has(entry.name)) continue;
			const runDir = path.join(runsDir, entry.name);
			const lifecycle = path.join(runDir, "lifecycle.jsonl");
			let stat;
			try {
				stat = fs.statSync(lifecycle);
			} catch {
				continue; // no lifecycle file: nothing here can trigger
			}
			// Memoised across ticks when the loop passes a cache. A POSITIVE verdict is cached
			// forever — a run does not un-name a task. A NEGATIVE one is cached against the
			// lifecycle file's size and mtime, because that is what changes when the run says
			// something new: this repo's runs/ holds hundreds of directories, and re-reading and
			// re-parsing every non-matching one of them every two seconds is the scan this memo
			// exists to stop. A live run writes lifecycle lines continuously, so a run that starts
			// naming this task is re-checked on its very next line.
			const stamp = `${stat.mtimeMs}:${stat.size}`;
			const memo = admitCache?.get(entry.name);
			if (memo?.admitted) {
				ids.add(entry.name);
				continue;
			}
			if (memo && memo.stamp === stamp) continue;
			const admitted = runTriggersName(runDir, taskDir) || runNamesTask(runDir, taskDir);
			admitCache?.set(entry.name, { admitted, stamp });
			if (admitted) ids.add(entry.name);
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

/** Records that this run's trigger `index` has been answered — or, more precisely, that its
 * packet exists and must never be assembled a second time. Re-read and re-written per call: the
 * loop holds no state of its own, so a hand-run `packet`/`execute` in between is not clobbered. */
export function markHandled(taskDir, runId, index) {
	const state = readServeState(taskDir);
	state.handled = { ...(state.handled ?? {}), [runId]: Math.max(Number(state.handled?.[runId] ?? 0), index + 1) };
	writeServeState(taskDir, state);
	return state;
}

/** §1's `status`, or "active" for a task written before the field existed. A task directory that
 * cannot be read is reported as `unreadable`, which is not active either — the loop must not
 * answer triggers for a task whose state it cannot see. */
export function taskStatus(taskDir) {
	try {
		return loadTask(taskDir).status ?? "active";
	} catch {
		return "unreadable";
	}
}

/**
 * The `{ runId, index }` of every trigger this task already has a packet for.
 *
 * `serve.state.json` is this loop's record and nothing else writes it — so a controller who ran
 * `tools/manage.mjs packet` and `execute` by hand left no mark on it, and a loop started
 * afterwards walked from zero and answered the same trigger again: a second packet, a second
 * idempotency key, and the same `compare` launched twice against §3. The packets themselves are
 * the shared record, written by both paths, so they are what the loop reads.
 */
export function answeredTriggers(taskDir, { runsDir = null } = {}) {
	const dir = path.join(taskDir, "packets");
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const f of fs.readdirSync(dir)) {
		if (!/^\d+\.json$/.test(f)) continue;
		try {
			const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))?.trigger;
			if (!t || typeof t.runId !== "string") continue;
			// A packet written before packets carried an index still answered a trigger: the last
			// one of its kind at the time. Recomputed on read with the rule assemblePacket uses, so
			// the record a loop consults is every packet on disk, not only the ones written since.
			const index = Number.isInteger(t.index) ? t.index : (runsDir && t.kind ? triggerIndexOf(path.join(runsDir, t.runId), t.kind) : null);
			if (Number.isInteger(index)) out.push({ runId: t.runId, index, packetId: Number(f.slice(0, -5)) });
		} catch { /* a half-written packet answers nothing */ }
	}
	return out;
}

export const lockFile = (taskDir) => path.join(taskDir, "serve.lock");

/** Is that process still running? `EPERM` means it exists and is not ours, which is still alive;
 * anything else (`ESRCH`, an out-of-range pid) means nothing is there to hold the lock. */
export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * One serve loop per task directory, enforced by an exclusive create.
 *
 * Two loops on one task both read the same `handled` count and both answer the same trigger,
 * which for `restore` and `compare` is §3's "can never launch twice" broken by two processes
 * rather than by one. A lock whose owner is gone is taken over rather than obeyed: the common
 * way to hold a stale lock is Ctrl-C, and a task that refuses to be served until someone deletes
 * a file by hand is worse than the race it prevents.
 *
 * Returns `{ ok, owner? }` — `ok: false` means another live loop holds it.
 */
export function acquireServeLock(taskDir, { pid = process.pid } = {}) {
	const file = lockFile(taskDir);
	const payload = JSON.stringify({ pid, startedAt: Date.now() }, null, 2);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, payload, { flag: "wx" });
			return { ok: true };
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			let owner = null;
			try {
				owner = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch { /* an unreadable lock is a stale lock */ }
			if (owner && pidAlive(owner.pid)) return { ok: false, owner };
			// A stale lock is CLAIMED, not deleted: rename is atomic, so of two loops that both read
			// the same dead owner only one moves the file aside, and the other's rename fails and
			// its retry finds the winner's fresh lock. A blind unlink here let the loser delete the
			// winner's lock a moment after it was written, and both then believed they held it.
			try {
				const claimed = `${file}.stale-${pid}-${attempt}`;
				fs.renameSync(file, claimed);
				try { fs.unlinkSync(claimed); } catch { /* the claim is what mattered */ }
			} catch { /* somebody else claimed it first; the retry will find theirs */ }
		}
	}
	return { ok: false, owner: null };
}

export function releaseServeLock(taskDir, { pid = process.pid } = {}) {
	try {
		const owner = JSON.parse(fs.readFileSync(lockFile(taskDir), "utf8"));
		if (owner?.pid !== pid) return false; // never delete a lock this process does not hold
		fs.unlinkSync(lockFile(taskDir));
		return true;
	} catch {
		return false;
	}
}

/**
 * Answers ONE trigger: assemble the packet, ask the manager, execute the instruction.
 *
 * Never raises on the manager's account — `decide` turns every failure into the default
 * `continue` — and never raises on the executor's either: a refusal is a return value, and the
 * caller logs it. What can still throw is the packet assembly (a run directory that vanished),
 * and the loop catches that around this call.
 *
 * `marked` is called the moment the packet is on disk, BEFORE the manager is asked and before
 * anything executes. That is deliberate and it is the direction that matters: a crash in the
 * window between the executor acting and the pointer moving would otherwise re-answer the
 * trigger on the next start — a fresh packet id (nextPacketId is max + 1, so the exclusive
 * create never fires), a different idempotency key for the same decision, and a `restore` or
 * `compare` launched twice against §3's "can never launch twice". With the packet as the
 * marker, the same crash SKIPS the trigger instead, and the supervisor defaults it after its
 * deadline, which §4 already defines as the correct degradation. A skipped decision is the
 * cheap failure; a batch launched twice is not.
 *
 * A STALE refusal is the one refusal that is answered rather than merely recorded. §3 says a
 * stale instruction is "refused with the new packet", and the state moving under a decision — a
 * worker reporting while the manager thinks — is not the manager's mistake: the same manager
 * asked again about the state as it now is will usually answer the same thing, legally. Once,
 * and inside what is left of the driver's budget, because on the other side of this a paused
 * orchestrator is holding a delivery. Every other refusal repeats by construction (a bad
 * checkpoint syntax stays bad), so it is recorded, said on stderr, and left.
 */
export async function handleTrigger({ taskDir, runsDir, runId, event, index = null, model, fetchImpl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, url, decideImpl = decide, execute = executeInstruction, launchBatch, save, log = () => {}, marked = () => {} }) {
	const kind = event?.data?.kind;
	// Never guessed. A kind decides `verbsAllowed` and what the packet means, so an event without
	// one is a malformed or future event, and inventing `run_ended_without_acceptance` for it would
	// hand the manager a packet about something that did not happen.
	if (typeof kind !== "string" || !kind) throw new Error(`the trigger event carries no kind (${JSON.stringify(event?.data ?? null).slice(0, 200)})`);
	const trigger = { kind, runId, detail: event?.data?.packetRequest?.detail ?? {} };
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	let out = null;
	for (;;) {
		// Before the packet, exactly as `tools/manage.mjs packet` does it: registration is what makes
		// `continue` and `correct` legal for this run, and the packet must carry the version it
		// produced, because that is the version the instruction will name. It saves only on the
		// transition, so the retry below re-reads rather than re-registers.
		const registered = registerRunForTrigger(taskDir, trigger, { runsDir });
		if (registered) log(`${runId}: registered for ${trigger.kind} at stateVersion ${registered.stateVersion}`);
		// The loop knows exactly which event it is answering, so it says so rather than letting the
		// packet infer "the last one of this kind" — two triggers of one kind in a run are ordinary.
		const packet = assemblePacket({ taskDir, runDir: path.join(runsDir, runId), trigger, index });
		const packetFile = writePacket(taskDir, packet);
		marked();
		log(`${runId}: ${trigger.kind} → packet ${packet.packetId} at stateVersion ${packet.task?.stateVersion} (${packetFile})`);

		const left = Math.max(0, deadline - Date.now());
		const decision = await decideImpl({ packet, model, fetchImpl, apiKey, timeoutMs: left, url });
		const { manager, ...instr } = decision;
		log(`packet ${packet.packetId}: ${instr.verb}${instr.defaulted ? " (defaulted)" : ""} in ${manager?.ms ?? "?"} ms${instr.error ? ` — ${instr.error}` : ""}`);

		const result = execute({ taskDir, instr, packet, runsDir, manager, ...(launchBatch ? { launchBatch } : {}), ...(save ? { save } : {}) });
		log(`packet ${packet.packetId}: ${result.executed ? "executed" : result.duplicate ? "already executed" : `refused (${result.code}): ${result.refusal}`}`);
		out = { packet, instr, manager, result, attempts: attempt + 1 };

		const stale = !result.executed && !result.duplicate && result.code === "stale_version";
		const remaining = deadline - Date.now();
		if (!stale || attempt >= 1 || remaining <= 0) {
			if (stale) log(`packet ${packet.packetId}: stale, and not re-asked (${attempt >= 1 ? "one retry already spent" : `${remaining} ms left of the driver's budget`})`);
			return out;
		}
		attempt++;
		log(`packet ${packet.packetId}: the task moved under this decision — re-assembling and asking once more with ${remaining} ms left`);
	}
}

/**
 * Watches every live run of this task for `manage:trigger` events and answers each one exactly
 * once. `--once` handles a single trigger and returns, which is how the loop is tested and how
 * a controller drives one decision by hand.
 *
 * Which triggers have been answered is durable (`serve.state.json`), not in-memory: a loop
 * restarted mid-run must not re-answer the trigger it already answered, and must not skip the
 * one it has not. The pointer moves as soon as the packet is written — see handleTrigger for why
 * that direction is the safe one — and `serve.lock` keeps a second loop from answering alongside
 * this one.
 */
export async function serve({
	taskDir, runsDir, model = DEFAULT_MANAGER_MODEL, fetchImpl = globalThis.fetch, apiKey = null,
	timeoutMs = DEFAULT_TIMEOUT_MS, url = MESSAGES_URL, once = false, adopt = [], pollMs = 2000,
	maxTicks = Infinity, decideImpl = decide, execute = executeInstruction, launchBatch, save,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logFile = null, lock = true,
	supervisorDeadline = SUPERVISOR_DEADLINE_MS,
}) {
	const file = logFile ?? path.join(taskDir, "serve.log");
	const log = (line) => {
		const text = `[${new Date().toISOString()}] ${line}\n`;
		try { fs.appendFileSync(file, text); } catch { /* the loop must outlive its own log */ }
		console.error(`[serve] ${line}`);
	};

	const held = lock ? acquireServeLock(taskDir) : { ok: true };
	if (!held.ok) {
		log(`another serve loop holds ${lockFile(taskDir)} (pid ${held.owner?.pid ?? "unknown"}, since ${held.owner?.startedAt ? new Date(held.owner.startedAt).toISOString() : "unknown"}); this one answers nothing`);
		return { handled: [], file, refused: "locked", owner: held.owner ?? null };
	}
	log(`watching ${runsDir} for ${taskDir} (model ${model}, budget ${timeoutMs} ms of the supervisor's ${supervisorDeadline} ms${once ? ", once" : ""})`);

	const handled = [];
	const admitCache = new Map();
	try {
		for (let tick = 0; tick < maxTicks; tick++) {
			const state = readServeState(taskDir);
			// The other half of §3's "nothing else moves". The executor refuses every verb but
			// `escalate` on a task that is not active, so answering a trigger here would spend a
			// manager call to produce a refusal row — and a paused task is one a human has been asked
			// to look at. Said once per tick, not once per trigger: a paused task keeps triggering.
			const status = taskStatus(taskDir);
			if (status !== "active") {
				log(`the task is ${status}, not active — no trigger is answered until a human resumes it`);
				if (once) return { handled, file, refused: `task_${status}` };
				if (tick + 1 < maxTicks) await sleep(pollMs);
				continue;
			}
			const already = answeredTriggers(taskDir, { runsDir });
			for (const runId of runsForTask({ taskDir, runsDir, adopt, admitCache })) {
				const events = triggerEvents(path.join(runsDir, runId));
				const done = Number(state.handled?.[runId] ?? 0);
				for (let i = done; i < events.length; i++) {
					// A packet on disk for this run and this trigger index is the answer, whoever wrote
					// it: the loop last time, or a controller driving `packet` and `execute` by hand.
					const prior = already.find((p) => p.runId === runId && p.index === i);
					if (prior) {
						log(`${runId}: trigger ${i} already has packet ${prior.packetId} — not answered again`);
						markHandled(taskDir, runId, i);
						continue;
					}
					let answered = false;
					try {
						const out = await handleTrigger({
							taskDir, runsDir, runId, event: events[i], index: i, model, fetchImpl, apiKey, timeoutMs, url,
							decideImpl, execute, launchBatch, save, log,
							marked: () => markHandled(taskDir, runId, i),
						});
						handled.push(out);
						answered = true;
					} catch (err) {
						// A loop that dies on one bad run stops answering every other run's triggers, and
						// the supervisor on the other side waits out its deadline for each of them. Not
						// retried — a run directory that cannot be assembled will not assemble on the next
						// tick either — but what the skip COSTS is said out loud, because for a pausing
						// trigger it is a blocked orchestrator, not a missing row.
						log(`${runId}: trigger ${i} could not be answered: ${errorText(err?.stack ?? err)}`);
						log(`${runId}: trigger ${i} skipped after a thrown handler; the run defaults after the supervisor's deadline (${supervisorDeadline} ms)`);
					}
					// The durable write for the answered path already happened inside handleTrigger, the
					// moment the packet existed. This is the other path: a trigger that never got that
					// far is marked here so the loop does not retry it every tick. Nothing else is
					// needed — the next tick re-reads the state file rather than trusting this loop's
					// copy of it.
					if (!answered) markHandled(taskDir, runId, i);
					if (once) return { handled, file };
				}
			}
			if (tick + 1 < maxTicks) await sleep(pollMs);
		}
	} finally {
		if (lock) releaseServeLock(taskDir);
	}
	return { handled, file };
}
