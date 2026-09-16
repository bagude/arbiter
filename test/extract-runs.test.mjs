import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRuns, extractRun } from "../tools/extract-runs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_RUN = path.join(here, "fixtures", "run-trace");

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

test("extractRun carries the context trace, with tRel0 anchored to the same run-relative clock as events", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-runs-trace-"));
	const dir = path.join(tmp, "2026-09-15T04-19-12");
	fs.cpSync(FIXTURE_RUN, dir, { recursive: true });
	// bus MAIL #1 fires 5s (audit "t") after the run's t0 (1789445953843); anchorEpoch is
	// therefore busTs - 5000, and t0's run-relative seconds is (t0 - anchorEpoch) / 1000 = -5.
	fs.writeFileSync(
		path.join(dir, "bus.jsonl"),
		JSON.stringify({ ts: 1789445963843, from: "orchestrator", to: "worker:8eb067bb-8ebc-4b3", kind: "spawn", body: "go" }) + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "audit.jsonl"),
		JSON.stringify({ t: 5, type: "mail", msg: "MAIL #1 orchestrator -> worker:8eb067bb-8ebc-4b3 [spawn] go" }) + "\n",
	);

	const run = discoverRuns(tmp)[0];
	const result = extractRun(run);
	assert.equal(result.trace.agents.length, 2);
	assert.equal(result.trace.t0, 1789445953843);
	assert.equal(result.trace.tRel0, -5);
});

test("extractRun.trace is null for a run without an archived sessions/ tree", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-runs-notrace-"));
	fs.mkdirSync(path.join(tmp, "2026-09-11T01-00-00"));
	fs.writeFileSync(
		path.join(tmp, "2026-09-11T01-00-00", "summary.json"),
		JSON.stringify({ runId: "2026-09-11T01-00-00", reason: "SUCCESS: oracle passed", task: "glob", builderModel: "llama.cpp/qwen3-27b", criticModel: "llama.cpp/qwen3-27b", oracleGate: "critic approval" }),
	);

	const run = discoverRuns(tmp)[0];
	const result = extractRun(run);
	assert.equal(result.trace, null);
});
