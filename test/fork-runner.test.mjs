import { test } from "node:test";
import assert from "node:assert/strict";
import { planForks, compareFirstRequest, forkRow, renderReport } from "../tools/fork.mjs";

test("planForks: G branch carries no action and no forcing env", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "G", replicates: 2 });
	assert.equal(plans.length, 2);
	assert.deepEqual(plans.map((p) => p.replicate), [1, 2]);
	assert.ok(plans.every((p) => p.branch === "G"));
	for (const p of plans) {
		const fork = JSON.parse(p.env.ARBITER_FORK);
		assert.deepEqual(fork, { run: "r1", call: 5, branch: "G", replicate: p.replicate });
		assert.equal(p.env.ARBITER_FORK_FORCE, undefined);
	}
});

test("planForks: A-natural forces only the class, from spec.action", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "A-natural", action: "probe", replicates: 1 });
	assert.equal(plans.length, 1);
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "probe");
	assert.equal(fork.tool, undefined);
	const force = JSON.parse(plans[0].env.ARBITER_FORK_FORCE);
	assert.deepEqual(force, { cls: "probe" });
});

test("planForks: A-natural without an action to force throws", () => {
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-natural", replicates: 1 }), /action/);
});

test("planForks: A-oracle fills tool/args from the recorded call when spec.action is omitted", () => {
	const recorded = { cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } };
	const plans = planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, recorded);
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "probe");
	assert.equal(fork.tool, "send_mail");
	assert.deepEqual(fork.args, { kind: "probe", body: "[]" });
	const force = JSON.parse(plans[0].env.ARBITER_FORK_FORCE);
	assert.deepEqual(force, { cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } });
});

test("planForks: A-oracle honours an explicit spec.action but still takes tool/args from the recorded call", () => {
	const recorded = { cls: "done", tool: "send_mail", args: { kind: "done", body: "x" } };
	const plans = planForks({ run: "r1", call: 5, branch: "A-oracle", action: "done", replicates: 1 }, recorded);
	const fork = JSON.parse(plans[0].env.ARBITER_FORK);
	assert.equal(fork.action, "done");
	assert.equal(fork.tool, "send_mail");
});

test("planForks: A-oracle without a recorded call to fill from throws", () => {
	assert.throws(() => planForks({ run: "r1", call: 5, branch: "A-oracle", replicates: 1 }, null), /recorded/);
});

test("planForks: replicates each get their own env with the matching replicate number", () => {
	const plans = planForks({ run: "r1", call: 5, branch: "A-natural", action: "resume", replicates: 3 });
	assert.deepEqual(plans.map((p) => JSON.parse(p.env.ARBITER_FORK).replicate), [1, 2, 3]);
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

test("forkRow builds the row fields from a summary/decisions/audit-derived input", () => {
	const decisions = [
		{ i: 5, action: { cls: "probe", tool: "send_mail", params: { kind: "probe", cases: 3 } }, decoded: 40 },
		{ i: 6, action: { cls: "resume", tool: "subagent", params: { resume: "abc" } }, decoded: 60 },
		{ i: 7, action: { cls: "resume", tool: "subagent", params: { resume: "abc" } }, decoded: 20 },
	];
	const summary = { wallSec: 12.5, guards: { fork_force: { rewritten: { orchestrator: 1 } }, topology: { denied: { orchestrator: 2 } } } };
	const row = forkRow({ branch: "A-natural", replicate: 2, runId: "run-2", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions, oracle: "68/70, 69/70", summary });
	assert.equal(row.branch, "A-natural");
	assert.equal(row.replicate, 2);
	assert.equal(row.runId, "run-2");
	assert.equal(row.stateMatch, true);
	assert.equal(row.firstDiff, null);
	assert.deepEqual(row.firstAction, { cls: "probe", tool: "send_mail", params: { kind: "probe", cases: 3 } });
	assert.equal(row.reproduced, true, "first action's class matches the source point's recorded class");
	assert.equal(row.oracle, "68/70, 69/70");
	assert.equal(row.probes, 1);
	assert.equal(row.resumes, 2);
	assert.equal(row.decoded, 120);
	assert.equal(row.wallSec, 12.5);
	assert.deepEqual(row.guards, { forkForce: 1, topology: 2 });
});

test("forkRow: reproduced is false when the fork's first action differs from the recorded class", () => {
	const decisions = [{ i: 5, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 10 }];
	const row = forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: false, firstDiff: { index: 2, field: "content" } }, sourceCls: "probe", decisions, oracle: "", summary: {} });
	assert.equal(row.reproduced, false);
	assert.equal(row.stateMatch, false);
	assert.deepEqual(row.firstDiff, { index: 2, field: "content" });
	assert.deepEqual(row.guards, { forkForce: 0, topology: 0 });
});

test("forkRow: a fork that produced no run at all reports nulls rather than throwing", () => {
	const row = forkRow({ branch: "G", replicate: 1, runId: null, compare: { equal: false, firstDiff: "no run produced" }, sourceCls: "probe", decisions: [], oracle: "", summary: {} });
	assert.equal(row.runId, null);
	assert.equal(row.firstAction, null);
	assert.equal(row.reproduced, null);
	assert.equal(row.probes, 0);
	assert.equal(row.decoded, 0);
});

test("renderReport contains the source point and one row per replicate", () => {
	const source = { runId: "2026-09-17T16-47-16", call: 8, recordedCls: "probe", substantive: { cls: "resume", gatherSteps: 2 }, headPick: { pickClass: "resume", confidence: 0.81 } };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-g1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [{ i: 8, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 10 }], oracle: "68/70", summary: { wallSec: 5 } }),
		forkRow({ branch: "A-oracle", replicate: 1, runId: "run-a1", compare: { equal: true, firstDiff: null }, sourceCls: "probe", decisions: [{ i: 8, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 30 }], oracle: "70/70", summary: { wallSec: 9 } }),
	];
	const report = renderReport(source, rows, { nullMode: false });
	assert.match(report, /2026-09-17T16-47-16/);
	assert.match(report, /probe/);
	assert.match(report, /resume \(2 gather step/);
	assert.match(report, /run-g1/);
	assert.match(report, /run-a1/);
	assert.equal(report.split("\n").filter((l) => l.startsWith("| G ") || l.startsWith("| A-oracle ")).length, 2);
	assert.doesNotMatch(report, /null fork:/);
});

test("renderReport in null mode adds the reproduction-rate line", () => {
	const source = { runId: "r1", call: 3, recordedCls: "resume", substantive: null, headPick: null };
	const rows = [
		forkRow({ branch: "G", replicate: 1, runId: "run-1", compare: { equal: true, firstDiff: null }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "resume", tool: "subagent", params: {} }, decoded: 5 }], oracle: "", summary: {} }),
		forkRow({ branch: "G", replicate: 2, runId: "run-2", compare: { equal: false, firstDiff: { index: 1, field: "content" } }, sourceCls: "resume", decisions: [{ i: 3, action: { cls: "probe", tool: "send_mail", params: {} }, decoded: 5 }], oracle: "", summary: {} }),
	];
	const report = renderReport(source, rows, { nullMode: true });
	assert.match(report, /null fork: state match 1\/2, recorded class reproduced 1\/2/);
	assert.match(report, /not replayed/);
});
