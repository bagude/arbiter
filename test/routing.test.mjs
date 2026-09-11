import { test } from "node:test";
import assert from "node:assert/strict";
import { routeMail } from "../lib/routing.mjs";

const m = (from, to, kind) => ({ from, to, kind, body: "" });

test("dyad: critic probe is intercepted", () => {
	assert.deepEqual(routeMail("dyad", m("critic", "builder", "probe")), { action: "probe" });
});
test("dyad: critic done is an approval attempt", () => {
	assert.deepEqual(routeMail("dyad", m("critic", "builder", "done")), { action: "approval" });
});
test("dyad: a builder probe is bounced, never relayed", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "probe")), { action: "bounce_probe", to: "builder" });
});
test("dyad: everything else is delivered to its recipient", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "question")), { action: "deliver", to: "critic" });
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "done")), { action: "deliver", to: "critic" });
});
test("solo: builder done runs the oracle, anything else is acknowledged", () => {
	assert.deepEqual(routeMail("solo", m("builder", "supervisor", "done")), { action: "solo_done" });
	assert.deepEqual(routeMail("solo", m("builder", "supervisor", "status")), { action: "solo_ack", to: "builder" });
});
test("orchestrator: orchestrator probe and done are intercepted; other kinds acknowledged", () => {
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "probe")), { action: "probe" });
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "done")), { action: "approval" });
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "status")), { action: "solo_ack", to: "orchestrator" });
});
test("unknown recipients are dropped", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "nobody", "question")), { action: "drop" });
});
