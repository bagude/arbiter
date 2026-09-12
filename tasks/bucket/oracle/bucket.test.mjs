// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBucket } from "./src/bucket.mjs";

function close(actual, expected, tol = 1e-6) {
	assert.ok(
		Number.isFinite(actual) === Number.isFinite(expected) && Math.abs(actual - expected) <= tol,
		`expected ${actual} to be within ${tol} of ${expected}`,
	);
}

function assertRangeError(fn, prefix) {
	assert.throws(fn, (err) => {
		assert.ok(err instanceof RangeError, `expected RangeError, got ${err}`);
		assert.ok(err.message.startsWith(prefix), `expected message to start with ${JSON.stringify(prefix)}, got ${JSON.stringify(err.message)}`);
		return true;
	});
}

// --- construction validation --------------------------------------------

test("rejects zero capacity", () => {
	assertRangeError(() => createBucket({ capacity: 0, refillPerSecond: 1 }), "invalid capacity");
});

test("rejects negative capacity", () => {
	assertRangeError(() => createBucket({ capacity: -5, refillPerSecond: 1 }), "invalid capacity");
});

test("rejects NaN capacity", () => {
	assertRangeError(() => createBucket({ capacity: NaN, refillPerSecond: 1 }), "invalid capacity");
});

test("rejects infinite capacity", () => {
	assertRangeError(() => createBucket({ capacity: Infinity, refillPerSecond: 1 }), "invalid capacity");
});

test("rejects non-numeric capacity", () => {
	assertRangeError(() => createBucket({ capacity: "5", refillPerSecond: 1 }), "invalid capacity");
});

test("rejects negative refillPerSecond", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: -1 }), "invalid refill");
});

test("rejects NaN refillPerSecond", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: NaN }), "invalid refill");
});

test("rejects infinite refillPerSecond", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: Infinity }), "invalid refill");
});

test("rejects non-numeric refillPerSecond", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: "1" }), "invalid refill");
});

test("rejects negative initial", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: 1, initial: -1 }), "invalid initial");
});

test("rejects initial above capacity", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: 1, initial: 6 }), "invalid initial");
});

test("rejects NaN initial", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: 1, initial: NaN }), "invalid initial");
});

test("rejects non-numeric initial", () => {
	assertRangeError(() => createBucket({ capacity: 5, refillPerSecond: 1, initial: "0" }), "invalid initial");
});

test("initial defaults to capacity", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 0 });
	assert.equal(b.available(0), 3);
});

test("accepts initial of exactly capacity", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1, initial: 3 });
	assert.equal(b.available(0), 3);
});

// --- basic take: burst then deny ----------------------------------------

test("burst consumes down to zero then denies", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0 });
	assert.equal(b.take(5, 0), true);
	assert.equal(b.take(1, 0), false);
});

test("take defaults n to 1", () => {
	const b = createBucket({ capacity: 1, refillPerSecond: 0 });
	assert.equal(b.take(undefined, 0), true);
	assert.equal(b.take(undefined, 0), false);
});

test("take leaves tokens unchanged on failure", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0, initial: 2 });
	assert.equal(b.take(3.5, 0), false);
	assert.equal(b.available(0), 2);
});

test("take with n greater than capacity returns false without throwing", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assert.equal(b.take(4, 0), false);
});

// --- refill over time -----------------------------------------------------

test("refill accrues linearly with elapsed time", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 1, initial: 0 });
	b.available(0);
	close(b.available(2000), 2);
});

test("refill then take succeeds once enough time passes", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 1 });
	assert.equal(b.take(5, 0), true);
	assert.equal(b.take(2, 2000), true);
	assert.equal(b.take(1, 2000), false);
});

test("refill caps at capacity", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 1, initial: 0 });
	b.available(0);
	close(b.available(1_000_000), 5);
});

test("no refill when refillPerSecond is 0", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0, initial: 2 });
	assert.equal(b.available(10_000), 2);
});

test("fractional refill rate", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0.5, initial: 0 });
	b.available(0);
	close(b.available(500), 0.25);
});

test("refill resumes correctly across multiple calls", () => {
	const b = createBucket({ capacity: 10, refillPerSecond: 2, initial: 0 });
	b.available(0);
	close(b.available(1000), 2);
	close(b.available(3000), 6);
	close(b.available(3500), 7);
});

// --- timeUntil --------------------------------------------------------

test("timeUntil is 0 when tokens already available", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 1, initial: 3 });
	assert.equal(b.timeUntil(2, 0), 0);
});

test("timeUntil computes exact wait for missing tokens", () => {
	const b = createBucket({ capacity: 10, refillPerSecond: 2, initial: 0 });
	close(b.timeUntil(5, 0), 2500);
});

test("timeUntil reflects tokens already refilled by atMs", () => {
	const b = createBucket({ capacity: 10, refillPerSecond: 2, initial: 0 });
	b.available(0);
	close(b.timeUntil(5, 1000), 1500);
});

test("timeUntil is Infinity when n exceeds capacity", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 5, initial: 0 });
	assert.equal(b.timeUntil(4, 0), Infinity);
});

test("timeUntil is Infinity when refillPerSecond is 0 and tokens insufficient", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0, initial: 1 });
	assert.equal(b.timeUntil(2, 0), Infinity);
});

test("timeUntil of exactly capacity from empty", () => {
	const b = createBucket({ capacity: 4, refillPerSecond: 1, initial: 0 });
	close(b.timeUntil(4, 0), 4000);
});

test("timeUntil after a take reflects reduced tokens", () => {
	const b = createBucket({ capacity: 4, refillPerSecond: 2, initial: 4 });
	assert.equal(b.take(4, 0), true);
	close(b.timeUntil(1, 0), 500);
});

// --- reset ---------------------------------------------------------------

test("reset refills to capacity", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 0, initial: 0 });
	b.reset(0);
	assert.equal(b.available(0), 5);
});

test("reset after depletion allows a fresh burst", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 0 });
	assert.equal(b.take(3, 0), true);
	b.reset(100);
	assert.equal(b.take(3, 100), true);
});

test("reset respects the non-decreasing time rule", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	b.available(500);
	assertRangeError(() => b.reset(100), "time went backwards");
});

// --- backwards time --------------------------------------------------

test("first call may use any atMs, including negative", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assert.equal(b.available(-1000), 3);
});

test("equal timestamps across calls are allowed", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1, initial: 0 });
	b.available(1000);
	assert.equal(b.available(1000), 0);
});

test("take throws when time goes backwards", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	b.available(1000);
	assertRangeError(() => b.take(1, 500), "time went backwards");
});

test("available throws when time goes backwards", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	b.take(1, 1000);
	assertRangeError(() => b.available(999), "time went backwards");
});

test("timeUntil throws when time goes backwards", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	b.available(1000);
	assertRangeError(() => b.timeUntil(1, 0), "time went backwards");
});

// --- invalid amount --------------------------------------------------

test("take rejects zero amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.take(0, 0), "invalid amount");
});

test("take rejects negative amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.take(-1, 0), "invalid amount");
});

test("take rejects NaN amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.take(NaN, 0), "invalid amount");
});

test("take rejects infinite amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.take(Infinity, 0), "invalid amount");
});

test("take rejects non-numeric amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.take("1", 0), "invalid amount");
});

test("timeUntil rejects zero amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.timeUntil(0, 0), "invalid amount");
});

test("timeUntil rejects negative amount", () => {
	const b = createBucket({ capacity: 3, refillPerSecond: 1 });
	assertRangeError(() => b.timeUntil(-2, 0), "invalid amount");
});

// --- floating point tolerance ------------------------------------------

test("take succeeds when available is within 1e-9 of the requested amount", () => {
	const b = createBucket({ capacity: 1, refillPerSecond: 0, initial: 0.9999999999 });
	assert.equal(b.take(1, 0), true);
});

test("timeUntil returns 0 when available is within 1e-9 of the requested amount", () => {
	const b = createBucket({ capacity: 1, refillPerSecond: 0, initial: 0.9999999999 });
	assert.equal(b.timeUntil(1, 0), 0);
});

test("take fails when available is meaningfully below the requested amount", () => {
	const b = createBucket({ capacity: 1, refillPerSecond: 0, initial: 0.9 });
	assert.equal(b.take(1, 0), false);
});

// --- mixed sequences -----------------------------------------------------

test("mixed sequence of take, available, and timeUntil calls", () => {
	const b = createBucket({ capacity: 4, refillPerSecond: 2, initial: 4 });
	assert.equal(b.take(3, 0), true);
	close(b.available(0), 1);
	close(b.timeUntil(4, 0), 1500);
	assert.equal(b.take(1, 0), true);
	close(b.available(500), 1);
	assert.equal(b.take(1, 500), true);
	close(b.available(1000), 1);
});

test("depletion, partial refill, and a denied take", () => {
	const b = createBucket({ capacity: 6, refillPerSecond: 3, initial: 6 });
	assert.equal(b.take(6, 0), true);
	close(b.available(1000), 3);
	assert.equal(b.take(4, 1000), false);
	assert.equal(b.take(3, 1000), true);
	assert.equal(b.available(1000), 0);
});

test("reset midway through a sequence resets accounting cleanly", () => {
	const b = createBucket({ capacity: 5, refillPerSecond: 1, initial: 5 });
	assert.equal(b.take(5, 0), true);
	close(b.available(2000), 2);
	b.reset(3000);
	assert.equal(b.available(3000), 5);
	assert.equal(b.take(5, 3000), true);
	assert.equal(b.take(1, 3000), false);
});
