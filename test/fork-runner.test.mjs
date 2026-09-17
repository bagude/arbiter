import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { planForks, compareFirstRequest, forkRow, renderReport } from "../tools/fork.mjs";

test("planForks: G branch carries no action, and blanks ARBITER_FORK_FORCE rather than omitting it", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "G", replicates: 2 });
	assert.equal(plans.length, 2);
	assert.deepEqual(plans.map((p) => p.replicate), [1, 2]);
	assert.ok(plans.every((p) => p.branch === "G"));
	for (const p of plans) {
		const fork = JSON.parse(p.env.ARBITER_FORK);
		assert.deepEqual(fork, { run: "r1", call: 5, branch: "G", replicate: p.replicate });
		// Explicitly "" — the runner spreads process.env under this, so an omitted key would
		// let a stale ARBITER_FORK_FORCE in the operator's shell arm the guard in a null run.
		assert.equal(p.env.ARBITER_FORK_FORCE, "", "the null branch must disarm the guard explicitly");
	}
});

test("planForks: an action class outside decision-points' nine is refused before any replicate runs", () => {
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-natural", action: "probes" }), /unknown action class "probes"/);
	assert.throws(
		() => planForks({ run: "r1", call: 5, branch: "A-oracle", action: "reusme" }, { cls: "resume", tool: "subagent", args: {} }, { forceDir: "runs/x" }),
		/unknown action class "reusme"/,
	);
	// The one of the nine that classOfCall can never return: `answer` is the ABSENCE of a
	// tool call, so forcing it denies every call of the run and burns the whole replicate.
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-natural", action: "answer" }), /cannot be forced/);
	// G forces nothing, so it has no action to validate.
	assert.equal(planForks({ run: "r1", call: 5, branch: "G" }).length, 1);
});

test("planForks: A-natural forces only the class, from spec.action, inline (no forceDir needed)", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "A-natural", action: "probe", replicates: 1 });
	assert.equal(plans.length, 1);
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "probe");
	assert.equal(fork.tool, undefined);
	const force = JSON.parse(plans[0].env.ARBITER_FORK_FORCE);
	assert.deepEqual(force, { cls: "probe" });
	assert.equal(plans[0].forceFile, undefined);
});

test("planForks: A-natural without an action to force throws", () => {
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-natural", replicates: 1 }), /action/);
});

test("planForks: A-oracle writes its recorded tool+args to a force file and points ARBITER_FORK_FORCE at it with '@', keeping args out of ARBITER_FORK", () => {
	const recorded = { cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } };
	const forceDir = path.join("runs", ".batch-fork-r1-5");
	const plans = planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, recorded, { forceDir });
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "probe");
	assert.equal(fork.tool, "send_mail");
	assert.equal(fork.args, undefined, "args must not travel through ARBITER_FORK");
	const expectedFile = path.join(forceDir, "force-A-oracle-1.json");
	assert.equal(plans[0].env.ARBITER_FORK_FORCE, `@${expectedFile}`);
	assert.equal(plans[0].forceFile, expectedFile);
	assert.deepEqual(plans[0].forcePayload, { cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } });
});

test("planForks: A-oracle honours an explicit spec.action but still takes tool/args from the recorded call", () => {
	const recorded = { cls: "done", tool: "send_mail", args: { kind: "done", body: "x" } };
	const plans = planForks({ run: "r1", call: 5, branch: "A-oracle", action: "done", replicates: 1 }, recorded, { forceDir: "runs/.batch-fork-r1-5" });
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "done");
	assert.equal(fork.tool, "send_mail");
	assert.deepEqual(plans[0].forcePayload, { cls: "done", tool: "send_mail", args: { kind: "done", body: "x" } });
});

test("planForks: A-oracle without a recorded call to fill from throws", () => {
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, null, { forceDir: "runs/x" }), /recorded/);
});

test("planForks: A-oracle whose recorded point has no tool (an answer, not a tool call) throws before ever needing a forceDir", () => {
	const recorded = { cls: "answer", tool: null, args: null };
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, recorded), /tool/);
});

test("planForks: A-oracle without a forceDir throws rather than risk an oversized inline env", () => {
	const recorded = { cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } };
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, recorded), /forceDir/);
});

test("planForks: replicates each get their own env and force file with the matching replicate number", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "A-natural", action: "resume", replicates: 3 });
	assert.deepEqual(plans.map((p) => JSON.parse(p.env.ARBITER_FORK).replicate), [1, 2, 3]);

	const recorded = { cls: "resume", tool: "subagent", args: { resume: "abc" } };
	const oraclePlans = planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 2 }, recorded, { forceDir: "runs/.batch-fork-r1-5" });
	assert.deepEqual(oraclePlans.map((p) => path.basename(p.forceFile)), ["force-A-oracle-1.json", "force-A-oracle-2.json"]);
});

test("compareFirstRequest wraps payloadEquals over the .payload field", () => {
	const source = { seq: 1, payload: { messages: [{ role: "system", content: "S" }], tools: [] } };
	const same = { seq: 1, payload: JSON.parse(JSON.stringify(source.payload)) };
	assert.deepEqual(compareFirstRequest(source, same), { equal: true, firstDiff: null });
	const diff = { seq: 1, payload: { messages: [{ role: "system", content: "S2" }], tools: [] } };
	assert.deepEqual(compareFirstRequest(source, diff), { equal: false, firstDiff: { index: 0, field: "content" } });
});

test("compareFirstRequest handles a fork that never captured a first request", () => {
	const source = { payload: { messages: [], tools: [] } };
	const result = compareFirstRequest(source, null);
	assert.equal(result.equal, false);
	assert.ok(result.firstDiff);
});

test("forkRow builds the row fields from a summary/decisions/audit-derived input, not crashed", () => {
	const decisions = [
		{ i: 5, action: { cls: "probe", tool: "send_mail", params: { kind: "probe", cases: 3 } }, decoded: 40 },
		{ i: 6, action: { cls: "resume", tool: "subagent", params: { resume: "abc" } }, decoded: 60 },
		{ i: 7, action: { cls: "resume", tool: "subagent", params: { resume: "abc" } }, decoded: 20 },
	];
	const summary = { wallSec: 12.5, guards: { fork_force: { rewritten: { orchestrator: 1 } }, topology: { denied: { orchestrator: 2 } } } };
	const row = forkRow({ branch: "A-natural", replicate: 2, runId: "run-2", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions, oracle: "68/70, 69/70", summary, exit: 0 });
	assert.equal(row.branch, "A-natural");
	assert.equal(row.replicate, 2);
	assert.equal(row.runId, "run-2");
	assert.equal(row.exit, 0);
	assert.equal(row.crashed, false);
	assert.equal(row.stateMatch, true);
	assert.equal(row.firstDiff, null);
	assert.deepEqual(row.firstAction, { cls: "probe", tool: "send_mail", params: { kind: "probe", cases: 3 } });
	assert.equal(row.reproduced, true, "first action's class matches the source point's recorded class");
	assert.equal(row.oracle, "68/70, 69/70");
	assert.equal(row.probes, 1);
	assert.equal(row.resumes, 2);
	assert.equal(row.decoded, 120);
	assert.equal(row.wallSec, 12.5);
	assert.deepEqual(row.guards, { forkForce: { denied: 0, rewritten: 1 }, topology: { denied: 2, waived: 0 } }, "per kind, not one total: a rewritten says the forcing landed, a topology denial says it may not have");
	assert.equal(row.decisionsMissing, false);
});

test("forkRow: reproduced is false when the fork's first action differs from the recorded class", () => {
	const decisions = [{ i: 5, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 10 }];
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: false, firstDiff: { index: 2, field: "content" } }, sourceCls: "probe", decisions, oracle: "", summary: {}, exit: 0 });
	assert.equal(row.reproduced, false);
	assert.equal(row.stateMatch, false);
	assert.deepEqual(row.firstDiff, { index: 2, field: "content" });
	assert.deepEqual(row.guards, { forkForce: { denied: 0, rewritten: 0 }, topology: { denied: 0, waived: 0 } });
	assert.equal(row.crashed, false);
});

test("forkRow: a fork that produced no run at all is crashed, and reports nulls rather than throwing", () => {
	const row = forkRow({ branch: "G", replicate: 1, runId: null, compare: { equal: false, firstDiff: "no run produced" }, sourceCls: "probe", decisions: [], oracle: "", summary: null, exit: 2 });
	assert.equal(row.runId, null);
	assert.equal(row.exit, 2);
	assert.equal(row.crashed, true);
	assert.equal(row.firstAction, null);
	assert.equal(row.reproduced, null);
	assert.equal(row.probes, 0);
	assert.equal(row.decoded, 0);
});

test("forkRow: crashed when the supervisor's own exit code is non-zero, even if a summary exists", () => {
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [], oracle: "", summary: { wallSec: 1 }, exit: 1 });
	assert.equal(row.crashed, true);
});

test("forkRow: crashed when summary.json is missing, even if exit was 0", () => {
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [], oracle: "", summary: null, exit: 0 });
	assert.equal(row.crashed, true);
});

// The supervisor's finish() always exits 0, including on the rejected-`continue` path, so a
// fork the harness refused writes an ordinary summary.json with exit 0. Left in the
// denominator it reads as the model failing to reproduce its own recorded behaviour.
test("forkRow: a fork the supervisor refused is crashed, though it exited 0 with a summary", () => {
	const summary = { wallSec: 3, reason: "FORK: continue rejected — Cannot continue from message role: assistant" };
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: false, firstDiff: "no fork request captured" }, sourceCls: "probe", decisions: [], oracle: "", summary, exit: 0 });
	assert.equal(row.crashed, true);
	assert.equal(row.forkAborted, true);
	assert.match(row.forkReason, /continue rejected/);
	// An ordinary failure reason is the run finishing badly, not the fork never starting.
	const ordinary = forkRow({ branch: "G", replicate: 2, runId: "run-2", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [], oracle: "", summary: { wallSec: 3, reason: "FAILED: done attempts exhausted" }, exit: 0 });
	assert.equal(ordinary.crashed, false);
	assert.equal(ordinary.forkAborted, false);
	assert.equal(ordinary.forkReason, null);
});

test("renderReport: a refused fork is out of the null denominator, on the page, and named as a harness refusal", () => {
	const source = { runId: "r1", call: 3, recordedCls: "probe", substantive: null, headPick: null };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [{ i: 3, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 5 }], oracle: "", summary: { wallSec: 5 }, exit: 0 }),
		forkRow({ branch: "G", replicate: 2, runId: "run-2", compare: { equal: false, firstDiff: "no fork request captured" }, sourceCls: "probe", decisions: [], oracle: "", summary: { wallSec: 1, reason: "FORK: continue rejected — Cannot continue from message role: assistant" }, exit: 0 }),
	];
	const report = renderReport(source, rows, { nullMode: true });
	assert.match(report, /null fork: state match 1\/1, recorded class reproduced 1\/1 \(1 crashed, excluded — 1 of them the harness refusing the fork, not the model\)/);
	assert.match(report, /\| run-2 \| 0 \| yes — FORK: continue rejected/, "the refused replicate is shown with its reason, not silently dropped");
});

test("forkRow: decisionsMissing passes through when tools/decision-points.mjs failed on this run", () => {
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [], oracle: "", summary: { wallSec: 1 }, exit: 0, decisionsMissing: true });
	assert.equal(row.decisionsMissing, true);
	assert.equal(row.crashed, false, "a run can finish normally even if the decision-point extraction step failed afterward");
});

test("renderReport contains the source point and one row per replicate, with exit/crashed columns", () => {
	const source = { runId: "2026-09-17T16-47-16", call: 8, recordedCls: "probe", substantive: { cls: "resume", gatherSteps: 2 }, headPick: { pickClass: "resume", confidence: 0.81 } };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-g1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [{ i: 8, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 10 }], oracle: "68/70", summary: { wallSec: 5 }, exit: 0 }),
		forkRow({ branch: "A-oracle", replicate: 1, runId: "run-a1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [{ i: 8, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 30 }], oracle: "70/70", summary: { wallSec: 9 }, exit: 0 }),
	];
	const report = renderReport(source, rows, { nullMode: false });
	assert.match(report, /2026-09-17T16-47-16/);
	assert.match(report, /probe/);
	assert.match(report, /resume \(2 gather step/);
	assert.match(report, /run-g1/);
	assert.match(report, /run-a1/);
	assert.match(report, /\| exit \| crashed \|/);
	assert.equal(report.split("\n").filter((l) => l.startsWith("| G ") || l.startsWith("| A-oracle ")).length, 2);
	assert.doesNotMatch(report, /null fork:/);
});

// An A-branch replicate whose forcing never happened — a topology nudge blocked it, or the
// guard never armed — reads exactly like a valid one unless these counts are on the page.
// The Task 3 ruling accepted the topology risk on the condition that they are.
test("renderReport shows the fork_force and topology counts per replicate", () => {
	const source = { runId: "r1", call: 3, recordedCls: "resume", substantive: null, headPick: null };
	const forcedRow = forkRow({
		branch: "A-oracle", replicate: 1, runId: "run-a1", compare: { equal: true, firstDiff: null }, sourceCls: "resume",
		decisions: [{ i: 3, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 5 }], oracle: "",
		summary: { wallSec: 5, guards: { fork_force: { rewritten: { orchestrator: 1 } }, topology: { denied: { orchestrator: 2 }, waived: { orchestrator: 1 } } } }, exit: 0,
	});
	// Labelled A-oracle, but no fork_force event of any kind: the guard never armed.
	const unforcedRow = forkRow({
		branch: "A-oracle", replicate: 2, runId: "run-a2", compare: { equal: true, firstDiff: null }, sourceCls: "resume",
		decisions: [{ i: 3, action: { cls: "inspect", tool: "read", params: {} }, decoded: 5 }], oracle: "",
		summary: { wallSec: 5, guards: {} }, exit: 0,
	});
	const report = renderReport(source, [forcedRow, unforcedRow], { nullMode: false });
	assert.match(report, /\| forced \(denied\/rewritten\) \| topology \(denied\/waived\) \|/);
	assert.match(report, /\| run-a1 \|.*\| 0\/1 \| 2\/1 \|/, "the forced replicate shows its rewrite and the topology denials");
	assert.match(report, /\| run-a2 \|.*\| 0\/0 \| 0\/0 \|/, "a replicate that forced nothing says so on its own row");
});

test("renderReport in null mode adds the reproduction-rate line", () => {
	const source = { runId: "r1", call: 3, recordedCls: "resume", substantive: null, headPick: null };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 5 }], oracle: "", summary: {}, exit: 0 }),
		forkRow({ branch: "G", replicate: 2, runId: "run-2", compare: { equal: false, firstDiff: { index: 1, field: "content" } }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 5 }], oracle: "", summary: {}, exit: 0 }),
	];
	const report = renderReport(source, rows, { nullMode: true });
	assert.match(report, /null fork: state match 1\/2, recorded class reproduced 1\/2 \(0 crashed, excluded\)/);
	assert.match(report, /not replayed/);
});

test("renderReport in null mode excludes crashed replicates from the reproduction counts, and shows them in the table", () => {
	const source = { runId: "r1", call: 3, recordedCls: "resume", substantive: null, headPick: null };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 5 }], oracle: "", summary: {}, exit: 0 }),
		forkRow({ branch: "G", replicate: 2, runId: "run-2", compare: { equal: false, firstDiff: { index: 1, field: "content" } }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 5 }], oracle: "", summary: {}, exit: 0 }),
		// crashed: exit 1, but its first action happens to "match" — must not count toward either fraction
		forkRow({ branch: "G", replicate: 3, runId: "run-3", compare: { equal: true, firstDiff: null }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 5 }], oracle: "", summary: null, exit: 1 }),
	];
	const report = renderReport(source, rows, { nullMode: true });
	assert.match(report, /null fork: state match 1\/2, recorded class reproduced 1\/2 \(1 crashed, excluded\)/);
	assert.match(report, /\| G \| 3 \| run-3 \| 1 \| yes \|/, "the crashed replicate still appears in the table, marked crashed");
});
