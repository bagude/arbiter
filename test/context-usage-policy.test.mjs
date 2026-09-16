import { test } from "node:test";
import assert from "node:assert/strict";
import { CHARS_PER_TOKEN, describeContextUsage } from "../lib/policies/context-usage.mjs";

test("CHARS_PER_TOKEN is the shared rule of thumb", () => {
	assert.equal(CHARS_PER_TOKEN, 3.3);
});

test("zero chars against a known window: 0% used", () => {
	const r = describeContextUsage({ chars: 0, contextWindow: 131072 });
	assert.equal(r.chars, 0);
	assert.equal(r.estTokens, 0);
	assert.equal(r.contextWindow, 131072);
	assert.equal(r.percent, 0);
	assert.match(r.text, /0\.0% used/);
});

test("33,000 chars against a 131,072 window: exact token count, one-decimal percent", () => {
	const r = describeContextUsage({ chars: 33000, contextWindow: 131072 });
	assert.equal(r.estTokens, 10000);
	assert.equal(r.percent, 7.6);
	assert.equal(r.text, "Context: ~33,000 chars (~10,000 tokens est.) of 131,072 (7.6% used).");
});

test("no context window: percent is null and the text says so", () => {
	const r = describeContextUsage({ chars: 500, contextWindow: null });
	assert.equal(r.percent, null);
	assert.equal(r.contextWindow, null);
	assert.ok(r.text.endsWith("context window unknown."));
});

test("thousands separators appear in the text for both chars and tokens", () => {
	const r = describeContextUsage({ chars: 12345, contextWindow: 131072 });
	assert.equal(r.estTokens, 3741);
	assert.equal(r.text, "Context: ~12,345 chars (~3,741 tokens est.) of 131,072 (2.9% used).");
});
