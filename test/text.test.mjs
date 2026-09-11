import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateForMail, PROBE_VALUE_MAX } from "../lib/text.mjs";

test("short strings pass through untouched", () => {
	assert.equal(truncateForMail("abc"), "abc");
});
test("long strings are cut at the cap with a note carrying the original length", () => {
	const s = "x".repeat(PROBE_VALUE_MAX + 500);
	const out = truncateForMail(s);
	assert.ok(out.startsWith("x".repeat(PROBE_VALUE_MAX)));
	assert.match(out, /truncated, 2000 chars total/);
	assert.ok(out.length < s.length);
});
test("a custom cap is honoured", () => {
	assert.match(truncateForMail("abcdefgh", 4), /^abcd…\[truncated, 8 chars total/);
});
