#!/usr/bin/env node
// Fork runner: drives supervisor.mjs's fork mode (env ARBITER_FORK[/ARBITER_FORK_FORCE],
// lib/fork.mjs, ext/guards/fork-force.ts) to restore a recorded decision point and either
// let the orchestrator continue on its own (branch G) or force its first tool call to a
// class (A-natural) or a recorded class+tool+args (A-oracle). Spec:
// docs/superpowers/specs/2026-09-17-fork-runner-design.md.
//
//   node tools/fork.mjs <runId> <call> --config <config.json> --branch G|A-natural|A-oracle
//                        [--action <cls>] [--replicates N] [--null]
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
// A crashed replicate (non-zero supervisor exit, or no summary.json) is still reported, but
// excluded from the null-gate reproduction counts — its numbers describe a run that never
// finished.
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

/** Is the fork's first captured request the recorded one? sourceReq/forkReq are the raw
 * requests/NNNN.json bodies ({ payload, ... }); forkReq may be null (fork captured nothing). */
export function compareFirstRequest(sourceReq, forkReq) {
	if (!forkReq) return { equal: false, firstDiff: "no fork request captured" };
	return payloadEquals(sourceReq?.payload, forkReq.payload);
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
 * null when the fork produced no run at all. `exit` is the supervisor child's own exit code;
 * `crashed` is true when that exit was non-zero or `summary` is null — either way, this
 * replicate's numbers (oracle, probes, decoded, ...) describe a run that did not finish
 * normally and should not count toward a reproduction rate. `decisionsMissing` is true when
 * `tools/decision-points.mjs` failed on this run (so `decisions` may be stale or empty even
 * though the run itself did not crash).
 */
export function forkRow({ branch, replicate, runId, compare, sourceCls, decisions = [], oracle = "", summary = null, exit = null, decisionsMissing = false }) {
	const first = decisions[0] ?? null;
	const firstAction = first ? { cls: first.action.cls, tool: first.action.tool, params: first.action.params } : null;
	const crashed = (exit !== null && exit !== 0) || summary === null;
	return {
		branch, replicate, runId,
		exit, crashed,
		stateMatch: compare?.equal ?? false,
		firstDiff: compare?.firstDiff ?? null,
		firstAction,
		reproduced: firstAction ? firstAction.cls === sourceCls : null,
		oracle,
		probes: decisions.filter((p) => p.action?.cls === "probe").length,
		resumes: decisions.filter((p) => p.action?.cls === "resume").length,
		decoded: decisions.reduce((s, p) => s + (p.decoded ?? 0), 0),
		wallSec: summary?.wallSec ?? null,
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
	lines.push("| branch | replicate | run | exit | crashed | state match | first action | reproduced | forced (denied/rewritten) | topology (denied/waived) | oracle | probes | resumes | decoded | wall s |");
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		const fa = r.firstAction ? `${r.firstAction.cls} · ${r.firstAction.tool ?? "—"} · ${paramsHead(r.firstAction.params)}` : r.decisionsMissing ? "— (decision-points failed)" : "—";
		const sm = r.stateMatch ? "yes" : `no (${JSON.stringify(r.firstDiff)})`;
		const rep = r.reproduced === null ? "—" : r.reproduced ? "yes" : "no";
		const forced = `${r.guards.forkForce.denied}/${r.guards.forkForce.rewritten}`;
		const topo = `${r.guards.topology.denied}/${r.guards.topology.waived}`;
		lines.push(`| ${r.branch} | ${r.replicate} | ${r.runId ?? "—"} | ${r.exit ?? "—"} | ${r.crashed ? "yes" : "no"} | ${sm} | ${fa} | ${rep} | ${forced} | ${topo} | ${r.oracle || "—"} | ${r.probes} | ${r.resumes} | ${r.decoded} | ${r.wallSec ?? "—"} |`);
	}
	lines.push("");
	if (nullMode) {
		const included = rows.filter((r) => !r.crashed);
		const crashedCount = rows.length - included.length;
		const n = included.length;
		const stateMatches = included.filter((r) => r.stateMatch).length;
		const reproduced = included.filter((r) => r.reproduced).length;
		lines.push(`null fork: state match ${stateMatches}/${n}, recorded class reproduced ${reproduced}/${n} (${crashedCount} crashed, excluded)`, "");
	}
	return lines.join("\n");
}

// ---------- impure: reading the recorded run, spawning replicates, writing the report ----------

function usage(msg) {
	if (msg) console.error(msg);
	console.error("usage: node tools/fork.mjs <runId> <call> --config <config.json> --branch G|A-natural|A-oracle [--action <cls>] [--replicates N] [--null]");
	process.exit(1);
}

function parseArgs(argv) {
	const [runId, callStr, ...rest] = argv;
	if (!runId || !callStr) usage();
	const call = Number(callStr);
	if (!Number.isInteger(call) || call < 1) usage(`<call> must be a positive integer, got ${callStr}`);
	const opts = { config: null, branch: null, action: null, replicates: 1, nullMode: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--config") opts.config = rest[++i];
		else if (a === "--branch") opts.branch = rest[++i];
		else if (a === "--action") opts.action = rest[++i];
		else if (a === "--replicates") opts.replicates = Number(rest[++i]);
		else if (a === "--null") opts.nullMode = true;
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
	if (!row?.head) return null;
	return { pickClass: row.head.pickClass, confidence: row.head.confidence };
}

function runOnce(config, env, logFile) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(logFile, "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], {
			cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, ...env },
		});
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}

function oracleScores(runDir) {
	const file = path.join(runDir, "audit.jsonl");
	if (!fs.existsSync(file)) return "";
	return (fs.readFileSync(file, "utf8").match(/Oracle run #\d+: (\d+\/\d+)/g) ?? []).map((m) => m.replace(/.*: /, "")).join(", ");
}

async function main() {
	const spec = parseArgs(process.argv.slice(2));
	const sourceDir = path.join(ROOT, "runs", spec.runId);
	const decisionsPath = path.join(sourceDir, "decisions.jsonl");
	if (!fs.existsSync(decisionsPath)) usage(`${spec.runId}: no decisions.jsonl (run node tools/decision-points.mjs ${spec.runId} first)`);
	const points = readJsonlSync(decisionsPath);
	const point = points.find((p) => p.i === spec.call - 1);
	if (!point) usage(`${spec.runId}: no decision point at call ${spec.call} (${points.length} points recorded)`);
	const sourceCls = point.action.cls;

	const logDir = path.join(ROOT, "runs", `.batch-fork-${spec.runId}-${spec.call}`);
	fs.mkdirSync(logDir, { recursive: true });

	const recorded = spec.branch === "A-oracle" ? recordedAction(sourceDir, spec.call, point) : null;
	// A rejected plan is exit 2, the same code the supervisor's own fork preflight uses for
	// "this fork must not start": an unforceable action class would otherwise deny every call
	// of the run and the replicate would burn a full run whose report row looks ordinary.
	let plan;
	try {
		plan = planForks({ run: spec.runId, call: spec.call, branch: spec.branch, action: spec.action, replicates: spec.replicates }, recorded, { forceDir: logDir });
	} catch (err) {
		console.error(`[fork] ${err?.message ?? err}`);
		process.exit(2);
	}

	const sourceReqFile = path.join(sourceDir, "requests", `${String(spec.call).padStart(4, "0")}.json`);
	if (!fs.existsSync(sourceReqFile)) usage(`${spec.runId}: no ${sourceReqFile} (this run has no captured request for call ${spec.call})`);
	const sourceReq = JSON.parse(fs.readFileSync(sourceReqFile, "utf8"));

	const rows = [];
	for (const { env, branch, replicate, forceFile, forcePayload } of plan) {
		if (forceFile) fs.writeFileSync(forceFile, JSON.stringify(forcePayload));
		console.log(`[fork ${spec.runId}#${spec.call}] ${branch} replicate ${replicate}/${plan.filter((p) => p.branch === branch).length}: starting`);
		const { code, runId } = await runOnce(spec.config, env, path.join(logDir, `${branch}-${replicate}.log`));
		if (!runId) {
			console.error(`[fork] ${branch}-${replicate}: no new run directory appeared (exit ${code})`);
			rows.push(forkRow({ branch, replicate, runId: null, compare: { equal: false, firstDiff: "no run produced" }, sourceCls, decisions: [], oracle: "", summary: null, exit: code }));
			continue;
		}
		const dp = spawnSync(process.execPath, [path.join(ROOT, "tools", "decision-points.mjs"), runId], { cwd: ROOT, stdio: "ignore" });
		const decisionsMissing = dp.status !== 0;
		if (decisionsMissing) console.error(`[fork] ${branch}-${replicate}: tools/decision-points.mjs exited ${dp.status} for ${runId}`);
		const runDir = path.join(ROOT, "runs", runId);
		const forkReqFile = path.join(runDir, "requests", "0001.json");
		const forkReq = fs.existsSync(forkReqFile) ? JSON.parse(fs.readFileSync(forkReqFile, "utf8")) : null;
		const compare = compareFirstRequest(sourceReq, forkReq);
		const decisions = readJsonlSync(path.join(runDir, "decisions.jsonl"));
		const summaryFile = path.join(runDir, "summary.json");
		const summary = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : null;
		const row = forkRow({ branch, replicate, runId, compare, sourceCls, decisions, oracle: oracleScores(runDir), summary, exit: code, decisionsMissing });
		rows.push(row);
		console.log(`[fork] ${branch}-${replicate} → ${runId} exit=${row.exit} crashed=${row.crashed} stateMatch=${row.stateMatch} reproduced=${row.reproduced} oracle=${row.oracle || "—"}`);
	}

	const source = { runId: spec.runId, call: spec.call, recordedCls: sourceCls, substantive: point.substantive ?? null, headPick: headPickFor(sourceDir, spec.call) };
	const report = renderReport(source, rows, { nullMode: spec.nullMode });
	fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
	const reportName = `fork-${spec.runId}-${spec.call}.md`;
	fs.writeFileSync(path.join(ROOT, "docs", "batch", reportName), report);
	console.log(`[fork] report: docs/batch/${reportName}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
