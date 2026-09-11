import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childTranscriptDir, JsonlTailer, workerIdFromTranscript } from "../lib/child-transcripts.mjs";

test("childTranscriptDir derives <dir>/<base>/tasks from the parent session file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-sess-"));
	assert.equal(childTranscriptDir(dir), null);
	fs.writeFileSync(path.join(dir, "2026-09-11T13-00-00-000Z_abc.jsonl"), "");
	assert.equal(childTranscriptDir(dir), path.join(dir, "2026-09-11T13-00-00-000Z_abc", "tasks"));
});
test("JsonlTailer returns only new complete lines", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-tail-")), "t.jsonl");
	fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":');
	const t = new JsonlTailer(f);
	assert.deepEqual(t.readNew(), [{ a: 1 }, { a: 2 }]);
	assert.deepEqual(t.readNew(), []);
	fs.appendFileSync(f, '3}\n');
	assert.deepEqual(t.readNew(), [{ a: 3 }]);
});
test("workerIdFromTranscript is the file basename", () => {
	assert.equal(workerIdFromTranscript("C:\\x\\tasks\\41afd2c6.jsonl"), "41afd2c6");
});
