import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenTotals, freshTokens } from "../lib/usage.mjs";

test("tokenTotals sums fresh input and output per assistant message_end across raw-*.jsonl, by role", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-usage-"));
	const line = (role, input, output, cacheRead = 0) => JSON.stringify({ type: "message_end", message: { role, usage: { input, output, cacheRead, cacheWrite: 0 } } });
	fs.writeFileSync(path.join(dir, "raw-orchestrator.jsonl"), [line("assistant", 100, 20), line("user", 999, 999), line("assistant", 50, 5, 400), JSON.stringify({ type: "tool_call" })].join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "raw-worker_abc.jsonl"), line("assistant", 30, 10) + "\n");
	fs.writeFileSync(path.join(dir, "audit.jsonl"), "{}\n");
	assert.deepEqual(tokenTotals(dir), { input: 180, output: 35, cacheRead: 400, cacheWrite: 0, turns: 3, byRole: { orchestrator: 175, worker: 40 } });
	assert.equal(freshTokens(dir), 215);
});
