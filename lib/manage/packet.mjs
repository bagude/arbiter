// packet — the observation packet handed to a manager at a trigger (spec §2). Assembled over
// existing run records only: summary.json, audit.jsonl, decisions*.jsonl, workers.jsonl and the
// orchestrator's own session transcript. Bounded to maxChars; free text (worker summaries, the
// causal chain, the transcript tail) is redacted before it leaves the box, same as jev's egress.
import fs from "node:fs";
import path from "node:path";
import { loadTask, budgetLeft } from "./task-state.mjs";
import { readLedger, readFindings } from "./ledger.mjs";
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

function countPackets(taskDir) {
	const dir = path.join(taskDir, "packets");
	if (!fs.existsSync(dir)) return 0;
	return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

/** Prunes options.verbsAllowed the way the harness does when the caller leaves it to be worked out. */
function defaultVerbs(task, trigger) {
	const bl = budgetLeft(task);
	let verbs = [...ALL_VERBS];
	if (bl.forkReplicates === 0 && bl.runs === 0) verbs = verbs.filter((v) => v !== "compare" && v !== "restore");
	if (trigger.kind !== "milestone_candidate" && trigger.kind !== "comparison_ready") verbs = verbs.filter((v) => v !== "accept");
	return verbs;
}

export function assemblePacket({ taskDir, runDir, trigger, verbsAllowed, maxChars = 120000 }) {
	const task = loadTask(taskDir);
	const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
	const auditLines = readJsonl(path.join(runDir, "audit.jsonl"));
	const workerRows = readJsonl(path.join(runDir, "workers.jsonl"));

	const ledgerTail = readLedger(taskDir)
		.slice(-5)
		.map((r) => ({ packetId: r.packetId, verb: r.instruction?.verb ?? null, outcome: r.outcome ?? null }));
	const settledFindings = readFindings(taskDir).filter((f) => f.status === "verified" || f.status === "candidate");

	const packet = {
		packetId: countPackets(taskDir) + 1,
		trigger,
		task,
		run: {
			id: summary.runId ?? path.basename(runDir),
			config: summary.config ?? summary.task ?? null,
			milestone: task.current.milestone,
			status: summary.reason ? "finished" : "running",
			reason: summary.reason ?? null,
			wallSec: summary.wallSec ?? 0,
			decodedTokens: summary.tokens ?? 0,
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
		options: { verbsAllowed: verbsAllowed ? [...verbsAllowed] : defaultVerbs(task, trigger), budgetLeft: budgetLeft(task) },
		bounded: null,
	};

	const dropped = [];
	let rendered = JSON.stringify(packet);
	if (rendered.length > maxChars && packet.run.tail) {
		packet.run.tail = "";
		dropped.push("tail");
		rendered = JSON.stringify(packet);
	}
	if (rendered.length > maxChars && packet.run.chain.length) {
		packet.run.chain = [];
		dropped.push("chain");
		rendered = JSON.stringify(packet);
	}
	if (rendered.length > maxChars && packet.run.workers.some((w) => (w.summary ?? "").length > 100)) {
		packet.run.workers = packet.run.workers.map((w) => (w.summary ? { ...w, summary: w.summary.slice(0, 100) } : w));
		dropped.push("workers truncated to 100 chars");
		rendered = JSON.stringify(packet);
	}
	packet.bounded = dropped.length ? dropped : null;
	return packet;
}

export function writePacket(taskDir, packet) {
	const dir = path.join(taskDir, "packets");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${packet.packetId}.json`);
	fs.writeFileSync(file, JSON.stringify(packet, null, 2));
	return file;
}
