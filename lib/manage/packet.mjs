// packet — the observation packet handed to a manager at a trigger (spec §2). Assembled over
// existing run records only: summary.json, audit.jsonl, decisions*.jsonl, workers.jsonl and the
// orchestrator's own session transcript. Bounded to maxChars; free text (worker summaries, the
// causal chain, the transcript tail) is redacted at the point it's extracted, same as jev's
// egress, AND the whole rendered packet gets one more redact() pass right before it leaves this
// function — belt and suspenders, so no future field (a finding's claim, a trigger's detail) is
// a silent gap the way settledFindings once was.
import fs from "node:fs";
import path from "node:path";
import { loadTask, budgetLeft } from "./task-state.mjs";
import { readLedger, readFindings, reversedSeqs } from "./ledger.mjs";
import { pendingBatches, pendingRuns } from "./instructions.mjs";
import { redact } from "../jev.mjs";

export const ALL_VERBS = ["continue", "correct", "restore", "compare", "accept", "escalate"];
const CHAIN_KINDS = new Set(["mail", "oracle", "guard", "finish", "jev"]);
const ORACLE_RE = /Oracle run #(\d+): (\d+)\/(\d+)/;

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function readOracle(auditLines) {
	const out = [];
	for (const l of auditLines) {
		const m = ORACLE_RE.exec(String(l.msg ?? ""));
		if (m) out.push({ attempt: Number(m[1]), pass: Number(m[2]), total: Number(m[3]) });
	}
	return out;
}

/** workers.jsonl (started/completed) merged with any `report {…}` tool lines in audit.jsonl. */
function readWorkers(auditLines, workerRows) {
	const byWid = new Map();
	for (const r of workerRows) {
		const w = byWid.get(r.wid) ?? { wid: r.wid, type: null, status: null, reported: false, summary: null };
		if (r.ev === "started") w.type = r.type ?? w.type;
		if (r.ev === "completed" || r.ev === "resumed") w.status = r.status ?? r.outcome ?? w.status;
		byWid.set(r.wid, w);
	}
	for (const l of auditLines) {
		if (l.type !== "tool" || typeof l.msg !== "string" || !l.msg.startsWith("report ")) continue;
		const wid = l.agent ?? "?";
		const w = byWid.get(wid) ?? { wid, type: null, status: null, reported: false, summary: null };
		w.reported = true;
		let summary = l.msg.slice("report ".length);
		try {
			const parsed = JSON.parse(summary);
			summary = parsed.summary ?? summary;
		} catch {
			// the audit line itself may already be cut mid-string; keep the raw remainder
		}
		w.summary = redact(String(summary)).slice(0, 300);
		byWid.set(wid, w);
	}
	return [...byWid.values()];
}

/** The last 40 audit lines of the causal-chain kinds, rendered `t · type · msg≤120`, redacted. */
function readChain(auditLines) {
	return auditLines
		.filter((l) => CHAIN_KINDS.has(l.type))
		.slice(-40)
		.map((l) => redact(`${l.t} · ${l.type} · ${String(l.msg ?? "").slice(0, 120)}`));
}

function readDecisions(runDir) {
	const rows = readJsonl(path.join(runDir, "decisions.jsonl"));
	const substantive = {};
	for (const r of rows) {
		const cls = r.substantive?.cls;
		if (cls) substantive[cls] = (substantive[cls] ?? 0) + 1;
	}
	return { points: rows.length, substantive };
}

/** The local 27B decision head's agreement with the recorded substantive class, from the replay file. */
function readLocal27bHead(runDir) {
	const rows = readJsonl(path.join(runDir, "decisions-replay-substantive.jsonl")).filter((r) => r.head);
	const agreeing = rows.filter((r) => r.head.agreeSubstantive).length;
	const confidentDisagreements = rows
		.filter((r) => (r.head.confidence ?? 0) >= 0.9 && !r.head.agreeSubstantive)
		.map((r) => ({ call: r.i + 1, recorded: r.substantive?.cls ?? null, head: r.head.pickClass ?? null, p: r.head.confidence ?? null }));
	return { agreement: rows.length ? agreeing / rows.length : null, confidentDisagreements };
}

/** Jev's agreement (from decisions-jev.jsonl, if the run had it enabled) and the done-check verdict. */
function readJevHead(runDir) {
	const rows = readJsonl(path.join(runDir, "decisions-jev.jsonl")).filter((r) => r.score?.substantive || r.score?.literal);
	const agreeing = rows.filter((r) => (r.score.substantive ?? r.score.literal).agree).length;
	const doneRows = readJsonl(path.join(runDir, "decisions-jev-done.jsonl"));
	const lastDone = doneRows.length ? doneRows[doneRows.length - 1] : null;
	const doneCheck = lastDone ? { call: lastDone.i != null ? lastDone.i + 1 : null, pPass: lastDone.pPasses ?? null, verdict: lastDone.verdict ?? null } : null;
	return { agreement: rows.length ? agreeing / rows.length : null, doneCheck };
}

/** The last ~2 000 chars of the orchestrator's own transcript (assistant text only), redacted. */
function readTail(runDir) {
	const dir = path.join(runDir, "sessions", "orchestrator");
	if (!fs.existsSync(dir)) return "";
	const files = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => path.join(dir, e.name));
	if (!files.length) return "";
	files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	const rows = readJsonl(files[0]);
	const text = rows
		.filter((r) => r.type === "message" && r.message?.role === "assistant")
		.flatMap((r) => (Array.isArray(r.message.content) ? r.message.content : []))
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n\n");
	if (!text) return "";
	return redact(text).slice(-2000);
}

/** Next packet id = max numeric `<n>.json` id in packets/ + 1, ignoring gaps and any non-numeric
 * file dropped in there — counting files (as opposed to the max id) reuses an id that's already
 * on disk the moment there's a gap, and writePacket's exclusive create then refuses to overwrite. */
function nextPacketId(taskDir) {
	const dir = path.join(taskDir, "packets");
	if (!fs.existsSync(dir)) return 1;
	const ids = fs
		.readdirSync(dir)
		.map((f) => /^(\d+)\.json$/.exec(f))
		.filter(Boolean)
		.map((m) => Number(m[1]));
	return (ids.length ? Math.max(...ids) : 0) + 1;
}

/**
 * Prunes options.verbsAllowed the way the harness does when the caller leaves it to be worked out.
 *
 * The pending-work rung matters most at exactly the trigger where changing approach matters most.
 * `liveWorkRefusal` refuses `restore` and `compare` whenever a run or a batch is still in flight,
 * and every PAUSING trigger fires mid-run by definition — so a packet that advertised both verbs
 * at `oracle_failed_repeatedly` invited the one answer a stuck run deserves and then refused it,
 * and (before I4) nothing re-asked: the orchestrator waited out the whole deadline for a
 * defaulted continue. The bypass is real and deliberate, so it is named in the prompt rather than
 * left as a flag the manager is never told about: `parallel: true` opts in, at the cost of two
 * batches contending for one model-server slot.
 */
function defaultVerbs(task, trigger, { taskDir = null, runsDir = null } = {}) {
	const bl = budgetLeft(task);
	let verbs = [...ALL_VERBS];
	if (bl.forkReplicates === 0 && bl.runs === 0) verbs = verbs.filter((v) => v !== "compare" && v !== "restore");
	if (trigger.kind !== "milestone_candidate" && trigger.kind !== "comparison_ready") verbs = verbs.filter((v) => v !== "accept");
	const busy = pendingRuns(task, { runsDir }).length > 0 || pendingBatches(task, taskDir).length > 0;
	if (busy) verbs = verbs.filter((v) => v !== "restore" && v !== "compare");
	return verbs;
}

/**
 * A live run has no summary.json — the supervisor writes it in finish(), on the way out. Every
 * PAUSING trigger fires mid-run by definition (the orchestrator is blocked on a delivery), so
 * reading summary.json as a precondition made a packet impossible at exactly the moments the
 * manager exists for: the first live check threw ENOENT here and took the run down with it.
 *
 * So the summary is optional, and what it would have carried is recovered from the records the
 * run writes as it goes. audit.jsonl is the authority while a run is alive: its last line's `t`
 * is the elapsed seconds, and the rows are typed (tool, mail, oracle, guard).
 *
 * What cannot be recovered is named rather than defaulted. Token totals live in agent state the
 * supervisor holds in memory and reach disk only in finish(): as `0` they read as a real
 * measurement — a run that has decoded nothing — which is a different claim from "nobody knows
 * yet", and the manager is being asked to judge cost. They come back `null`, listed in
 * `run.partial`, and `status: "running"` says which kind of packet this is.
 */
function liveSummary(runDir, auditLines) {
	const last = auditLines[auditLines.length - 1];
	const elapsed = Number(last?.t ?? 0);
	// doneAttempts is the count of oracle-N directories the run has made so far; the oracle
	// verdict lines in the audit say the same thing, and either is right when they agree.
	const oracleDirs = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => /^oracle-\d+$/.test(f)).length : 0;
	const config = liveConfig(runDir, auditLines);
	return {
		runId: path.basename(runDir),
		config,
		reason: null, // the one field that says "this run has not ended"
		wallSec: Number.isFinite(elapsed) ? elapsed : 0,
		tokens: null,
		mail: auditLines.filter((l) => l.type === "mail").length,
		guards: {},
		doneAttempts: oracleDirs,
		live: true,
		partial: config ? ["tokens"] : ["tokens", "config"],
	};
}

/**
 * The config a live run was started with, or null.
 *
 * Only `summary.json` records `config.configPath` today, and that is written in finish(). The
 * supervisor logs the config nowhere else, so this looks for a copy the run may carry beside its
 * other records; absent that, the field is null and `run.partial` says so rather than letting
 * the packet imply the run had no config. It matters because `restore` and `compare` name a
 * config to spawn with, and the packet's `run.config` is where the manager gets it.
 */
function liveConfig(runDir, auditLines) {
	for (const name of ["config.json", "arbiter.json"]) {
		if (fs.existsSync(path.join(runDir, name))) return path.join(runDir, name);
	}
	const line = auditLines.find((l) => l.type === "config" && typeof l.msg === "string");
	return line?.msg ?? null;
}

/**
 * Which of this run's `manage:trigger` events this packet answers, or null.
 *
 * The index is what makes "has this trigger already been answered?" a question anyone can ask
 * from the task directory alone. Without it the only record was `serve.state.json`, which a
 * hand-run `tools/manage.mjs packet` never wrote — so the loop, started afterwards, walked from
 * zero, assembled a SECOND packet for a trigger already answered, got a different id and
 * therefore a different idempotency key, sailed past the duplicate check and launched the same
 * `compare` twice. With no explicit index the answer is the last event of that kind, which is
 * what a hand-run packet is about: the thing that just happened.
 */
export function triggerIndexOf(runDir, kind, index = null) {
	if (Number.isInteger(index)) return index;
	const events = readJsonl(path.join(runDir, "lifecycle.jsonl")).filter((e) => e.ev === "manage:trigger");
	for (let i = events.length - 1; i >= 0; i--) if (events[i]?.data?.kind === kind) return i;
	return null;
}

export function assemblePacket({ taskDir, runDir, trigger, verbsAllowed, maxChars = 120000, index = null }) {
	const task = loadTask(taskDir);
	const auditLines = readJsonl(path.join(runDir, "audit.jsonl"));
	const summaryFile = path.join(runDir, "summary.json");
	const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : liveSummary(runDir, auditLines);
	const workerRows = readJsonl(path.join(runDir, "workers.jsonl"));

	// Retracted rows are subtracted before the tail is taken, not after: a row a `reversed` row
	// names is an instruction that did NOT run (see reversedSeqs), and showing the manager its
	// own un-executed instruction as recent history invites it to reason from an act that never
	// happened — while pushing a real one out of the five.
	const allRows = readLedger(taskDir);
	const retracted = reversedSeqs(allRows);
	const ledgerTail = allRows
		.filter((r) => !retracted.has(r.seq))
		.slice(-5)
		.map((r) => ({ packetId: r.packetId, verb: r.instruction?.verb ?? null, outcome: r.outcome ?? null }));
	const settledFindings = readFindings(taskDir).filter((f) => f.status === "verified" || f.status === "candidate");

	const packet = {
		packetId: nextPacketId(taskDir),
		// The trigger as the caller gave it, plus which of the run's trigger events it answers —
		// the durable "this one is answered" marker, readable by anyone with the task directory.
		trigger: { ...trigger, index: triggerIndexOf(runDir, trigger?.kind, index) },
		task,
		run: {
			id: summary.runId ?? path.basename(runDir),
			config: summary.config?.configPath ?? summary.config ?? summary.task ?? null,
			milestone: task.current.milestone,
			status: summary.reason ? "finished" : "running",
			reason: summary.reason ?? null,
			wallSec: summary.wallSec ?? 0,
			// summary.tokens is the run TOTAL across every agent (orchestrator + workers), not
			// decode-only output tokens — named `tokens` here rather than `decodedTokens` so it
			// doesn't read as a narrower figure than it is. On a live run it is null, not 0:
			// see liveSummary, and `partial` below names every such field.
			tokens: summary.live ? null : summary.tokens ?? 0,
			// What this packet could not measure, if anything. Absent on a finished run.
			partial: summary.partial ?? null,
			toolCalls: auditLines.filter((l) => l.type === "tool").length,
			mails: summary.mail ?? auditLines.filter((l) => l.type === "mail").length,
			oracle: readOracle(auditLines),
			workers: readWorkers(auditLines, workerRows),
			guards: summary.guards ?? {},
			doneAttempts: summary.doneAttempts ?? 0,
			decisions: readDecisions(runDir),
			heads: { local27b: readLocal27bHead(runDir), jev: readJevHead(runDir) },
			chain: readChain(auditLines),
			tail: readTail(runDir),
		},
		history: { recentInstructions: ledgerTail, settledFindings },
		// `pendingBatches` and `pendingRuns` sit beside budgetLeft because they are the same kind of
		// thing: what the harness worked out, as opposed to what the record says. `task` above is verbatim (§2,
		// and §7's replay fidelity depends on it), and its `current.activeBranches` still lists a
		// batch whose child has finished — the executor is task.json's only writer, so an entry
		// leaves only when a later instruction saves. Every refusal inside the executor already
		// goes through this same derivation, so without it the manager's view of "is work already
		// running?" disagrees with the harness's, on exactly the question restore and compare
		// turn on. `pendingRuns` is the same story for `current.activeRuns`, whose entries outlive
		// the runs themselves when a supervisor is killed; its runs root is this run's own parent
		// directory, which is what `runs/<id>` means.
		options: { verbsAllowed: verbsAllowed ? [...verbsAllowed] : defaultVerbs(task, trigger, { taskDir, runsDir: path.dirname(runDir) }), budgetLeft: budgetLeft(task), pendingBatches: pendingBatches(task, taskDir), pendingRuns: pendingRuns(task, { runsDir: path.dirname(runDir) }) },
		bounded: null,
	};

	// `bounded` itself adds to the rendered size, so every check below renders WITH the
	// dropped list as it would read if we stopped right there — otherwise a packet that
	// just fits after a drop can be pushed back over maxChars by recording that drop.
	let dropped = [];
	const sizeWith = (list) => {
		packet.bounded = list.length ? list : null;
		return JSON.stringify(packet).length;
	};
	if (sizeWith(dropped) > maxChars && packet.run.tail) {
		packet.run.tail = "";
		dropped = [...dropped, "tail"];
	}
	if (sizeWith(dropped) > maxChars && packet.run.chain.length) {
		packet.run.chain = [];
		dropped = [...dropped, "chain"];
	}
	if (sizeWith(dropped) > maxChars && packet.run.workers.some((w) => (w.summary ?? "").length > 100)) {
		packet.run.workers = packet.run.workers.map((w) => (w.summary ? { ...w, summary: w.summary.slice(0, 100) } : w));
		dropped = [...dropped, "workers truncated to 100 chars"];
	}
	sizeWith(dropped); // final assignment: packet.bounded matches exactly what was decided above

	// Defense in depth: the targeted redact() calls above (tail, chain, worker summaries) cover
	// the free text this assembler itself extracts from run records; this final blanket pass
	// over the whole rendered packet catches anything else — settledFindings' claim/evidence
	// text, trigger.detail, summary.reason, and any future field a later task adds — without a
	// field-by-field audit each time. Applied AFTER bounding so the .slice() lengths above still
	// mean what they say; redact() only ever shortens or leaves text unchanged, never grows it,
	// so this cannot push an already-bounded packet back over maxChars.
	return JSON.parse(redact(JSON.stringify(packet)));
}

export function writePacket(taskDir, packet) {
	const dir = path.join(taskDir, "packets");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${packet.packetId}.json`);
	// Exclusive create: numbering can never overwrite a packet already on disk, even if a
	// caller somehow reuses an id (every packet is recorded verbatim — see spec §7).
	fs.writeFileSync(file, JSON.stringify(packet, null, 2), { flag: "wx" });
	return file;
}
