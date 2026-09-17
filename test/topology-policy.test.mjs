import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, noteToolCall, decideSpawn, CHECKED_ARTIFACTS } from "../lib/policies/topology-policy.mjs";

const NEEDS = { tester: ["api"], implementer: ["api", "tests"] };
const spawn = (subagent_type, extra = {}) => ({ subagent_type, description: "d", prompt: "Do the thing.", ...extra });

test("only tests is guard-checked; a specialist with no checked need always passes", () => {
	assert.deepEqual(CHECKED_ARTIFACTS, ["tests"]);
	const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("tester"), state: initialState(), testsFiles: [] });
	assert.deepEqual(d, { ok: true, event: null });
	const unknown = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("scout"), state: initialState(), testsFiles: [] });
	assert.deepEqual(unknown, { ok: true, event: null });
});

test("a resume is never judged", () => {
	const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { resume: "abc" }), state: initialState(), testsFiles: [] });
	assert.deepEqual(d, { ok: true, event: null });
});

test("missing tests: enforce denies every time with the tester-first reason", () => {
	const state = initialState();
	for (let i = 0; i < 2; i++) {
		const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
		assert.equal(d.ok, false);
		assert.equal(d.event, "denied");
		assert.equal(d.failed, "tests:missing");
		assert.match(d.reason, /^topology: implementer needs tests, and src\/__tests__\/ has none\. Spawn the tester first/);
		assert.match(d.reason, /"topology: skip — <reason>"/);
	}
});

test("missing tests: nudge denies once per specialist, then waives", () => {
	const state = initialState();
	const first = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.equal(first.ok, false);
	assert.equal(first.event, "denied");
	const second = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.deepEqual(second, { ok: true, event: "waived", failed: "tests:missing" });
});

test("nudge: a tests:missing denial does not spend the tests:unread nudge", () => {
	const state = initialState();
	const missing = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.equal(missing.event, "denied");
	assert.equal(missing.failed, "tests:missing");
	const missingWaived = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.equal(missingWaived.event, "waived");
	const testsFiles = [{ mtimeMs: 5000 }];
	const unread = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.equal(unread.ok, false);
	assert.equal(unread.event, "denied");
	assert.equal(unread.failed, "tests:unread");
	const unreadWaived = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.equal(unreadWaived.event, "waived");
	assert.equal(unreadWaived.failed, "tests:unread");
});

test("tests exist but were not read since written: denied with the read reason; a later read satisfies it", () => {
	const state = initialState();
	const testsFiles = [{ mtimeMs: 1000 }, { mtimeMs: 5000 }];
	noteToolCall({ toolName: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, state, 2000);
	const stale = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.equal(stale.ok, false);
	assert.equal(stale.failed, "tests:unread");
	assert.match(stale.reason, /tests exist but you have not read them since they were written/);
	noteToolCall({ toolName: "bash", input: { command: "cat src/__tests__/pathnorm.test.mjs" } }, state, 6000);
	const fresh = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.deepEqual(fresh, { ok: true, event: null });
});

test("noteToolCall ignores reads elsewhere and tools it does not know", () => {
	const state = initialState();
	noteToolCall({ toolName: "read", input: { path: "src/pathnorm.mjs" } }, state, 100);
	noteToolCall({ toolName: "write", input: { path: "src/__tests__/x.test.mjs" } }, state, 200);
	assert.equal(state.lastTestsRead, 0);
	noteToolCall({ toolName: "ls", input: { path: "src/__tests__" } }, state, 300);
	assert.equal(state.lastTestsRead, 300);
});

test("a skip line as the first prompt line passes and is reported with its reason, in both modes", () => {
	for (const mode of ["nudge", "enforce"]) {
		const d = decideSpawn({
			mode,
			needsFor: NEEDS,
			input: spawn("implementer", { prompt: "topology: skip — spec is a one-liner, tests would be the implementation\nImplement it." }),
			state: initialState(),
			testsFiles: [],
		});
		assert.deepEqual(d, { ok: true, event: "skipped", reason: "spec is a one-liner, tests would be the implementation" });
	}
	const hyphen = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { prompt: "topology: skip - no tests apply" }), state: initialState(), testsFiles: [] });
	assert.equal(hyphen.event, "skipped");
	const notFirstLine = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { prompt: "Implement.\ntopology: skip — late" }), state: initialState(), testsFiles: [] });
	assert.equal(notFirstLine.ok, false);
});
