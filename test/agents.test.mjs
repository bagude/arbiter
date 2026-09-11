import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentState, lastEditAcross, liveWorkers, EDITING_TOOLS } from "../lib/agents.mjs";

test("a fresh state is idle, not ready, with zero counters", () => {
	const s = createAgentState({ id: "builder", role: "builder" });
	assert.equal(s.ready, false);
	assert.equal(s.busy, false);
	assert.equal(s.toolCalls, 0);
	assert.equal(s.lastEditTs, 0);
	assert.ok(s.pendingBash instanceof Map);
});
test("lastEditAcross is the max over every agent", () => {
	const a = createAgentState({ id: "worker:1", role: "worker" }); a.lastEditTs = 10;
	const b = createAgentState({ id: "worker:2", role: "worker" }); b.lastEditTs = 30;
	const c = createAgentState({ id: "orchestrator", role: "orchestrator" });
	assert.equal(lastEditAcross([a, b, c]), 30);
	assert.equal(lastEditAcross([]), 0);
});
test("liveWorkers returns running workers only", () => {
	const a = createAgentState({ id: "worker:1", role: "worker" }); a.status = "running";
	const b = createAgentState({ id: "worker:2", role: "worker" }); b.status = "completed";
	const o = createAgentState({ id: "orchestrator", role: "orchestrator" }); o.status = "running";
	assert.deepEqual(liveWorkers([a, b, o]).map((s) => s.id), ["worker:1"]);
});
test("bash counts as an editing tool", () => {
	assert.ok(EDITING_TOOLS.has("bash") && EDITING_TOOLS.has("edit") && EDITING_TOOLS.has("write") && !EDITING_TOOLS.has("read"));
});
