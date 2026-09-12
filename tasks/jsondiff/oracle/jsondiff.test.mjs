// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diff, apply, pointer } from "./src/jsondiff.mjs";

function throwsExact(fn, ctor, prefix) {
	assert.throws(fn, (err) => err.constructor === ctor && err.message.startsWith(prefix));
}

// ---- diff: exact expected patches ----

test("diff: empty objects", () => {
	assert.deepEqual(diff({}, {}), []);
});

test("diff: equal object", () => {
	assert.deepEqual(diff({ a: 1 }, { a: 1 }), []);
});

test("diff: scalar replace on shared key", () => {
	assert.deepEqual(diff({ a: 1 }, { a: 2 }), [{ op: "replace", path: "/a", value: 2 }]);
});

test("diff: key removed and key added", () => {
	assert.deepEqual(diff({ a: 1 }, { b: 1 }), [
		{ op: "remove", path: "/a" },
		{ op: "add", path: "/b", value: 1 },
	]);
});

test("diff: remove then add ordered by a's keys then b's new keys", () => {
	assert.deepEqual(diff({ a: 1, b: 2 }, { b: 2, c: 3 }), [
		{ op: "remove", path: "/a" },
		{ op: "add", path: "/c", value: 3 },
	]);
});

test("diff: full interleave of remove, nested replace, add", () => {
	assert.deepEqual(diff({ x: 1, y: { p: 1 } }, { y: { p: 2 }, z: 3 }), [
		{ op: "remove", path: "/x" },
		{ op: "replace", path: "/y/p", value: 2 },
		{ op: "add", path: "/z", value: 3 },
	]);
});

test("diff: recurse into nested object", () => {
	assert.deepEqual(diff({ a: { x: 1 } }, { a: { x: 2 } }), [{ op: "replace", path: "/a/x", value: 2 }]);
});

test("diff: mismatched container types replace whole value", () => {
	assert.deepEqual(diff({ a: { x: 1 } }, { a: 5 }), [{ op: "replace", path: "/a", value: 5 }]);
});

test("diff: new keys added in b's insertion order", () => {
	assert.deepEqual(diff({}, { a: 1, b: 2 }), [
		{ op: "add", path: "/a", value: 1 },
		{ op: "add", path: "/b", value: 2 },
	]);
});

test("diff: equal arrays", () => {
	assert.deepEqual(diff([1, 2, 3], [1, 2, 3]), []);
});

test("diff: array element replace", () => {
	assert.deepEqual(diff([1, 2, 3], [1, 9, 3]), [{ op: "replace", path: "/1", value: 9 }]);
});

test("diff: array grows, adds appended in ascending index order", () => {
	assert.deepEqual(diff([1, 2], [1, 2, 3, 4]), [
		{ op: "add", path: "/2", value: 3 },
		{ op: "add", path: "/3", value: 4 },
	]);
});

test("diff: array shrinks, removes from highest index down", () => {
	assert.deepEqual(diff([1, 2, 3, 4], [1, 2]), [
		{ op: "remove", path: "/3" },
		{ op: "remove", path: "/2" },
	]);
});

test("diff: array with nested object add", () => {
	assert.deepEqual(diff({ a: [1, 2] }, { a: [1, 2, 3] }), [{ op: "add", path: "/a/2", value: 3 }]);
});

test("diff: array shrink then element replace, ordered correctly", () => {
	assert.deepEqual(diff([1, { x: 1 }, 3], [1, { x: 2 }]), [
		{ op: "replace", path: "/1/x", value: 2 },
		{ op: "remove", path: "/2" },
	]);
});

test("diff: top-level scalar replace uses root path", () => {
	assert.deepEqual(diff("a", "b"), [{ op: "replace", path: "", value: "b" }]);
});

test("diff: equal scalars", () => {
	assert.deepEqual(diff(1, 1), []);
	assert.deepEqual(diff(null, null), []);
});

test("diff: null vs object replaces at root", () => {
	assert.deepEqual(diff(null, {}), [{ op: "replace", path: "", value: {} }]);
});

test("diff: key containing a slash is escaped as ~1", () => {
	assert.deepEqual(diff({ "a/b": 1 }, { "a/b": 2 }), [{ op: "replace", path: "/a~1b", value: 2 }]);
});

test("diff: key containing a tilde is escaped as ~0", () => {
	assert.deepEqual(diff({ "a~b": 1 }, { "a~b": 2 }), [{ op: "replace", path: "/a~0b", value: 2 }]);
});

test("diff: -0 equals 0", () => {
	assert.deepEqual(diff({ a: -0 }, { a: 0 }), []);
});

test("diff: NaN in a throws TypeError", () => {
	throwsExact(() => diff({ a: NaN }, { a: 1 }), TypeError, "not JSON");
});

test("diff: NaN in b throws TypeError", () => {
	throwsExact(() => diff({ a: 1 }, { a: NaN }), TypeError, "not JSON");
});

// ---- diff/apply round trips ----

const roundTripPairs = [
	[{}, {}],
	[{ a: 1 }, { a: 1, b: 2 }],
	[{ a: 1, b: 2 }, { b: 3 }],
	[[], [1, 2, 3]],
	[[1, 2, 3], []],
	[{ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }],
	[{ a: { b: { c: 1, d: [1, 2] } } }, { a: { b: { c: 1, d: [1, 2, 3], e: 4 } } }],
	[5, "hello"],
];

for (const [a, b] of roundTripPairs) {
	test(`round trip: apply(a, diff(a,b)) deep-equals b for ${JSON.stringify(a)} -> ${JSON.stringify(b)}`, () => {
		assert.deepEqual(apply(a, diff(a, b)), b);
	});
}

// ---- apply: add ----

test("apply add: new object key", () => {
	assert.deepEqual(apply({}, [{ op: "add", path: "/a", value: 1 }]), { a: 1 });
});

test("apply add: overwrites existing object key", () => {
	assert.deepEqual(apply({ a: 1 }, [{ op: "add", path: "/a", value: 2 }]), { a: 2 });
});

test("apply add: inserts into array at index, shifting", () => {
	assert.deepEqual(apply({ a: [1, 2] }, [{ op: "add", path: "/a/1", value: 99 }]), { a: [1, 99, 2] });
});

test("apply add: dash appends to array", () => {
	assert.deepEqual(apply({ a: [1, 2] }, [{ op: "add", path: "/a/-", value: 3 }]), { a: [1, 2, 3] });
});

test("apply add: index beyond length throws RangeError index out of range", () => {
	throwsExact(() => apply({ a: [1, 2] }, [{ op: "add", path: "/a/5", value: 3 }]), RangeError, "index out of range");
});

test("apply add: malformed array index throws RangeError index out of range", () => {
	throwsExact(() => apply({ a: [1, 2] }, [{ op: "add", path: "/a/abc", value: 3 }]), RangeError, "index out of range");
});

test("apply add: root path replaces whole document", () => {
	assert.deepEqual(apply({ a: 1 }, [{ op: "add", path: "", value: { z: 1 } }]), { z: 1 });
});

// ---- apply: remove ----

test("apply remove: object key", () => {
	assert.deepEqual(apply({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }]), { b: 2 });
});

test("apply remove: missing key throws RangeError path not found", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "remove", path: "/missing" }]), RangeError, "path not found");
});

test("apply remove: array index shifts remaining elements", () => {
	assert.deepEqual(apply({ a: [1, 2, 3] }, [{ op: "remove", path: "/a/1" }]), { a: [1, 3] });
});

test("apply remove: out of range array index throws RangeError path not found", () => {
	throwsExact(() => apply({ a: [1, 2, 3] }, [{ op: "remove", path: "/a/9" }]), RangeError, "path not found");
});

// ---- apply: replace ----

test("apply replace: object key", () => {
	assert.deepEqual(apply({ a: 1 }, [{ op: "replace", path: "/a", value: 2 }]), { a: 2 });
});

test("apply replace: missing key throws RangeError path not found", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "replace", path: "/missing", value: 2 }]), RangeError, "path not found");
});

test("apply replace: array index in place, no shift", () => {
	assert.deepEqual(apply({ a: [1, 2, 3] }, [{ op: "replace", path: "/a/1", value: 9 }]), { a: [1, 9, 3] });
});

test("apply replace: out of range array index throws RangeError path not found", () => {
	throwsExact(() => apply({ a: [1, 2, 3] }, [{ op: "replace", path: "/a/9", value: 9 }]), RangeError, "path not found");
});

test("apply replace: root path replaces whole document", () => {
	assert.deepEqual(apply({ a: 1 }, [{ op: "replace", path: "", value: { z: 9 } }]), { z: 9 });
});

// ---- apply: move ----

test("apply move: object key to object key", () => {
	assert.deepEqual(apply({ a: 1 }, [{ op: "move", from: "/a", path: "/b" }]), { b: 1 });
});

test("apply move: array element to a later index", () => {
	assert.deepEqual(apply({ a: [1, 2, 3] }, [{ op: "move", from: "/a/0", path: "/a/2" }]), { a: [2, 3, 1] });
});

test("apply move: missing source throws RangeError path not found", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "move", from: "/missing", path: "/b" }]), RangeError, "path not found");
});

// ---- apply: copy ----

test("apply copy: object key deep-copied, source retained", () => {
	const result = apply({ a: { x: 1 } }, [{ op: "copy", from: "/a", path: "/b" }]);
	assert.deepEqual(result, { a: { x: 1 }, b: { x: 1 } });
	assert.notEqual(result.a, result.b);
});

test("apply copy: missing source throws RangeError path not found", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "copy", from: "/missing", path: "/b" }]), RangeError, "path not found");
});

// ---- apply: test ----

test("apply test: passes silently, later ops still apply", () => {
	assert.deepEqual(
		apply({ a: 1 }, [
			{ op: "test", path: "/a", value: 1 },
			{ op: "replace", path: "/a", value: 2 },
		]),
		{ a: 2 },
	);
});

test("apply test: mismatch throws plain Error test failed at <path>", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "test", path: "/a", value: 2 }]), Error, "test failed at /a");
});

test("apply test: missing path throws RangeError path not found", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "test", path: "/missing", value: 1 }]), RangeError, "path not found");
});

// ---- apply: unknown op / invalid pointer ----

test("apply: unknown op throws RangeError unknown op", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "bogus", path: "/a" }]), RangeError, "unknown op");
});

test("apply: path without leading slash throws SyntaxError invalid pointer", () => {
	throwsExact(() => apply({ a: 1 }, [{ op: "add", path: "a", value: 1 }]), SyntaxError, "invalid pointer");
});

// ---- apply: root array, sequencing, non-mutation ----

test("apply: dash append on root array", () => {
	assert.deepEqual(apply([1, 2, 3], [{ op: "add", path: "/-", value: 4 }]), [1, 2, 3, 4]);
});

test("apply: remove first element of root array", () => {
	assert.deepEqual(apply([1, 2, 3], [{ op: "remove", path: "/0" }]), [2, 3]);
});

test("apply: multiple ops applied in sequence", () => {
	assert.deepEqual(
		apply({ a: 1, b: 2 }, [
			{ op: "remove", path: "/a" },
			{ op: "add", path: "/c", value: 3 },
			{ op: "replace", path: "/b", value: 20 },
		]),
		{ b: 20, c: 3 },
	);
});

test("apply: does not mutate the input document", () => {
	const doc = { a: [1, 2, { b: 3 }] };
	const snapshot = structuredClone(doc);
	const result = apply(doc, [{ op: "replace", path: "/a/2/b", value: 99 }]);
	assert.deepEqual(doc, snapshot);
	assert.equal(result.a[2].b, 99);
});

// ---- pointer ----

test("pointer: empty string is root", () => {
	assert.deepEqual(pointer(""), []);
});

test("pointer: single slash is one empty token", () => {
	assert.deepEqual(pointer("/"), [""]);
});

test("pointer: single token", () => {
	assert.deepEqual(pointer("/a"), ["a"]);
});

test("pointer: multiple tokens", () => {
	assert.deepEqual(pointer("/a/b"), ["a", "b"]);
});

test("pointer: decodes ~1 to /", () => {
	assert.deepEqual(pointer("/a~1b"), ["a/b"]);
});

test("pointer: decodes ~0 to ~", () => {
	assert.deepEqual(pointer("/a~0b"), ["a~b"]);
});

test("pointer: decodes ~1 before ~0", () => {
	assert.deepEqual(pointer("/a~01"), ["a~1"]);
});

test("pointer: non-string path throws SyntaxError", () => {
	throwsExact(() => pointer(42), SyntaxError, "invalid pointer");
});

test("pointer: non-empty string without leading slash throws SyntaxError", () => {
	throwsExact(() => pointer("a"), SyntaxError, "invalid pointer");
});
