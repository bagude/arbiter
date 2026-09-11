import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBashTimeout } from "../lib/policies/bash-timeout.mjs";

const decide = (input) => decideBashTimeout({ input, defaultSec: 90, maxSec: 600 });

test("a command with a valid timeout under the max passes untouched", () => {
	assert.deepEqual(decide({ command: "node x.mjs", timeout: 30 }), { ok: true });
});

test("a missing timeout is rewritten to the default and says why", () => {
	const r = decide({ command: "node x.mjs" });
	assert.equal(r.ok, false);
	assert.deepEqual(r.rewrite, { timeout: 90 });
	assert.match(r.reason, /no timeout/);
});

test("an invalid timeout (zero, negative, NaN, non-number) is rewritten to the default", () => {
	for (const timeout of [0, -5, Number.NaN, "60", null]) {
		assert.deepEqual(decide({ command: "x", timeout }).rewrite, { timeout: 90 }, `timeout=${String(timeout)}`);
	}
});

test("a timeout above the max is clamped to the max", () => {
	const r = decide({ command: "x", timeout: 100000 });
	assert.deepEqual(r.rewrite, { timeout: 600 });
	assert.match(r.reason, /600/);
});

test("the default itself is clamped when it exceeds the max", () => {
	assert.deepEqual(decideBashTimeout({ input: { command: "x" }, defaultSec: 900, maxSec: 600 }).rewrite, { timeout: 600 });
});
