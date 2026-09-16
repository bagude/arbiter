import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const CLI = path.join(ROOT, "tools", "context-trace.mjs");
const FIXTURE = path.join(here, "fixtures", "run-trace");

function run(args) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

test("--json output parses the fixture run and has both agents", () => {
	const out = run([FIXTURE, "--json"]);
	const trace = JSON.parse(out);
	assert.equal(trace.run, "run-trace");
	assert.equal(trace.agents.length, 2);
});

test("text output prints the run header, the orchestrator agent header, and the call-1 row", () => {
	const out = run([FIXTURE]);
	assert.match(out, /^# context trace — run-trace$/m);
	assert.match(out, /^## orchestrator: \d+ calls, hit \d+\.\d{3}, fresh \d+, cached \d+, peak \d+, inference \d+\.\d+s, tools \d+\.\d+s$/m);
	// call 1: fresh 6007, cached 0, context 6007
	assert.match(out, /^\s+1\s+0\.9\s+6007\s+0\s+6007/m);
});
