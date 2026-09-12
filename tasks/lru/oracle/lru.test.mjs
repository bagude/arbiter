// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLRU } from "./src/lru.mjs";

function clock(t = 0) {
	const state = { t };
	return { state, now: () => state.t };
}

function assertInvalidCapacity(fn) {
	assert.throws(fn, (err) => err instanceof RangeError && /^invalid capacity/.test(err.message));
}

function assertInvalidTtl(fn) {
	assert.throws(fn, (err) => err instanceof RangeError && /^invalid ttl/.test(err.message));
}

// --- construction: capacity validation ---

test("capacity 0 throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({ capacity: 0 }));
});

test("negative capacity throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({ capacity: -1 }));
});

test("non-integer capacity throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({ capacity: 1.5 }));
});

test("NaN capacity throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({ capacity: NaN }));
});

test("string capacity throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({ capacity: "3" }));
});

test("missing capacity throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU({}));
});

test("no options at all throws invalid capacity", () => {
	assertInvalidCapacity(() => createLRU());
});

test("capacity checked before ttlMs when both invalid", () => {
	assertInvalidCapacity(() => createLRU({ capacity: 0, ttlMs: -5 }));
});

// --- construction: ttlMs validation ---

test("ttlMs 0 throws invalid ttl", () => {
	assertInvalidTtl(() => createLRU({ capacity: 1, ttlMs: 0 }));
});

test("negative ttlMs throws invalid ttl", () => {
	assertInvalidTtl(() => createLRU({ capacity: 1, ttlMs: -5 }));
});

test("NaN ttlMs throws invalid ttl", () => {
	assertInvalidTtl(() => createLRU({ capacity: 1, ttlMs: NaN }));
});

test("string ttlMs throws invalid ttl", () => {
	assertInvalidTtl(() => createLRU({ capacity: 1, ttlMs: "10" }));
});

test("-Infinity ttlMs throws invalid ttl", () => {
	assertInvalidTtl(() => createLRU({ capacity: 1, ttlMs: -Infinity }));
});

test("Infinity ttlMs is accepted", () => {
	assert.doesNotThrow(() => createLRU({ capacity: 1, ttlMs: Infinity }));
});

test("default ttlMs (omitted) is accepted and never expires", () => {
	const c = createLRU({ capacity: 1 });
	c.set("a", 1);
	assert.equal(c.has("a"), true);
});

// --- basic get/set/has/delete/clear ---

test("get on empty cache returns undefined", () => {
	const c = createLRU({ capacity: 2 });
	assert.equal(c.get("missing"), undefined);
});

test("set then get round-trips the value", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	assert.equal(c.get("a"), 1);
});

test("set returns the cache for chaining", () => {
	const c = createLRU({ capacity: 2 });
	const ret = c.set("a", 1);
	assert.equal(ret, c);
	c.set("a", 1).set("b", 2);
	assert.deepEqual(c.keys(), ["a", "b"]);
});

test("has is true for present key and false for absent key", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	assert.equal(c.has("a"), true);
	assert.equal(c.has("z"), false);
});

test("delete removes an existing key and returns true", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	assert.equal(c.delete("a"), true);
	assert.equal(c.has("a"), false);
});

test("delete on absent key returns false", () => {
	const c = createLRU({ capacity: 2 });
	assert.equal(c.delete("z"), false);
});

test("clear empties the cache", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.clear();
	assert.equal(c.size, 0);
	assert.deepEqual(c.keys(), []);
});

test("clear on an already-empty cache does not throw", () => {
	const c = createLRU({ capacity: 2 });
	assert.doesNotThrow(() => c.clear());
});

test("size reflects the number of live entries", () => {
	const c = createLRU({ capacity: 3 });
	assert.equal(c.size, 0);
	c.set("a", 1);
	c.set("b", 2);
	assert.equal(c.size, 2);
});

test("stored value of undefined is distinguishable via has", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", undefined);
	assert.equal(c.get("a"), undefined);
	assert.equal(c.has("a"), true);
	assert.equal(c.has("z"), false);
});

test("SameValueZero: NaN key matches NaN key", () => {
	const c = createLRU({ capacity: 2 });
	c.set(NaN, "nan-value");
	assert.equal(c.get(NaN), "nan-value");
	assert.equal(c.has(NaN), true);
});

test("SameValueZero: +0 and -0 are the same key", () => {
	const c = createLRU({ capacity: 2 });
	c.set(0, "zero");
	assert.equal(c.get(-0), "zero");
	assert.equal(c.has(-0), true);
});

test("object references are distinct keys", () => {
	const c = createLRU({ capacity: 2 });
	const k1 = {};
	const k2 = {};
	c.set(k1, "one");
	c.set(k2, "two");
	assert.equal(c.get(k1), "one");
	assert.equal(c.get(k2), "two");
});

// --- keys() ordering ---

test("keys() lists entries least-recently-used first", () => {
	const c = createLRU({ capacity: 3 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("c", 3);
	assert.deepEqual(c.keys(), ["a", "b", "c"]);
});

test("keys() returns a fresh array each call", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	const k1 = c.keys();
	k1.push("intruder");
	assert.deepEqual(c.keys(), ["a"]);
});

test("has() does not change recency order", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.has("a");
	c.set("c", 3);
	assert.deepEqual(c.keys(), ["b", "c"]);
});

test("keys() does not change recency order", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.keys();
	c.set("c", 3);
	assert.deepEqual(c.keys(), ["b", "c"]);
});

test("delete() does not disturb recency of remaining keys", () => {
	const c = createLRU({ capacity: 3 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("c", 3);
	c.delete("b");
	assert.deepEqual(c.keys(), ["a", "c"]);
});

// --- recency refresh via get/set ---

test("get() on an existing key moves it to most-recently-used", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.get("a");
	assert.deepEqual(c.keys(), ["b", "a"]);
});

test("set() on an existing key moves it to most-recently-used", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("a", 99);
	assert.deepEqual(c.keys(), ["b", "a"]);
	assert.equal(c.get("a"), 99);
});

test("set() on an existing key updates the value without changing size", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("a", 42);
	assert.equal(c.size, 2);
	assert.equal(c.get("a"), 42);
	assert.equal(c.get("b"), 2);
});

// --- eviction ---

test("inserting beyond capacity evicts the least-recently-used key", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("c", 3);
	assert.equal(c.has("a"), false);
	assert.equal(c.has("b"), true);
	assert.equal(c.has("c"), true);
	assert.deepEqual(c.keys(), ["b", "c"]);
});

test("get() before overflow protects a key from eviction", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.get("a");
	c.set("c", 3);
	assert.equal(c.has("a"), true);
	assert.equal(c.has("b"), false);
	assert.deepEqual(c.keys(), ["a", "c"]);
});

test("updating an existing key never triggers eviction, even at capacity", () => {
	const c = createLRU({ capacity: 1 });
	c.set("a", 1);
	c.set("a", 2);
	assert.equal(c.size, 1);
	assert.equal(c.get("a"), 2);
});

test("capacity 1 evicts the sole existing entry on a new key", () => {
	const c = createLRU({ capacity: 1 });
	c.set("a", 1);
	c.set("b", 2);
	assert.equal(c.has("a"), false);
	assert.equal(c.has("b"), true);
	assert.equal(c.size, 1);
});

test("repeated overflow evicts one entry per new key, in LRU order", () => {
	const c = createLRU({ capacity: 2 });
	c.set("a", 1);
	c.set("b", 2);
	c.set("c", 3);
	c.set("d", 4);
	assert.deepEqual(c.keys(), ["c", "d"]);
	assert.equal(c.size, 2);
});

// --- TTL expiry ---

test("entry is live at age exactly equal to ttlMs", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 10;
	assert.equal(c.has("a"), true);
	assert.equal(c.get("a"), 1);
});

test("entry expires once age exceeds ttlMs", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 11;
	assert.equal(c.has("a"), false);
	assert.equal(c.get("a"), undefined);
});

test("expired entry is absent from keys() and does not count toward size", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 5;
	c.set("b", 2);
	state.t = 11; // a: age 11, expired; b: age 6, still live
	assert.deepEqual(c.keys(), ["b"]);
	assert.equal(c.size, 1);
});

test("delete on an expired entry returns false", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 11;
	assert.equal(c.delete("a"), false);
});

test("re-set of an expired key is treated as a brand-new insert (can evict)", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 1, ttlMs: 10, now });
	c.set("a", 1);
	c.set("b", 2); // evicts "a" (capacity 1, "a" still live at t=0)
	state.t = 11; // "b" now expired
	c.set("a", 100); // "b" is expired -> purged -> "a" is a fresh insert, no eviction of a live entry
	assert.equal(c.size, 1);
	assert.equal(c.get("a"), 100);
	assert.equal(c.has("b"), false);
});

test("get() does not reset an entry's expiry timer", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 5;
	c.get("a");
	state.t = 11;
	assert.equal(c.has("a"), false);
});

test("set() on an existing key resets its expiry timer", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 8;
	c.set("a", 2);
	state.t = 17; // 9ms after the refresh at t=8, still < 10
	assert.equal(c.has("a"), true);
	assert.equal(c.get("a"), 2);
	state.t = 19; // 11ms after the refresh
	assert.equal(c.has("a"), false);
});

test("mixed live and expired entries: only expired ones are purged", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 3, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 5;
	c.set("b", 2);
	state.t = 11; // a expired (age 11), b still live (age 6)
	assert.deepEqual(c.keys(), ["b"]);
	assert.equal(c.size, 1);
});

test("size getter triggers purge of expired entries", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	c.set("b", 2);
	state.t = 11;
	assert.equal(c.size, 0);
});

test("clear removes both live and expired entries", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 11;
	c.clear();
	assert.equal(c.size, 0);
	assert.deepEqual(c.keys(), []);
});

test("expiry allows a fresh insert to reuse capacity without evicting a live entry", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 1, ttlMs: 10, now });
	c.set("a", 1);
	state.t = 11; // "a" expires
	c.set("b", 2); // capacity available again since "a" is purged, no eviction needed
	assert.equal(c.size, 1);
	assert.equal(c.get("b"), 2);
});

test("multiple entries can independently expire at different times", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 3, ttlMs: 5, now });
	c.set("a", 1);
	state.t = 3;
	c.set("b", 2);
	state.t = 6; // a expired (age 6 > 5), b still live (age 3)
	assert.equal(c.has("a"), false);
	assert.equal(c.has("b"), true);
	state.t = 9; // b now expired (age 6 > 5)
	assert.equal(c.has("b"), false);
});

test("has() triggers purge so a subsequently queried size is accurate", () => {
	const { state, now } = clock(0);
	const c = createLRU({ capacity: 2, ttlMs: 10, now });
	c.set("a", 1);
	c.set("b", 2);
	state.t = 11;
	c.has("a");
	assert.equal(c.size, 0);
});
