// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { topoSort, layers, findCycle } from "./src/toposort.mjs";

// ---- topoSort ----

test("topoSort: empty graph", () => {
	assert.deepEqual(topoSort([], []), []);
});

test("topoSort: single node, no edges", () => {
	assert.deepEqual(topoSort(["a"], []), ["a"]);
});

test("topoSort: two nodes, no edge, already sorted", () => {
	assert.deepEqual(topoSort(["a", "b"], []), ["a", "b"]);
});

test("topoSort: two nodes, no edge, reversed input order", () => {
	assert.deepEqual(topoSort(["b", "a"], []), ["a", "b"]);
});

test("topoSort: simple chain a->b", () => {
	assert.deepEqual(topoSort(["b", "a"], [["a", "b"]]), ["a", "b"]);
});

test("topoSort: three-node chain", () => {
	assert.deepEqual(topoSort(["c", "b", "a"], [["a", "b"], ["b", "c"]]), ["a", "b", "c"]);
});

test("topoSort: diamond a->b,a->c,b->d,c->d", () => {
	assert.deepEqual(
		topoSort(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]),
		["a", "b", "c", "d"],
	);
});

test("topoSort: pure tie-break, no edges at all, scrambled input", () => {
	assert.deepEqual(topoSort(["e", "c", "a", "d", "b"], []), ["a", "b", "c", "d", "e"]);
});

test("topoSort: isolated node interleaved with a chain", () => {
	assert.deepEqual(topoSort(["z", "a", "b"], [["a", "b"]]), ["a", "b", "z"]);
});

test("topoSort: disconnected components", () => {
	assert.deepEqual(
		topoSort(["c", "a", "d", "b"], [["a", "b"], ["c", "d"]]),
		["a", "b", "c", "d"],
	);
});

test("topoSort: duplicate edges are ignored, not double-counted", () => {
	assert.deepEqual(topoSort(["a", "b"], [["a", "b"], ["a", "b"]]), ["a", "b"]);
});

test("topoSort: duplicate edges do not stall an otherwise-ready node", () => {
	assert.deepEqual(
		topoSort(["a", "b", "c"], [["a", "b"], ["a", "b"], ["a", "b"], ["a", "c"]]),
		["a", "b", "c"],
	);
});

// ---- layers ----

test("layers: empty graph", () => {
	assert.deepEqual(layers([], []), []);
});

test("layers: single isolated node", () => {
	assert.deepEqual(layers(["a"], []), [["a"]]);
});

test("layers: chain a->b->c", () => {
	assert.deepEqual(layers(["a", "b", "c"], [["a", "b"], ["b", "c"]]), [["a"], ["b"], ["c"]]);
});

test("layers: two sources into one sink", () => {
	assert.deepEqual(layers(["a", "b", "c"], [["a", "c"], ["b", "c"]]), [["a", "b"], ["c"]]);
});

test("layers: diamond has three layers", () => {
	assert.deepEqual(
		layers(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]),
		[["a"], ["b", "c"], ["d"]],
	);
});

test("layers: mixed depths across disconnected pieces", () => {
	assert.deepEqual(
		layers(["a", "b", "c", "d", "e"], [["a", "c"], ["b", "c"], ["c", "d"], ["e", "d"]]),
		[["a", "b", "e"], ["c"], ["d"]],
	);
});

test("layers: fully disconnected nodes all land in layer 0", () => {
	assert.deepEqual(layers(["c", "a", "b"], []), [["a", "b", "c"]]);
});

test("layers: duplicate edges do not inflate a node's required layer", () => {
	assert.deepEqual(
		layers(["a", "b"], [["a", "b"], ["a", "b"]]),
		[["a"], ["b"]],
	);
});

// ---- findCycle: acyclic ----

test("findCycle: empty graph is acyclic", () => {
	assert.equal(findCycle([], []), null);
});

test("findCycle: no edges is acyclic", () => {
	assert.equal(findCycle(["a", "b", "c"], []), null);
});

test("findCycle: chain is acyclic", () => {
	assert.equal(findCycle(["a", "b", "c"], [["a", "b"], ["b", "c"]]), null);
});

test("findCycle: diamond is acyclic", () => {
	assert.equal(
		findCycle(["a", "b", "c", "d"], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]),
		null,
	);
});

// ---- findCycle: cyclic ----

test("findCycle: self-edge", () => {
	assert.deepEqual(findCycle(["a"], [["a", "a"]]), ["a", "a"]);
});

test("findCycle: self-edge alongside unrelated edges", () => {
	assert.deepEqual(findCycle(["a", "b"], [["a", "b"], ["b", "b"]]), ["b", "b"]);
});

test("findCycle: simple 2-cycle", () => {
	assert.deepEqual(findCycle(["a", "b"], [["a", "b"], ["b", "a"]]), ["a", "b", "a"]);
});

test("findCycle: simple 3-cycle", () => {
	assert.deepEqual(
		findCycle(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]),
		["a", "b", "c", "a"],
	);
});

test("findCycle: 3-cycle listed starting mid-cycle still rotates to smallest", () => {
	assert.deepEqual(
		findCycle(["a", "b", "c"], [["b", "c"], ["c", "a"], ["a", "b"]]),
		["a", "b", "c", "a"],
	);
});

test("findCycle: isolated node unrelated to the only cycle", () => {
	assert.deepEqual(findCycle(["a", "x", "y"], [["x", "y"], ["y", "x"]]), ["x", "y", "x"]);
});

test("findCycle: two disjoint 2-cycles report the one reached first", () => {
	assert.deepEqual(
		findCycle(["a", "b", "c", "d"], [["a", "b"], ["b", "a"], ["c", "d"], ["d", "c"]]),
		["a", "b", "a"],
	);
});

test("findCycle: overlapping cycles sharing a node pick the lexicographically-first neighbor", () => {
	assert.deepEqual(
		findCycle(["a", "b", "c"], [["a", "b"], ["b", "a"], ["b", "c"], ["c", "b"]]),
		["a", "b", "a"],
	);
});

test("findCycle: a node leading into a cycle is excluded, and result is rotated", () => {
	assert.deepEqual(
		findCycle(["a", "b", "c", "d"], [["a", "d"], ["d", "b"], ["b", "c"], ["c", "d"]]),
		["b", "c", "d", "b"],
	);
});

test("findCycle: duplicate edges do not change the reported cycle", () => {
	assert.deepEqual(
		findCycle(["a", "b"], [["a", "b"], ["a", "b"], ["b", "a"]]),
		["a", "b", "a"],
	);
});

// ---- cycle errors from topoSort / layers ----

test("topoSort: throws on a 2-cycle with exact message", () => {
	assert.throws(
		() => topoSort(["a", "b"], [["a", "b"], ["b", "a"]]),
		(err) => err instanceof Error && err.message === "cycle: a -> b -> a",
	);
});

test("layers: throws on a 2-cycle with exact message", () => {
	assert.throws(
		() => layers(["a", "b"], [["a", "b"], ["b", "a"]]),
		(err) => err instanceof Error && err.message === "cycle: a -> b -> a",
	);
});

test("topoSort: throws on a 3-cycle with exact message", () => {
	assert.throws(
		() => topoSort(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]),
		(err) => err instanceof Error && err.message === "cycle: a -> b -> c -> a",
	);
});

test("layers: throws on a self-edge with exact message", () => {
	assert.throws(
		() => layers(["a"], [["a", "a"]]),
		(err) => err instanceof Error && err.message === "cycle: a -> a",
	);
});

test("topoSort: a self-edge blocks the whole graph even with a free node", () => {
	assert.throws(
		() => topoSort(["a", "b"], [["a", "b"], ["b", "b"]]),
		(err) => err instanceof Error && err.message === "cycle: b -> b",
	);
});

test("layers: an acyclic prefix does not mask a later cycle", () => {
	assert.throws(
		() => layers(["a", "b", "c", "d"], [["a", "b"], ["c", "d"], ["d", "c"]]),
		(err) => err instanceof Error && /^cycle: /.test(err.message),
	);
});

// ---- validation errors, shared across all three functions ----

test("topoSort: non-string node throws TypeError", () => {
	assert.throws(
		() => topoSort(["a", 5, "c"], []),
		(err) => err instanceof TypeError && /^node must be a string/.test(err.message),
	);
});

test("layers: non-string node throws TypeError", () => {
	assert.throws(
		() => layers([true, "a"], []),
		(err) => err instanceof TypeError && /^node must be a string/.test(err.message),
	);
});

test("findCycle: non-string node throws TypeError", () => {
	assert.throws(
		() => findCycle(["a", null], []),
		(err) => err instanceof TypeError && /^node must be a string/.test(err.message),
	);
});

test("topoSort: type check fires before a later duplicate is ever seen", () => {
	assert.throws(
		() => topoSort(["a", 5, "a"], []),
		(err) => err instanceof TypeError && /^node must be a string/.test(err.message),
	);
});

test("topoSort: duplicate node throws RangeError", () => {
	assert.throws(
		() => topoSort(["a", "b", "a"], []),
		(err) => err instanceof RangeError && /^duplicate node: a/.test(err.message),
	);
});

test("layers: duplicate node throws RangeError", () => {
	assert.throws(
		() => layers(["x", "x"], []),
		(err) => err instanceof RangeError && /^duplicate node: x/.test(err.message),
	);
});

test("findCycle: duplicate node throws RangeError", () => {
	assert.throws(
		() => findCycle(["x", "y", "x"], []),
		(err) => err instanceof RangeError && /^duplicate node: x/.test(err.message),
	);
});

test("topoSort: unknown node in edge 'to' position throws RangeError", () => {
	assert.throws(
		() => topoSort(["a", "b"], [["a", "c"]]),
		(err) => err instanceof RangeError && /^unknown node: c/.test(err.message),
	);
});

test("topoSort: unknown node in edge 'from' position throws RangeError", () => {
	assert.throws(
		() => topoSort(["a"], [["x", "a"]]),
		(err) => err instanceof RangeError && /^unknown node: x/.test(err.message),
	);
});

test("layers: unknown node throws RangeError", () => {
	assert.throws(
		() => layers(["a", "b"], [["a", "b"], ["b", "z"]]),
		(err) => err instanceof RangeError && /^unknown node: z/.test(err.message),
	);
});

test("findCycle: unknown node throws RangeError", () => {
	assert.throws(
		() => findCycle(["a", "b"], [["b", "q"]]),
		(err) => err instanceof RangeError && /^unknown node: q/.test(err.message),
	);
});

test("topoSort: from-position is checked before to-position on the same bad edge", () => {
	assert.throws(
		() => topoSort(["a"], [["x", "y"]]),
		(err) => err instanceof RangeError && /^unknown node: x/.test(err.message),
	);
});
