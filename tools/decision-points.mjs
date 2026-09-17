#!/usr/bin/env node
// DecisionPoint extraction: every orchestrator inference in a recorded run, with the
// action it chose, the actions the harness would have accepted at that moment, what the
// generative path spent deciding, and the causal consequences (lib/causal-links.mjs).
//
//   node tools/decision-points.mjs [runId ...]      (default: every run with an orchestrator)
//
// Writes runs/<id>/decisions.jsonl and prints one line per run. The replay step
// (shadow decision head) fills in the policy distribution later; this file is the
// state reference and the ground truth it is scored against.
//
// Action classes and their one-token symbols for the constrained head:
//   A spawn   B resume   C collect   D probe   E done   F inspect   G memory   H checkpoint   I answer
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun, readSessionFile } from "../lib/context-trace.mjs";
import { causalLinks, readAudit } from "../lib/causal-links.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

export const ACTION_CLASSES = ["spawn", "resume", "collect", "probe", "done", "inspect", "memory", "checkpoint", "answer"];
export const SYMBOLS = Object.fromEntries(ACTION_CLASSES.map((c, i) => [c, String.fromCharCode(65 + i)]));
// Two horizons for the same point. The literal label is the next tool call. The
// substantive label skips information-gathering steps (inspect, memory, checkpoint,
// a text answer) to the first control action that changes the run's state: a spawn,
// resume, collect, probe or done. A head that says "spawn" where the orchestrator
// read two files first may be right about the trajectory and wrong about the horizon.
export const SUBSTANTIVE = new Set(["spawn", "resume", "collect", "probe", "done"]);
// The binary epistemic decision: "do I know enough to commit?" Committing actions
// change what the run will do next; everything else, including a probe (asking the
// supervisor for evidence), is uncertainty reduction. P(gather) = Σ over the gather
// set of the same nine-way distribution — no second classifier.
export const ACT = new Set(["spawn", "resume", "collect", "done"]);
export const modeOf = (cls) => (ACT.has(cls) ? "act" : "gather");

/** For each point, the next substantive action at or after it, and how many gather steps precede it. */
export function substantiveHorizon(classes) {
	const out = new Array(classes.length);
	let next = null, at = -1;
	for (let i = classes.length - 1; i >= 0; i--) {
		if (SUBSTANTIVE.has(classes[i])) { next = classes[i]; at = i; }
		out[i] = next ? { cls: next, symbol: SYMBOLS[next], gatherSteps: at - i } : { cls: null, symbol: null, gatherSteps: null };
	}
	return out;
}

/** Classify an assistant turn's first tool call (or its absence) into an action class + parameters. */
export function classifyTurn(content) {
	const first = (content ?? []).find((c) => c.type === "toolCall");
	if (!first) return { cls: "answer", tool: null, params: {} };
	const a = first.arguments ?? {};
	switch (first.name) {
		case "subagent":
			if (a.resume) return { cls: "resume", tool: first.name, params: { resume: String(a.resume).slice(0, 24), description: a.description ?? null } };
			return { cls: "spawn", tool: first.name, params: { subagent_type: a.subagent_type ?? null, description: a.description ?? null, background: a.run_in_background === true, promptChars: String(a.prompt ?? "").length } };
		case "get_subagent_result": return { cls: "collect", tool: first.name, params: { id: String(a.id ?? a.subagent_id ?? "").slice(0, 24) } };
		case "send_mail": {
			const kind = a.kind ?? "";
			if (kind === "probe") return { cls: "probe", tool: first.name, params: { kind, cases: countProbeCases(a.body) } };
			if (kind === "done") return { cls: "done", tool: first.name, params: { kind, bodyChars: String(a.body ?? "").length } };
			return { cls: "memory", tool: first.name, params: { kind, bodyChars: String(a.body ?? "").length } };
		}
		case "read": case "ls": case "grep": case "find": case "bash":
			return { cls: "inspect", tool: first.name, params: { path: a.path ?? null, pattern: a.pattern ?? null, command: a.command ? String(a.command).slice(0, 80) : null } };
		case "memory_search": return { cls: "memory", tool: first.name, params: { query: String(a.query ?? "").slice(0, 80) } };
		case "memory_get": return { cls: "memory", tool: first.name, params: { ids: Array.isArray(a.ids) ? a.ids.slice(0, 5) : [] } };
		case "checkpoint": case "context_usage": return { cls: "checkpoint", tool: first.name, params: {} };
		default: return { cls: "inspect", tool: first.name, params: {} };
	}
}

function countProbeCases(body) {
	try { const v = JSON.parse(String(body ?? "")); return Array.isArray(v) ? v.length : null; } catch { return null; }
}

/**
 * Which action classes the harness would accept at this point, from the run's history so
 * far. This is the conditioning set for P(a | s, a ∈ valid): a confident choice among two
 * legal actions means something different from one among nine.
 */
export function validMask(state, cfg) {
	return {
		spawn: true,
		resume: state.spawned > 0,
		collect: state.backgroundOutstanding > 0,
		probe: state.completed > 0,
		done: state.probes > 0,
		inspect: true,
		memory: cfg.memoryTools,
		checkpoint: true,
		answer: true,
	};
}

function orchestratorTurns(sessionFile) {
	const turns = [];
	for (const e of readSessionFile(sessionFile)) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "assistant" && m.usage) turns.push({ content: m.content ?? [], usage: m.usage, stopReason: m.stopReason ?? null, ts: m.timestamp ?? null });
	}
	return turns;
}

export function extractRun(runDir) {
	const summaryFile = path.join(runDir, "summary.json");
	if (!fs.existsSync(summaryFile)) return null;
	const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
	if (summary.config?.pattern !== "orchestrator") return null;
	const trace = traceRun(runDir);
	const oi = trace.agents.findIndex((a) => a.role !== "worker");
	if (oi < 0) return null;
	const orch = trace.agents[oi];
	const turns = orchestratorTurns(path.join(runDir, "sessions", orch.file));
	if (turns.length !== orch.calls.length) throw new Error(`${path.basename(runDir)}: ${turns.length} assistant turns vs ${orch.calls.length} traced calls`);
	const actions = turns.map((t) => classifyTurn(t.content));
	const audit = readAudit(path.join(runDir, "audit.jsonl"), fs);
	const links = causalLinks(trace, { audit, mailKind: (ai, ci) => (ai === oi ? (turns[ci].content.find((c) => c.type === "toolCall" && c.name === "send_mail")?.arguments?.kind ?? null) : null) });
	const reports = readReports(path.join(runDir, "reports.jsonl"));
	const oracleFirst = (audit.find((e) => e.type === "oracle")?.msg ?? "").replace(/^Oracle run #\d+: /, "") || null;
	const cfg = { use: summary.config?.workers?.use ?? ["worker"], memoryTools: summary.config?.memory?.mode === "search", topology: summary.config?.guards?.topology?.mode ?? null };

	const state = { spawned: 0, completed: 0, backgroundOutstanding: 0, probes: 0, doneAttempts: 0 };
	const horizon = substantiveHorizon(actions.map((a) => a.cls));
	const out = [];
	orch.calls.forEach((c, i) => {
		const action = actions[i];
		const valid = validMask(state, cfg);
		const children = links[oi][i];
		const outcome = outcomeFor(action, children, trace, reports, turns[i]);
		out.push({
			run: path.basename(runDir), task: summary.task, cfg,
			i, t: Math.round((c.startMs - trace.t0) / 10) / 100, ctx: c.context, cached: c.cached, fresh: c.fresh,
			decoded: c.output, inferenceMs: Math.round(c.inferenceMs), stop: c.stopReason ?? null,
			action: { cls: action.cls, symbol: SYMBOLS[action.cls], tool: action.tool, params: action.params, mode: modeOf(action.cls) },
			substantive: horizon[i],
			valid, nValid: Object.values(valid).filter(Boolean).length,
			state: { ...state },
			children: children.map((l) => ({ agent: trace.agents[l.a].id, i: l.i, k: l.k, d: String(l.d ?? "").slice(0, 80) })),
			outcome: { ...outcome, runOk: String(summary.reason).startsWith("SUCCESS"), oracleFirst },
		});
		// advance the harness state past this action
		if (action.cls === "spawn") { state.spawned++; if (action.params.background) state.backgroundOutstanding++; }
		if (action.cls === "collect") state.backgroundOutstanding = Math.max(0, state.backgroundOutstanding - 1);
		if (action.cls === "probe") state.probes++;
		if (action.cls === "done") state.doneAttempts++;
		// a `received` link on call i+1 means the worker's result is in that call's input,
		// so the decision at i+1 is already made with the worker completed
		if (links[oi][i + 1]?.some((l) => l.k === "received")) state.completed++;
	});
	return { summary, points: out };
}

function readReports(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** What happened as a consequence of this action, from the links and the run's records. */
function outcomeFor(action, children, trace, reports, turn) {
	const o = {};
	const into = children.find((l) => l.k === "spawned" || l.k === "resumed");
	if (into) {
		const w = trace.agents[into.a];
		const rep = reports.filter((r) => String(r.role).endsWith(w.sessionId)).at(-1);
		o.worker = w.id;
		o.workerCalls = w.calls.length;
		o.workerStatus = rep?.status ?? (w.spawn?.completedMs ? "completed" : null);
		o.workerSummary = rep?.summary ? String(rep.summary).replace(/\s+/g, " ").slice(0, 160) : null;
	}
	const reply = children.find((l) => l.k === "replied");
	if (reply) o.reply = reply.d;
	const retry = children.find((l) => l.k === "retry");
	if (retry) o.denied = retry.d;
	if (turn.stopReason && !action.tool) o.answered = turn.stopReason;
	return o;
}

function main() {
	const ids = process.argv.slice(2);
	const runsDir = path.join(ROOT, "runs");
	const list = ids.length ? ids : fs.readdirSync(runsDir).filter((d) => /^\d{4}-/.test(d)).sort();
	const tally = {};
	for (const id of list) {
		const dir = path.join(runsDir, id);
		let res;
		try { res = extractRun(dir); } catch (err) { console.error(`${id}: ${err.message}`); continue; }
		if (!res) continue;
		fs.writeFileSync(path.join(dir, "decisions.jsonl"), res.points.map((p) => JSON.stringify(p)).join("\n") + "\n");
		const byCls = {};
		for (const p of res.points) { byCls[p.action.cls] = (byCls[p.action.cls] ?? 0) + 1; tally[p.action.cls] = (tally[p.action.cls] ?? 0) + 1; }
		const decoded = res.points.reduce((s, p) => s + p.decoded, 0);
		console.log(`${id}  ${String(res.summary.task).padEnd(14)} ${String(res.points.length).padStart(3)} points  decoded ${String(decoded).padStart(6)}  ${Object.entries(byCls).map(([k, v]) => `${k}:${v}`).join(" ")}`);
	}
	console.log(`total by class: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
