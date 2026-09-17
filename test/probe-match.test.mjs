import { test } from "node:test";
import assert from "node:assert/strict";
import { argsKey, canonicalJson, deepDiff, isThrowsExpectation, matchCase } from "../lib/probe-match.mjs";

test("canonicalJson sorts keys at every level and keeps array order", () => {
	assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
	assert.equal(canonicalJson([2, 1]), "[2,1]");
	assert.equal(canonicalJson("x"), '"x"');
});

test("argsKey: reordered keys are the same case; different values are not", () => {
	const a = argsKey([{ hp: 1500, atk: 130, def: 90 }, 2]);
	const b = argsKey([{ def: 90, atk: 130, hp: 1500 }, 2]);
	assert.equal(a, b);
	assert.notEqual(a, argsKey([{ hp: 1501, atk: 130, def: 90 }, 2]));
	assert.equal(argsKey(undefined), null);
});

test("deepDiff is order-insensitive and compares only the keys the expectation names", () => {
	assert.equal(deepDiff({ level: 2, xp: 0, stats: { hp: 1560, atk: 135 } }, { stats: { atk: 135, hp: 1560 }, xp: 0, level: 2 }), null);
	assert.equal(deepDiff({ level: 2, xp: 0, hp: 1560, extra: true }, { level: 2, hp: 1560 }), null);
	assert.equal(deepDiff({ level: 2 }, { level: 3 }), "$.level: expected 3, got 2");
	assert.equal(deepDiff({ a: [1, 2] }, { a: [1, 2, 3] }), "$.a: length 2 != 3");
	assert.equal(deepDiff({ a: 1 }, { b: 1 }), "$.b: missing");
	assert.equal(deepDiff([0.1 + 0.2], [0.3]), "$[0]: expected 0.3, got 0.30000000000000004");
});

test("matchCase trusts the probe runner's verdict when it gives one", () => {
	assert.deepEqual(matchCase({ id: "a", ok: true, value: { x: 1 }, match: true }, { x: 999 }), { matched: true, detail: null });
	assert.deepEqual(matchCase({ id: "a", ok: true, value: { x: 1 }, match: false, diff: "$.x: |1 - 2| = 1 > 1e-9" }, { x: 1 }), { matched: false, detail: "$.x: |1 - 2| = 1 > 1e-9" });
});

test("matchCase falls back to deepDiff without a runner verdict", () => {
	assert.deepEqual(matchCase({ id: "a", ok: true, value: { hp: 1560, atk: 135 } }, { atk: 135, hp: 1560 }), { matched: true, detail: null });
	assert.deepEqual(matchCase({ id: "a", ok: true, value: { hp: 1560 } }, { hp: 1561 }), { matched: false, detail: "$.hp: expected 1561, got 1560" });
	assert.deepEqual(matchCase({ id: "a", ok: true, value: [1, 2] }, [1, 2]), { matched: true, detail: null });
});

test("matchCase handles throws expectations and unexpected throws", () => {
	assert.deepEqual(matchCase({ id: "a", ok: false, error: "TypeError: invalid argument: seed" }, { throws: "invalid argument" }), { matched: true, detail: null });
	assert.equal(matchCase({ id: "a", ok: false, error: "RangeError: singularity" }, { throws: "invalid argument" }).matched, false);
	assert.equal(matchCase({ id: "a", ok: true, value: 1 }, { throws: "invalid argument" }).matched, false);
	assert.deepEqual(matchCase({ id: "a", ok: false, error: "TypeError: x" }, 5), { matched: false, detail: "threw instead of returning" });
});

// Case 11 of docs/batch/harness-text-audit-2026-09-17.md: a throws expectation matches on
// the error text merely containing what was named, so "matched" hides the message that
// was usually the point of the case. The supervisor prints the actual error for exactly
// these cases; this is the predicate it selects them with.
test("isThrowsExpectation picks out the throws shape and nothing else", () => {
	assert.equal(isThrowsExpectation({ throws: "SyntaxError" }), true);
	assert.equal(isThrowsExpectation({ throws: "" }), true);
	assert.equal(isThrowsExpectation({ value: 1 }), false);
	assert.equal(isThrowsExpectation(["throws"]), false);
	assert.equal(isThrowsExpectation("throws"), false);
	assert.equal(isThrowsExpectation(null), false);
	assert.equal(isThrowsExpectation(undefined), false);
	// The predicate and matchCase's own branch must agree on every shape.
	for (const expect of [{ throws: "x" }, { value: 1 }, 5, null, ["x"]]) {
		const res = { id: "a", ok: false, error: "TypeError: x" };
		assert.equal(matchCase(res, expect).detail === "threw instead of returning", !isThrowsExpectation(expect), JSON.stringify(expect));
	}
});
