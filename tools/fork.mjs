#!/usr/bin/env node
// Fork runner: drives supervisor.mjs's fork mode (env ARBITER_FORK[/ARBITER_FORK_FORCE],
// lib/fork.mjs, ext/guards/fork-force.ts) to restore a recorded decision point and either
// let the orchestrator continue on its own (branch G) or force its first tool call to a
// class (A-natural) or a recorded class+tool+args (A-oracle). Spec:
// docs/superpowers/specs/2026-09-17-fork-runner-design.md.
//
//   node tools/fork.mjs <runId> <call> --config <config.json> --branch G|A-natural|A-oracle
//                        [--action <cls>] [--replicates N] [--null] [--control <file>]
//
// --control names a control file (the management channel's runs/<id>/control.jsonl shape) that
// every replicate starts with: the runner passes the path as ARBITER_FORK_CONTROL and the
// supervisor's fork path copies it into the new run before resuming the orchestrator. That is
// how a manager's `restore` delivers a message to a restored run.
//
// <call> is the 1-based inference number in runs/<runId>/decisions.jsonl (point i = call-1)
// that the fork restores. --null runs branch G and reports the null-gate read-out: how often
// the restored run reproduces the recorded transition with no intervention at all — the
// gate the twelve real forks in the design doc are conditioned on passing first.
//
// For A-oracle, --action may be omitted: the runner takes the recorded class and tool from
// runs/<runId>/decisions.jsonl (point call-1) and the recorded arguments from the session
// file's call-th assistant entry's first tool call.
//
// Each replicate is a child `node supervisor.mjs --config <cfg>` with ARBITER_FORK (+
// ARBITER_FORK_FORCE for A branches) set, run to exit, its new run id found the way
// tools/batch.mjs finds one (diff runs/ before/after). Then: `node tools/decision-points.mjs
// <newId>`, a payload comparison of the fork's first captured request against the source's,
// and a row built from the new run's decisions/summary/audit. Replicates run sequentially —
// one model server slot. A-oracle's recorded arguments go to
// runs/.batch-fork-<runId>-<call>/force-<branch>-<replicate>.json rather than inline in
// ARBITER_FORK_FORCE, which just points at it ("@<path>") — a recorded probe body can be
// arbitrary JSON, and Windows caps a process's whole environment block at ~32 KB.
//
// A crashed replicate (no summary.json, or a summary whose `reason` begins "FORK:" — the
// supervisor refusing the fork itself, which still exits 0) is still reported, but excluded
// from the null-gate reproduction counts: its numbers describe a run that never finished, and
// a harness refusal is not the model failing to reproduce itself. The supervisor's own exit
// code is reported and is NOT the crash signal — it is wrong in both directions (see forkRow).
//
// Report: docs/batch/fork-<runId>-<call>.md.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { payloadEquals } from "../lib/fork.mjs";
import { traceRun, readSessionFile } from "../lib/context-trace.mjs";
import { ACTION_CLASSES } from "./decision-points.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

// ---------- pure parts (tested in test/fork-runner.test.mjs, no runs, no server) ----------

/**
 * Expand a fork spec into one env-object per replicate. `spec` is
 * { run, call, branch, action?, replicates? } (action is required for A-natural; optional
 * for A-oracle, where it is filled from `recorded` when omitted). `recorded` is
 * { cls, tool, args } — the source run's actual call at `call`, required for A-oracle, whose
 * `tool` must be non-null (a null tool means the recorded point was an "answer" with no tool
 * call to force). `forceDir`, required only for A-oracle, is where its recorded `args` are
 * written to disk: they can be arbitrary JSON (a probe body, say) large enough to blow past
 * Windows' ~32 KB process-environment-block limit if carried inline in ARBITER_FORK_FORCE, so
 * ext/guards/fork-force.ts instead reads them from a file named "@<path>" in that env var.
 * A-natural's force spec is just { cls } — small enough to stay inline — and G needs no forcing
 * at all. `args` is deliberately kept out of ARBITER_FORK itself: lib/fork.mjs's forkSpec only
 * needs `tool` to restore an A-oracle fork; the parameters themselves travel only through the
 * force file, never through the supervisor's own env.
 * Returns [{ env: { ARBITER_FORK, ARBITER_FORK_FORCE? }, branch, replicate, forceFile?,
 * forcePayload? }, ...] — a plan with a `forceFile` needs it written (JSON.stringify(forcePayload))
 * before the replicate is spawned.
 *
 * The resolved action class is validated against tools/decision-points.mjs's nine classes,
 * because `decideForce` compares it against `classOfCall`'s output on every tool call: a class
 * that never comes back from there denies the orchestrator's every call for the whole run, and
 * the replicate burns a full run whose report row looks ordinary. `answer` is one of the nine
 * but is exactly such a class — it is the ABSENCE of a tool call, so no tool call can ever
 * satisfy it — and is rejected here too.
 */
export function planForks(spec, recorded = null, { forceDir = null } = {}) {
	const { run, call, branch, replicates = 1 } = spec;
	let action = spec.action ?? null;
	let tool = null;
	let args = null;
	if (branch === "A-oracle") {
		if (!recorded) throw new Error("A-oracle needs the recorded action (cls, tool, args) to fill in when none is given explicitly");
		action = action ?? recorded.cls;
		tool = recorded.tool;
		args = recorded.args ?? null;
		if (!tool) throw new Error(`A-oracle needs a recorded tool call to force, but the recorded point at call ${call} is an "answer" (no tool call) — pick a different call`);
	} else if (branch === "A-natural") {
		if (!action) throw new Error("A-natural requires an action class to force (--action, or the head's prediction)");
	} else if (branch !== "G") {
		throw new Error(`unknown branch ${branch}`);
	}
	if (branch !== "G") {
		if (!ACTION_CLASSES.includes(action)) throw new Error(`unknown action class "${action}" — must be one of ${ACTION_CLASSES.join(", ")}`);
		if (action === "answer") throw new Error('action class "answer" cannot be forced: it is the absence of a tool call, so no tool call would ever satisfy it and every call of the run would be denied');
	}
	const plans = [];
	for (let replicate = 1; replicate <= replicates; replicate++) {
		const fork = { run, call, branch, replicate };
		if (branch !== "G") fork.action = action;
		if (branch === "A-oracle") fork.tool = tool; // args deliberately excluded — see above
		const env = { ARBITER_FORK: JSON.stringify(fork) };
		if (branch === "A-oracle") {
			if (!forceDir) throw new Error("A-oracle needs a forceDir to write its recorded arguments to (the env cannot carry them safely — see the Windows env-size note above)");
			const forcePayload = { cls: action, tool, args };
			const forceFile = path.join(forceDir, `force-${branch}-${replicate}.json`);
			plans.push({ env: { ...env, ARBITER_FORK_FORCE: `@${forceFile}` }, branch, replicate, forceFile, forcePayload });
			continue;
		}
		// G is the null branch and must force nothing. Set explicitly rather than omitted:
		// runOnce spreads process.env under the plan's env, so a stale ARBITER_FORK_FORCE in
		// the operator's shell would otherwise arm the guard during a null-gate run.
		env.ARBITER_FORK_FORCE = branch === "G" ? "" : JSON.stringify({ cls: action });
		plans.push({ env, branch, replicate });
	}
	return plans;
}

// The generation settings payloadEquals deliberately does not look at. `model` and
// `chat_template_kwargs` are the two the spec pins ("same server, same quant, same sampler
// settings as recorded") — the thinking level lives in chat_template_kwargs — and without
// them the report could say "state match: yes" for a fork run against a different model or
// with thinking off. Kept out of `equal` so that number keeps meaning "the restored
// conversation is the recorded one"; surfaced as its own column instead.
const SETTINGS_FIELDS = ["model", "chat_template_kwargs"];

/** Is the fork's first captured request the recorded one? sourceReq/forkReq are the raw
 * requests/NNNN.json bodies ({ payload, ... }); forkReq may be null (fork captured nothing).
 * `equal`/`firstDiff` cover the conversation (messages and tool names); `settings` covers the
 * generation settings above, separately, and is null when there is no fork request to read. */
export function compareFirstRequest(sourceReq, forkReq) {
	if (!forkReq) return { equal: false, firstDiff: "no fork request captured", settings: null };
	const mismatched = SETTINGS_FIELDS.filter((f) => JSON.stringify(sourceReq?.payload?.[f]) !== JSON.stringify(forkReq.payload?.[f]));
	return { ...payloadEquals(sourceReq?.payload, forkReq.payload), settings: { equal: mismatched.length === 0, mismatched } };
}

/** summary.guards is guard name -> kind -> role -> count; this totals `kinds` across roles.
 * Reported per kind rather than as one number because the two kinds mean opposite things:
 * a `fork_force` REWRITTEN says the forcing landed, a DENIED says the model was redirected,
 * and a `topology` DENIED of the forced call is the accepted risk that leaves an A-branch
 * replicate's retry unforced — the thing the reader has to be able to see. */
function guardKinds(guards, name, kinds) {
	const g = guards?.[name];
	return Object.fromEntries(kinds.map((kind) => [kind, Object.values(g?.[kind] ?? {}).reduce((a, b) => a + b, 0)]));
}

/**
 * One report row from already-loaded pieces: `compare` (compareFirstRequest's result),
 * `sourceCls` (the source point's recorded action class), `decisions` (the fork run's
 * decisions.jsonl records), `oracle` (the joined "x/y" oracle-run scores from its
 * audit.jsonl), `summary` (its summary.json, or null when the run never wrote one). `runId` is
 * null when the fork produced no run at all. `exit` is the supervisor child's own exit code,
 * reported but NOT the crash signal. `decisionsMissing` is true when
 * `tools/decision-points.mjs` failed on this run (so `decisions` may be stale or empty even
 * though the run itself did not crash).
 *
 * `crashed` — this replicate's numbers describe a run that did not finish, so they must not
 * count toward a reproduction rate — is `summary === null` or a summary `reason` beginning
 * `FORK:`. The summary is the evidence, because the exit code is wrong in BOTH directions:
 *
 * - Exit 0 with a complete summary can still be a fork that never started. finish() always
 *   exits 0, including on the rejected-`continue` path, so a fork whose restored transcript
 *   `Agent.continue()` refused writes an ordinary summary.json with reason "FORK: continue
 *   rejected — ...". Counted as a normal run, three such replicates read as "state match 0/3,
 *   recorded class reproduced 0/3, 0 crashed" — a harness refusal depressing the very gate the
 *   twelve real forks are conditioned on.
 * - Exit non-zero with a complete summary is a run that finished and then died on the way out.
 *   Observed live: runs/2026-09-17T18-09-28 reached SUCCESS 70/70 and wrote its summary at
 *   623.3 s, then an agent_end still in flight became a silent-turn nudge into a closed pipe
 *   and the supervisor exited 1 (fixed in supervisor.mjs's send, but the rule must not depend
 *   on that fix holding). Every number in that summary is real; excluding the row would throw
 *   away a valid replicate of the gate.
 *
 * Either way the row is shown, not hidden — `exit` stays a column, and a non-zero exit over a
 * complete summary is labelled `post-finish` so the reader sees it and knows why it counts.
 */
/**
 * A fork's decisions.jsonl is extracted from its session file, which BEGINS with the inherited
 * history: points 0..call-2 are the source run's own decisions, replayed verbatim. Only the
 * points from index call-1 on were made in the fork. Read on every row before anything is
 * counted, so "first action" is the fork's first inference and probes/resumes/decoded are the
 * fork's own — the first live batch showed the source run's opening `ls` on every row.
 */
export function ownDecisions(decisions, call) {
	return (decisions ?? []).filter((p) => Number.isFinite(p?.i) && p.i >= call - 1);
}

export function forkRow({ branch, replicate, runId, compare, sourceCls, decisions = [], oracle = "", summary = null, exit = null, decisionsMissing = false, call = null }) {
	if (call !== null) decisions = ownDecisions(decisions, call);
	const first = decisions[0] ?? null;
	const firstAction = first ? { cls: first.action.cls, tool: first.action.tool, params: first.action.params } : null;
	// Two harness outcomes wear an ordinary summary: the fork preflight/continue refusing the
	// fork (reason "FORK: …") and the orchestrator process dying before it did anything
	// (reason "agent … exited unexpectedly …", written by the child-exit handler). Neither is
	// the model failing to reproduce itself, so both leave the null-gate denominators.
	const reason = String(summary?.reason ?? "");
	const forkAborted = reason.startsWith("FORK:") || /^agent \S+ exited unexpectedly/.test(reason);
	const crashed = summary === null || forkAborted;
	return {
		branch, replicate, runId,
		exit, crashed, forkAborted,
		// The run finished and wrote its summary, then the supervisor died on the way out.
		postFinishExit: summary !== null && exit !== null && exit !== 0,
		forkReason: forkAborted ? String(summary.reason) : null,
		stateMatch: compare?.equal ?? false,
		firstDiff: compare?.firstDiff ?? null,
		settings: compare?.settings ?? null,
		firstAction,
		// A failed decision-point extraction leaves no first action; that is a tooling gap, not
		// a non-reproduction, so the row is excluded from the reproduction fraction (see the
		// nullMode counts in renderReport) while its oracle and wall columns stand.
		reproduced: firstAction ? firstAction.cls === sourceCls : null,
		oracle,
		probes: decisions.filter((p) => p.action?.cls === "probe").length,
		resumes: decisions.filter((p) => p.action?.cls === "resume").length,
		decoded: decisions.reduce((s, p) => s + (p.decoded ?? 0), 0),
		wallSec: summary?.wallSec ?? null,
		// What the supervisor recorded about the restoration itself. Without it the producer
		// and the consumer of summary.fork are unconnected: how many of the source run's
		// workers came back, and how many of those were still running at the fork instant (a
		// worker restored as completed because no such process exists in the fork), is the
		// difference between a fork that rebuilt the world and one that rebuilt part of it.
		sourceWorkers: summary?.fork ? (summary.fork.sourceWorkers ?? []).length : null,
		liveAtFork: summary?.fork ? (summary.fork.sourceWorkers ?? []).filter((w) => w.liveAtFork).length : null,
		guards: {
			forkForce: guardKinds(summary?.guards, "fork_force", ["denied", "rewritten"]),
			topology: guardKinds(summary?.guards, "topology", ["denied", "waived"]),
		},
		decisionsMissing,
	};
}

function paramsHead(params) {
	return JSON.stringify(params ?? {}).slice(0, 60);
}

// The supervisor's collision preflight: a fork reuses the SOURCE run's out-of-tree paths, so
// only one run may hold them at a time. Matched against a replicate's log because the failure
// is not that replicate's. A replicate that dies at module scope after the workspace copy
// leaves runs/.ws-<src> behind, and every LATER replicate then exits 2 here — one failure
// costing the whole batch, every row after it identically crashed, with nothing saying why.
const COLLISION = /^fork: .* already exists — a live run or another fork holds it/m;

/** The collision line in a replicate's log, or null. */
export function collisionMessage(log) {
	return COLLISION.exec(String(log ?? ""))?.[0] ?? null;
}

/** Render the report: the source point, one row per replicate, and (nullMode) the
 * reproduction-rate line. `source` is { runId, call, recordedCls, substantive, headPick }.
 * Crashed replicates (see forkRow) are shown in the table but excluded from the null-gate
 * counts, since their numbers describe a run that never finished.
 *
 * The `forced` and `topology` columns are what make an A-branch replicate readable: a row
 * with no `fork_force` event at all did not force anything, whatever its branch label says,
 * and a `topology` denial on the same call is the accepted risk from the Task 3 ruling
 * (fork-force disarms on the first ATTEMPTED call of the forced class, so a nudge that
 * blocks that call leaves the retry unforced). Both were computed and thrown away before. */
export function renderReport(source, rows, { nullMode = false } = {}) {
	const lines = [`# fork ${source.runId} #${source.call}`, ""];
	const subst = source.substantive?.cls ? `${source.substantive.cls} (${source.substantive.gatherSteps} gather step${source.substantive.gatherSteps === 1 ? "" : "s"})` : "none recorded";
	const head = source.headPick ? `${source.headPick.pickClass} (p=${source.headPick.confidence.toFixed(2)})` : "not replayed";
	lines.push(`Source point: recorded class **${source.recordedCls}**, next substantive action **${subst}**, head pick ${head}.`, "");
	lines.push("| branch | replicate | run | exit | crashed | state match | settings | first action | reproduced | forced (denied/rewritten) | topology (denied/waived) | workers restored (live at fork) | oracle | probes | resumes | decoded | wall s |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		const fa = r.firstAction ? `${r.firstAction.cls} · ${r.firstAction.tool ?? "—"} · ${paramsHead(r.firstAction.params)}` : r.decisionsMissing ? "— (decision-points failed)" : "—";
		const sm = r.stateMatch ? "yes" : `no (${JSON.stringify(r.firstDiff)})`;
		// The settings the state match deliberately ignores: model and chat_template_kwargs
		// (where the thinking level lives). A mismatch here makes every other number in the row
		// a comparison against something the source run never was.
		const settings = !r.settings ? "—" : r.settings.equal ? "match" : `mismatch: ${r.settings.mismatched.join(", ")}`;
		const rep = r.reproduced === null ? "—" : r.reproduced ? "yes" : "no";
		const forced = `${r.guards.forkForce.denied}/${r.guards.forkForce.rewritten}`;
		const topo = `${r.guards.topology.denied}/${r.guards.topology.waived}`;
		// A fork the harness refused exits 0 with an ordinary summary, so the reason is the
		// only thing that separates it from a run the model simply lost. Say which it was.
		const crashed = r.crashed ? (r.forkAborted ? `yes — ${r.forkReason.replace(/\s+/g, " ").slice(0, 80)}` : "yes") : "no";
		// A non-zero exit over a complete summary is the run dying on its way out, after every
		// number in the row was already written. Labelled rather than treated as a crash.
		const exitCell = r.exit === null ? "—" : r.postFinishExit ? `${r.exit} (post-finish)` : String(r.exit);
		const workers = r.sourceWorkers === null ? "—" : `${r.sourceWorkers} (${r.liveAtFork})`;
		lines.push(`| ${r.branch} | ${r.replicate} | ${r.runId ?? "—"} | ${exitCell} | ${crashed} | ${sm} | ${settings} | ${fa} | ${rep} | ${forced} | ${topo} | ${workers} | ${r.oracle || "—"} | ${r.probes} | ${r.resumes} | ${r.decoded} | ${r.wallSec ?? "—"} |`);
	}
	lines.push("");
	if (nullMode) {
		const included = rows.filter((r) => !r.crashed && !r.decisionsMissing);
		const crashedCount = rows.length - included.length;
		const n = included.length;
		const stateMatches = included.filter((r) => r.stateMatch).length;
		const reproduced = included.filter((r) => r.reproduced).length;
		const aborted = rows.filter((r) => r.forkAborted).length;
		const why = aborted ? `${crashedCount} crashed, excluded — ${aborted} of them the harness refusing the fork, not the model` : `${crashedCount} crashed, excluded`;
		lines.push(`null fork: state match ${stateMatches}/${n}, recorded class reproduced ${reproduced}/${n} (${why})`, "");
	}
	return lines.join("\n");
}

// ---------- impure: reading the recorded run, spawning replicates, writing the report ----------

function usage(msg) {
	if (msg) console.error(msg);
	console.error("usage: node tools/fork.mjs <runId> <call> --config <config.json> --branch G|A-natural|A-oracle [--action <cls>] [--replicates N] [--null] [--control <file>]");
	process.exit(1);
}

function parseArgs(argv) {
	const [runId, callStr, ...rest] = argv;
	if (!runId || !callStr) usage();
	const call = Number(callStr);
	if (!Number.isInteger(call) || call < 1) usage(`<call> must be a positive integer, got ${callStr}`);
	const opts = { config: null, branch: null, action: null, replicates: 1, nullMode: false, control: null };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--config") opts.config = rest[++i];
		else if (a === "--branch") opts.branch = rest[++i];
		else if (a === "--action") opts.action = rest[++i];
		else if (a === "--replicates") opts.replicates = Number(rest[++i]);
		else if (a === "--null") opts.nullMode = true;
		else if (a === "--control") opts.control = rest[++i];
		else usage(`unknown flag ${a}`);
	}
	if (!opts.config) usage("--config is required");
	if (opts.nullMode) opts.branch = opts.branch ?? "G";
	if (!opts.branch) usage("--branch is required (or pass --null)");
	if (opts.nullMode && opts.branch !== "G") usage("--null runs branch G; drop --null or set --branch G");
	if (!["G", "A-natural", "A-oracle"].includes(opts.branch)) usage(`--branch must be G, A-natural or A-oracle, got ${opts.branch}`);
	if (!Number.isInteger(opts.replicates) || opts.replicates < 1) usage(`--replicates must be a positive integer, got ${opts.replicates}`);
	return { runId, call, ...opts };
}

function readJsonlSync(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The recorded call's class, tool and raw arguments — decisions.jsonl has the first two
 * (params there are already redacted/summarised); the arguments come from the orchestrator's
 * session file, the call-th assistant entry's first tool call. */
function recordedAction(runDir, call, point) {
	const trace = traceRun(runDir);
	const oi = trace.agents.findIndex((a) => a.role !== "worker");
	if (oi < 0) throw new Error(`${runDir}: no orchestrator session found`);
	const sessionFile = path.join(runDir, "sessions", trace.agents[oi].file);
	const turns = readSessionFile(sessionFile).filter((e) => e.type === "message" && e.message?.role === "assistant" && e.message?.usage);
	const turn = turns[call - 1];
	const first = (turn?.message?.content ?? []).find((c) => c.type === "toolCall");
	return { cls: point.action.cls, tool: point.action.tool, args: first?.arguments ?? null };
}

/** The head's pick at this point, from decisions-replay-substantive.jsonl, if that replay
 * was run (docs/batch's decision-head reports). Absent that file, the report says so. */
function headPickFor(runDir, call) {
	const file = path.join(runDir, "decisions-replay-substantive.jsonl");
	if (!fs.existsSync(file)) return null;
	const rows = readJsonlSync(file);
	const row = rows.find((r) => r.i === call - 1);
	// renderReport calls confidence.toFixed(2), and this runs only after every replicate has
	// already been run — so a replay row without a numeric confidence would crash the report
	// at the one moment there is nothing left to retry. Read as "not replayed" instead.
	if (!row?.head || typeof row.head.confidence !== "number") return null;
	return { pickClass: row.head.pickClass, confidence: row.head.confidence };
}

function runOnce(config, env, logFile, runsRoot) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(runsRoot));
		const log = fs.openSync(logFile, "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], {
			cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, ...env },
		});
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(runsRoot).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}

function collisionIn(logFile) {
	return fs.existsSync(logFile) ? collisionMessage(fs.readFileSync(logFile, "utf8")) : null;
}

function oracleScores(runDir) {
	const file = path.join(runDir, "audit.jsonl");
	if (!fs.existsSync(file)) return "";
	return (fs.readFileSync(file, "utf8").match(/Oracle run #\d+: (\d+\/\d+)/g) ?? []).map((m) => m.replace(/.*: /, "")).join(", ");
}

/** A refusal that carries the exit code the CLI uses for it: 1 for "this batch cannot be
 * described" (a missing run record), 2 for "this batch must not start" — the same code the
 * supervisor's own fork preflight uses. `runBatch` throws these instead of exiting, so a caller
 * inside another process (the manager's batch child) can report them rather than die. */
export class ForkBatchError extends Error {
	constructor(message, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

/**
 * One fork batch: every replicate of ONE branch, run to exit, plus the report.
 *
 * `spec` is { runId, call, branch, action?, replicates?, config, nullMode?, control?, runsDir?,
 * label? } and the return is { rows, report, logDir, reportPath, abandoned }. This is `main`'s
 * body, lifted so the management executor can run a batch in-process per branch instead of
 * shelling out per replicate; `main` now only parses argv and maps a ForkBatchError back onto an
 * exit code.
 *
 * `label` names the batch's report and its log directory, and defaults to the branch — which is
 * what the CLI passes, so a hand-run fork is named exactly as it always was. A manager's compare
 * can hold TWO forced branches (`spawn` and `probe`, say) and both are branch `A-natural` to the
 * fork runner: without a label they would write the same docs/batch report and the same replicate
 * logs, and only the last would survive. That is the one-file-per-comparison invariant the
 * fork-21 note further down protects, one level up.
 *
 * `control` is a file copied into the NEW run's runs/<newId>/control.jsonl by the supervisor
 * (it reads the path from ARBITER_FORK_CONTROL), which is how a `restore` delivers the
 * manager's message to a restored orchestrator. It is set EXPLICITLY on every replicate's env,
 * empty when there is none: runOnce spreads process.env under the plan's env, so an omitted key
 * would let a stale value in the operator's shell replay someone else's correction into every
 * replicate — the same trap planForks documents for ARBITER_FORK_FORCE.
 */
export async function runBatch(spec) {
	const runsDir = spec.runsDir ?? path.join(ROOT, "runs");
	const replicates = spec.replicates ?? 1;
	const control = spec.control ?? null;
	if (control && !fs.existsSync(control)) throw new ForkBatchError(`--control ${control}: no such file`, 2);
	const sourceDir = path.join(runsDir, spec.runId);
	const decisionsPath = path.join(sourceDir, "decisions.jsonl");
	if (!fs.existsSync(decisionsPath)) throw new ForkBatchError(`${spec.runId}: no decisions.jsonl (run node tools/decision-points.mjs ${spec.runId} first)`);
	const points = readJsonlSync(decisionsPath);
	const point = points.find((p) => p.i === spec.call - 1);
	if (!point) throw new ForkBatchError(`${spec.runId}: no decision point at call ${spec.call} (${points.length} points recorded)`);
	const sourceCls = point.action.cls;

	const label = spec.label ?? (spec.nullMode ? "null" : spec.branch);
	const logDir = path.join(runsDir, `.batch-fork-${spec.runId}-${spec.call}-${label}`);
	fs.mkdirSync(logDir, { recursive: true });

	const recorded = spec.branch === "A-oracle" ? recordedAction(sourceDir, spec.call, point) : null;
	// A rejected plan is exit 2, the same code the supervisor's own fork preflight uses for
	// "this fork must not start": an unforceable action class would otherwise deny every call
	// of the run and the replicate would burn a full run whose report row looks ordinary.
	let plan;
	try {
		plan = planForks({ run: spec.runId, call: spec.call, branch: spec.branch, action: spec.action, replicates }, recorded, { forceDir: logDir });
	} catch (err) {
		throw new ForkBatchError(err?.message ?? String(err), 2);
	}

	const sourceReqFile = path.join(sourceDir, "requests", `${String(spec.call).padStart(4, "0")}.json`);
	if (!fs.existsSync(sourceReqFile)) throw new ForkBatchError(`${spec.runId}: no ${sourceReqFile} (this run has no captured request for call ${spec.call})`);
	const sourceReq = JSON.parse(fs.readFileSync(sourceReqFile, "utf8"));

	const rows = [];
	let abandoned = null;
	for (const { env, branch, replicate, forceFile, forcePayload } of plan) {
		if (forceFile) fs.writeFileSync(forceFile, JSON.stringify(forcePayload));
		console.log(`[fork ${spec.runId}#${spec.call}] ${branch} replicate ${replicate}/${plan.filter((p) => p.branch === branch).length}: starting`);
		const logFile = path.join(logDir, `${branch}-${replicate}.log`);
		const { code, runId } = await runOnce(spec.config, { ...env, ARBITER_FORK_CONTROL: control ?? "" }, logFile, runsDir);
		// The collision preflight is not this replicate's problem: a fork reuses the source
		// run's out-of-tree paths, so a leftover runs/.ws-<src> refuses this replicate and
		// every one after it. Stop and say which directory is held, rather than spending the
		// rest of the batch producing identical crashed rows.
		const collision = code === 2 ? collisionIn(logFile) : null;
		if (collision) {
			abandoned = { branch, replicate, collision };
			console.error(`[fork] ${branch}-${replicate} exited 2 on the collision preflight — ${collision}`);
			console.error(`[fork] abandoning the rest of the batch: every later replicate would fail the same way. Remove the directory named above (no run is live if the supervisor already exited) and re-run.`);
			rows.push(forkRow({ branch, replicate, runId: null, compare: { equal: false, firstDiff: "collision preflight" }, sourceCls, decisions: [], oracle: "", summary: null, exit: code }));
			break;
		}
		if (!runId) {
			console.error(`[fork] ${branch}-${replicate}: no new run directory appeared (exit ${code})`);
			rows.push(forkRow({ branch, replicate, runId: null, compare: { equal: false, firstDiff: "no run produced" }, sourceCls, decisions: [], oracle: "", summary: null, exit: code }));
			continue;
		}
		const dp = spawnSync(process.execPath, [path.join(ROOT, "tools", "decision-points.mjs"), runId], { cwd: ROOT, stdio: "ignore" });
		const decisionsMissing = dp.status !== 0;
		if (decisionsMissing) console.error(`[fork] ${branch}-${replicate}: tools/decision-points.mjs exited ${dp.status} for ${runId}`);
		const runDir = path.join(runsDir, runId);
		const forkReqFile = path.join(runDir, "requests", "0001.json");
		const forkReq = fs.existsSync(forkReqFile) ? JSON.parse(fs.readFileSync(forkReqFile, "utf8")) : null;
		const compare = compareFirstRequest(sourceReq, forkReq);
		const decisions = readJsonlSync(path.join(runDir, "decisions.jsonl"));
		const summaryFile = path.join(runDir, "summary.json");
		const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : null;
		const row = forkRow({ branch, replicate, runId, compare, sourceCls, decisions, oracle: oracleScores(runDir), summary, exit: code, decisionsMissing, call: spec.call });
		rows.push(row);
		console.log(`[fork] ${branch}-${replicate} → ${runId} exit=${row.exit} crashed=${row.crashed}${row.forkAborted ? ` (${row.forkReason})` : ""} stateMatch=${row.stateMatch} reproduced=${row.reproduced} oracle=${row.oracle || "—"}`);
	}

	const source = { runId: spec.runId, call: spec.call, recordedCls: sourceCls, substantive: point.substantive ?? null, headPick: headPickFor(sourceDir, spec.call) };
	let report = renderReport(source, rows, { nullMode: spec.nullMode });
	if (abandoned) {
		report += `\n**Batch abandoned** after ${abandoned.branch} replicate ${abandoned.replicate}: ${abandoned.collision}. ${plan.length - rows.length} replicate(s) of ${plan.length} were never run — every one of them would have failed the same way.\n`;
	}
	fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
	// One file per (run, call, label): the branches of one fork are separate invocations, and
	// a name without the branch let the A-natural batch overwrite the G batch (fork 21). The
	// label defaults to the branch, so the CLI's names are unchanged; a compare's two forced
	// branches differ only by label, and that is exactly what keeps their reports apart.
	const reportName = `fork-${spec.runId}-${spec.call}-${label}.md`;
	const reportPath = path.join(ROOT, "docs", "batch", reportName);
	fs.writeFileSync(reportPath, report);
	console.log(`[fork] report: docs/batch/${reportName}`);
	// Not an exit: a caller running several branches in one process decides what an abandoned
	// batch means for the rest of them. The CLI below still exits 2 on it, as it always did.
	return { rows, report, logDir, reportPath, abandoned };
}

async function main() {
	const spec = parseArgs(process.argv.slice(2));
	let out;
	try {
		out = await runBatch(spec);
	} catch (err) {
		if (!(err instanceof ForkBatchError)) throw err;
		if (err.exitCode === 2) {
			console.error(`[fork] ${err.message}`);
			process.exit(2);
		}
		usage(err.message);
		return;
	}
	if (out.abandoned) process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
