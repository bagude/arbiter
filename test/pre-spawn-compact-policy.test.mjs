import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSpawnDeny, estimateContextChars } from "../lib/policies/pre-spawn-compact.mjs";

const big = { toolName: "subagent", resume: undefined, runInBackground: undefined, contextChars: 200000, thresholdChars: 100000 };

test("not applicable: wrong tool, a resume, a background spawn, or no threshold configured", () => {
	assert.equal(decideSpawnDeny({ ...big, toolName: "read" }, {}).reason, "not_applicable");
	assert.equal(decideSpawnDeny({ ...big, resume: "worker:abc" }, {}).reason, "not_applicable");
	assert.equal(decideSpawnDeny({ ...big, runInBackground: true }, {}).reason, "not_applicable");
	assert.equal(decideSpawnDeny({ ...big, thresholdChars: 0 }, {}).reason, "not_applicable");
});

test("below threshold: not denied", () => {
	const d = decideSpawnDeny({ ...big, contextChars: 99999 }, {});
	assert.equal(d.deny, false);
	assert.equal(d.reason, "below_threshold");
});

test("over threshold: denied once, then the very next attempt goes through unconditionally", () => {
	const state = { deniedPending: false };
	const first = decideSpawnDeny(big, state);
	assert.equal(first.deny, true);
	assert.equal(first.contextChars, 200000);
	assert.equal(state.deniedPending, true);

	// Same call again immediately (model retries without a compaction ever landing,
	// e.g. maxCompactions was already reached) — must go through, not deadlock.
	const second = decideSpawnDeny(big, state);
	assert.equal(second.deny, false);
	assert.equal(second.reason, "retry_after_deny");
	assert.equal(state.deniedPending, false, "the flag clears so a later attempt can be denied afresh");

	// Context is still huge and the flag is clear again: a later attempt can be denied once more.
	const third = decideSpawnDeny(big, state);
	assert.equal(third.deny, true);
});

test("estimateContextChars is the serialized message list's length, and never throws on cycles", () => {
	assert.equal(estimateContextChars([{ role: "user", content: "hi" }]), JSON.stringify([{ role: "user", content: "hi" }]).length);
	assert.equal(estimateContextChars(undefined), 2); // "[]"
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(estimateContextChars([cyclic]), 0);
});
