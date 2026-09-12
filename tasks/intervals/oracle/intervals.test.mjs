// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, union, intersect, subtract, contains, insert, gaps, measure } from "./src/intervals.mjs";

const deepCases = [
	// normalize
	["normalize sorts and merges", () => normalize([[3, 4], [1, 2], [2, 3]]), [[1, 4]]],
	["normalize dedupes exact duplicates", () => normalize([[1, 2], [1, 2]]), [[1, 2]]],
	["normalize empty stays empty", () => normalize([]), []],
	["normalize keeps a lone point", () => normalize([[5, 5]]), [[5, 5]]],
	["normalize absorbs a nested point", () => normalize([[1, 3], [2, 2]]), [[1, 3]]],
	["normalize merges touching negatives", () => normalize([[-5, -2], [-2, 0]]), [[-5, 0]]],
	["normalize keeps a real gap separate", () => normalize([[1, 2], [3, 4]]), [[1, 2], [3, 4]]],
	["normalize merges touching floats", () => normalize([[1.5, 2.5], [2.5, 3.5]]), [[1.5, 3.5]]],
	// union
	["union merges across sets", () => union([[0, 2]], [[1, 3], [5, 6]]), [[0, 3], [5, 6]]],
	["union of two empties", () => union([], []), []],
	["union merges touching across sets", () => union([[0, 1]], [[1, 2]]), [[0, 2]]],
	["union keeps disjoint separate", () => union([[0, 1]], [[2, 3]]), [[0, 1], [2, 3]]],
	// intersect
	["intersect partial overlap", () => intersect([[0, 4]], [[2, 6]]), [[2, 4]]],
	["intersect disjoint is empty", () => intersect([[0, 2]], [[3, 4]]), []],
	["intersect touching boundary is a point", () => intersect([[0, 2]], [[2, 4]]), [[2, 2]]],
	["intersect against multiple pieces", () => intersect([[0, 10]], [[2, 3], [5, 6]]), [[2, 3], [5, 6]]],
	["intersect identical sets", () => intersect([[0, 5]], [[0, 5]]), [[0, 5]]],
	// subtract
	["subtract interior cut keeps both edges", () => subtract([[0, 10]], [[3, 5]]), [[0, 3], [5, 10]]],
	["subtract exact full cover empties", () => subtract([[0, 5]], [[0, 5]]), []],
	["subtract a point from the middle", () => subtract([[0, 5]], [[2, 2]]), [[0, 2], [2, 5]]],
	["subtract two pieces", () => subtract([[0, 10]], [[2, 4], [6, 8]]), [[0, 2], [4, 6], [8, 10]]],
	["subtract nothing", () => subtract([[0, 10]], []), [[0, 10]]],
	["subtract disjoint has no effect", () => subtract([[0, 10]], [[20, 30]]), [[0, 10]]],
	["subtract a wider cover empties", () => subtract([[0, 10]], [[-5, 15]]), []],
	["subtract spanning multiple a-intervals", () => subtract([[0, 3], [5, 8]], [[1, 6]]), [[0, 1], [6, 8]]],
	// insert
	["insert bridges a gap", () => insert([[0, 1], [5, 6]], [1, 5]), [[0, 6]]],
	["insert into an empty set", () => insert([], [2, 3]), [[2, 3]]],
	["insert merges on touch", () => insert([[0, 1]], [1, 2]), [[0, 2]]],
	// gaps
	["gaps basic complement", () => gaps([[2, 4], [6, 8]], 0, 10), [[0, 2], [4, 6], [8, 10]]],
	["gaps of full coverage is empty", () => gaps([[0, 10]], 0, 10), []],
	["gaps of no coverage is the whole range", () => gaps([], 0, 10), [[0, 10]]],
	["gaps with bounds equal to set", () => gaps([[2, 4]], 2, 4), []],
	["gaps clips a wider set", () => gaps([[-5, 20]], 0, 10), []],
];

for (const [desc, run, expected] of deepCases) {
	test(desc, () => {
		assert.deepEqual(run(), expected);
	});
}

// contains
test("contains true at left endpoint", () => assert.equal(contains([[0, 2], [5, 7]], 0), true));
test("contains true at right endpoint", () => assert.equal(contains([[0, 2], [5, 7]], 7), true));
test("contains true at interior point", () => assert.equal(contains([[0, 2], [5, 7]], 2), true));
test("contains false in the gap", () => assert.equal(contains([[0, 2], [5, 7]], 3), false));
test("contains works on unsorted input", () => assert.equal(contains([[5, 7], [0, 2]], 6), true));
test("contains true for a matching point interval", () => assert.equal(contains([[1, 1]], 1), true));
test("contains false on empty set", () => assert.equal(contains([], 5), false));
test("contains is false for NaN", () => assert.equal(contains([[0, 10]], NaN), false));

// measure
test("measure sums lengths, points count as zero", () => assert.equal(measure([[0, 2], [5, 5], [7, 10]]), 5));
test("measure of empty set is zero", () => assert.equal(measure([]), 0));
test("measure merges before summing", () => assert.equal(measure([[1, 2], [2, 4]]), 3));

// error contract: TypeError "set must be an array"
test("normalize rejects non-array", () => {
	assert.throws(() => normalize("nope"), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("union rejects non-array first arg", () => {
	assert.throws(() => union(null, []), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("union rejects non-array second arg", () => {
	assert.throws(() => union([], {}), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("intersect rejects non-array", () => {
	assert.throws(() => intersect([], 42), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("subtract rejects non-array", () => {
	assert.throws(() => subtract(undefined, []), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("contains rejects non-array", () => {
	assert.throws(() => contains("x", 1), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("insert rejects non-array set", () => {
	assert.throws(() => insert(5, [0, 1]), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});
test("gaps rejects non-array set (checked before bounds)", () => {
	assert.throws(() => gaps("nope", 5, 1), (err) => err instanceof TypeError && /^set must be an array/.test(err.message));
});

// error contract: RangeError "invalid interval"
const badIntervals = [
	"x",
	[1],
	[1, 2, 3],
	[2, 1],
	[1, NaN],
	[-Infinity, 1],
];
for (const bad of badIntervals) {
	test(`normalize rejects invalid interval ${JSON.stringify(bad)}`, () => {
		assert.throws(() => normalize([bad]), (err) => err instanceof RangeError && /^invalid interval/.test(err.message));
	});
}
test("subtract rejects an invalid interval buried in b, even if far from a", () => {
	assert.throws(() => subtract([[0, 1]], [[100, 90]]), (err) => err instanceof RangeError && /^invalid interval/.test(err.message));
});
test("insert rejects an invalid standalone interval", () => {
	assert.throws(() => insert([[0, 1]], [2, 1]), (err) => err instanceof RangeError && /^invalid interval/.test(err.message));
});
test("insert rejects a malformed standalone interval", () => {
	assert.throws(() => insert([[0, 1]], "nope"), (err) => err instanceof RangeError && /^invalid interval/.test(err.message));
});

// error contract: RangeError "invalid bounds"
test("gaps rejects lo > hi", () => {
	assert.throws(() => gaps([[0, 1]], 5, 1), (err) => err instanceof RangeError && /^invalid bounds/.test(err.message));
});
test("gaps rejects a non-finite bound", () => {
	assert.throws(() => gaps([[0, 1]], 0, Infinity), (err) => err instanceof RangeError && /^invalid bounds/.test(err.message));
});
test("gaps rejects NaN bounds", () => {
	assert.throws(() => gaps([[0, 1]], NaN, 5), (err) => err instanceof RangeError && /^invalid bounds/.test(err.message));
});
test("gaps checks bounds before interval validity", () => {
	assert.throws(() => gaps([[2, "x"]], 5, 1), (err) => err instanceof RangeError && /^invalid bounds/.test(err.message));
});

// non-mutation
test("normalize does not mutate its input", () => {
	const input = [[3, 4], [1, 2]];
	const snapshot = [[3, 4], [1, 2]];
	const result = normalize(input);
	result[0][0] = -999;
	result.push([100, 101]);
	assert.deepEqual(input, snapshot);
});
test("union does not mutate either input", () => {
	const a = [[0, 1]];
	const b = [[2, 3]];
	const result = union(a, b);
	result[0][1] = 999;
	assert.deepEqual(a, [[0, 1]]);
	assert.deepEqual(b, [[2, 3]]);
});
test("intersect does not mutate either input", () => {
	const a = [[0, 5]];
	const b = [[2, 8]];
	const result = intersect(a, b);
	result[0][0] = -1;
	assert.deepEqual(a, [[0, 5]]);
	assert.deepEqual(b, [[2, 8]]);
});
test("subtract does not mutate either input", () => {
	const a = [[0, 10]];
	const b = [[3, 5]];
	const result = subtract(a, b);
	result[0][1] = -1;
	result[1][0] = -1;
	assert.deepEqual(a, [[0, 10]]);
	assert.deepEqual(b, [[3, 5]]);
});
test("insert does not mutate its set input or the interval argument", () => {
	const set = [[0, 1]];
	const interval = [5, 6];
	const result = insert(set, interval);
	result[0][1] = 999;
	assert.deepEqual(set, [[0, 1]]);
	assert.deepEqual(interval, [5, 6]);
});
