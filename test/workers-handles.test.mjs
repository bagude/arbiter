import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker, applyLifecycleEvent } from "../lib/workers.mjs";

test("handles:* and checkpoint:written events are tallied on the tracker and never decide anything", () => {
	const tracker = createTracker();
	const state = {};
	const timeline = [];
	const a = applyLifecycleEvent(tracker, state, timeline, { ev: "handles:archived", data: { role: "orchestrator", id: "h_0123456789ab", tool: "subagent", bytes: 20000, lines: 300 }, now: 1 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "handles:archived", data: { role: "worker:abc", id: "h_0123456789ac", tool: "bash", bytes: 9000, lines: 90 }, now: 2 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "handles:recalled", data: { role: "worker:abc", id: "h_0123456789ac", offset: 0, bytes: 9000 }, now: 3 });
	const c = applyLifecycleEvent(tracker, state, timeline, { ev: "checkpoint:written", data: { role: "orchestrator", n: 1, findings: 3, questions: 2, steps: 1, chars: 900 }, now: 4 });
	assert.equal(a.decision, null);
	assert.equal(a.audit[0].type, "handle");
	assert.match(a.audit[0].msg, /archived h_0123456789ab subagent 20000 bytes/);
	assert.deepEqual(tracker.handles, { archived: 2, recalled: 1, bytesArchived: 29000, byRole: { orchestrator: 1, "worker:abc": 1 }, ids: ["h_0123456789ab", "h_0123456789ac"] });
	assert.equal(c.audit[0].type, "checkpoint");
	assert.deepEqual(tracker.checkpoints, [{ n: 1, findings: 3, questions: 2, steps: 1, chars: 900, ts: 4 }]);
});
