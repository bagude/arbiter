import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRuns } from "../tools/extract-runs.mjs";

test("discoverRuns lists only run dirs with a summary.json, labelled from the summary", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-runs-"));
	fs.mkdirSync(path.join(tmp, "2026-09-11T01-00-00"));
	fs.writeFileSync(
		path.join(tmp, "2026-09-11T01-00-00", "summary.json"),
		JSON.stringify({ runId: "2026-09-11T01-00-00", reason: "SUCCESS: oracle passed", task: "glob", builderModel: "llama.cpp/qwen3-27b", criticModel: "llama.cpp/qwen3-27b", oracleGate: "critic approval" }),
	);
	fs.mkdirSync(path.join(tmp, "2026-09-11T02-00-00")); // no summary: still running or crashed
	fs.mkdirSync(path.join(tmp, ".ws-2026-09-11T02-00-00")); // temp workspace root
	const runs = discoverRuns(tmp);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].id, "2026-09-11T01-00-00");
	assert.equal(runs[0].srcFile, "glob.mjs");
	assert.match(runs[0].label, /glob/);
	assert.match(runs[0].label, /qwen3-27b/);
});
