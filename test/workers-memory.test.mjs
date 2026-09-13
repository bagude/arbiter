import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker, applyLifecycleEvent } from "../lib/workers.mjs";

test("memory:* lifecycle events are tallied on the tracker and never decide anything", () => {
	const tracker = createTracker();
	const state = {};
	const timeline = [];
	const a = applyLifecycleEvent(tracker, state, timeline, { ev: "memory:search", data: { role: "orchestrator", chars: 812, detail: "TX water loader" }, now: 1 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "memory:get", data: { role: "worker:abc", chars: 2400, detail: "m_a,m_b" }, now: 2 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "memory:refused", data: { role: "worker:abc", chars: 0, detail: "m_c" }, now: 3 });
	assert.equal(a.decision, null);
	assert.equal(a.audit[0].type, "memory");
	assert.match(a.audit[0].msg, /search 812 chars: TX water loader/);
	assert.deepEqual(tracker.memory, { searches: 1, gets: 1, refused: 1, chars: 3212, byRole: { orchestrator: 812, "worker:abc": 2400 } });
});
