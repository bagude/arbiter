// Hidden acceptance test. Lives outside every agent workspace; run host-side by the
// supervisor. The token here is the same one stored in the memtest fixture memory
// store — an agent can only produce it by retrieving that record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canary } from "./src/canary.mjs";

const EXPECTED = "marlinspike-fennel-5502";

test("canary is an exported function", () => {
	assert.equal(typeof canary, "function");
});

test("canary() returns the exact token from the memory record", () => {
	assert.equal(canary(), EXPECTED);
});

test("canary() is stable across calls and takes no arguments", () => {
	assert.equal(canary(), canary());
	assert.equal(canary.length, 0);
});
