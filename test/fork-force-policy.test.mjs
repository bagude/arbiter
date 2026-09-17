import { test } from "node:test";
import assert from "node:assert/strict";
import { classOfCall, decideForce } from "../lib/policies/fork-force.mjs";

test("classOfCall mirrors decision-points' classes for a single tool call", () => {
	assert.equal(classOfCall("subagent", { subagent_type: "tester", prompt: "x" }), "spawn");
	assert.equal(classOfCall("subagent", { resume: "id", prompt: "x" }), "resume");
	assert.equal(classOfCall("get_subagent_result", {}), "collect");
	assert.equal(classOfCall("send_mail", { kind: "probe", body: "[]" }), "probe");
	assert.equal(classOfCall("send_mail", { kind: "done", body: "" }), "done");
	assert.equal(classOfCall("send_mail", { kind: "memory", body: "" }), "memory");
	assert.equal(classOfCall("read", { path: "a" }), "inspect");
	assert.equal(classOfCall("memory_get", { ids: [] }), "memory");
	assert.equal(classOfCall("context_usage", {}), "checkpoint");
});

test("A-natural: deny every first call of the wrong class with the class named; the first call of the right class passes and disarms", () => {
	const force = { cls: "probe", tool: null, args: null };
	const state = { done: false };
	const d1 = decideForce({ toolName: "read", input: { path: "src/x.mjs" } }, force, state);
	assert.equal(d1.act, "deny");
	assert.match(d1.reason, /send a probe to the supervisor/);
	assert.equal(state.done, false);
	const d2 = decideForce({ toolName: "send_mail", input: { kind: "probe", body: "[]" } }, force, state);
	assert.deepEqual(d2, { act: "pass" });
	assert.equal(state.done, true);
	assert.deepEqual(decideForce({ toolName: "read", input: { path: "a" } }, force, state), { act: "pass" }, "disarmed after the forced call");
});

test("A-oracle: the first call of the right tool has its input replaced by the recorded arguments", () => {
	const force = { cls: "resume", tool: "subagent", args: { resume: "abc", prompt: "recorded brief" } };
	const state = { done: false };
	assert.equal(decideForce({ toolName: "send_mail", input: { kind: "probe" } }, force, state).act, "deny");
	const d = decideForce({ toolName: "subagent", input: { resume: "abc", prompt: "the model's own brief" } }, force, state);
	assert.deepEqual(d, { act: "rewrite", input: { resume: "abc", prompt: "recorded brief" } });
	assert.equal(state.done, true);
});

test("no force → pass", () => {
	assert.deepEqual(decideForce({ toolName: "read", input: {} }, null, { done: false }), { act: "pass" });
});
