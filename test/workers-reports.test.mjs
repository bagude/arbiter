import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker, applyLifecycleEvent, bindTranscript, reportsFor, unreportedWorkers } from "../lib/workers.mjs";

// Synthetic lifecycle sequences: the pump time `now` increases by one per event, exactly
// as supervisor.mjs pumpLifecycle() feeds the reducer.
const started = (id) => ({ ev: "subagents:started", data: { id, description: `work ${id}` } });
const completed = (id) => ({ ev: "subagents:completed", data: { id, status: "completed", result: `done ${id}` } });
const failed = (id) => ({ ev: "subagents:failed", data: { id, error: "boom" } });
const resuming = (id) => ({ ev: "subagents:resuming", data: { id, description: `again ${id}` } });
const resumed = (id) => ({ ev: "subagents:resumed", data: { id, status: "completed", result: `done again ${id}` } });
const report = (session, status = "done") => ({ ev: "worker:report", data: { role: `worker:${session}`, status, findings: 2, verify: 1, changed: 1, chars: 300, verifyCases: [{ id: "c1", args: [1] }] } });

function harness() {
	const state = {};
	const timeline = [];
	const tracker = createTracker();
	let now = 1000;
	const audit = [];
	const feed = (...events) => {
		for (const { ev, data } of events) {
			now += 1;
			audit.push(...applyLifecycleEvent(tracker, state, timeline, { ev, data, now }).audit);
		}
	};
	const bind = (session) => bindTranscript(tracker, state, `C:/sessions/orchestrator/tasks/${session}.jsonl`);
	return { state, tracker, audit, feed, bind };
}

test("a report resolves to the bound worker, is tallied, and satisfies the gate input", () => {
	const h = harness();
	h.feed(started("a"));
	assert.equal(h.bind("sess-a"), "worker:a");
	h.feed(report("sess-a"), completed("a"));
	assert.equal(h.tracker.reports.length, 1);
	assert.equal(h.tracker.reports[0].role, "worker:a");
	assert.equal(h.tracker.reports[0].status, "done");
	assert.deepEqual(h.tracker.reports[0].verifyCases, [{ id: "c1", args: [1] }]);
	assert.deepEqual(reportsFor(h.tracker, "worker:a").map((r) => r.status), ["done"]);
	assert.deepEqual(h.audit.filter((a) => a.type === "worker_report").map((a) => a.msg), ["report: done; 2 findings, 1 verify cases, 1 files"]);
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
});

test("a completed worker without a report is unreported; a failed one is exempt; a running one is not counted", () => {
	const h = harness();
	h.feed(started("a"), completed("a"), started("b"), failed("b"), started("c"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
});

test("a resumed worker needs a report after the resume", () => {
	const h = harness();
	h.feed(started("a"));
	h.bind("sess-a");
	h.feed(report("sess-a"), completed("a"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
	h.feed(resuming("a"), resumed("a"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
	h.feed(report("sess-a", "partial"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
	assert.equal(reportsFor(h.tracker, "worker:a").length, 2);
});

test("a report that arrives before its transcript is bound resolves at query time", () => {
	const h = harness();
	h.feed(started("a"), report("sess-a"), completed("a"));
	assert.equal(h.tracker.reports[0].role, "worker:sess-a", "unresolved at arrival");
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
	h.bind("sess-a");
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
});
