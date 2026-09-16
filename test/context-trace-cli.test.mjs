import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

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

test("the i and t+s columns of a call row never abut: a two-digit call index (19) stays separated from a four-digit t+s (1025.7)", () => {
	const out = run([FIXTURE]);
	assert.match(out, / 19 +1025\.7(?:\s|$)/m);
});

test("the header row contains the pp s column and fixture rows print — for it (no serverTimings in the fixture)", () => {
	const out = run([FIXTURE]);
	assert.match(out, /\bpp s\b/);
	assert.match(out, /^\s+1\s+0\.9\s+6007\s+0\s+6007\s+\S+\s+\S+\s+\d+\s+—/m);
});

test("a worker's last row shows its return marker (attached only to the parent's call, surfaced via markersFor)", () => {
	const out = run([FIXTURE]);
	const workerSection = out.slice(out.indexOf("## worker:"));
	assert.match(workerSection, /\[return/);
});

test("the fixture worker header carries its spawn type in brackets", () => {
	const out = run([FIXTURE]);
	const workerSection = out.slice(out.indexOf("## worker:"));
	assert.match(workerSection.split("\n")[0], /^## worker:\S+ \[worker\]/);
});

test("a run whose worker was spawned with a non-worker roster type prints that type in the header", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-cli-type-"));
	const sessionsDir = path.join(tmp, "sessions", "orchestrator");
	const tasksDir = path.join(sessionsDir, "tasks");
	fs.mkdirSync(tasksDir, { recursive: true });
	const msg = (startMs, endIso) => ({
		type: "message",
		id: `m-${startMs}`,
		timestamp: endIso,
		message: { role: "assistant", content: [], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 }, timestamp: startMs, stopReason: "endTurn" },
	});
	fs.writeFileSync(
		path.join(sessionsDir, "orch.jsonl"),
		[
			{ type: "session", version: 3, id: "orch-session-1", timestamp: new Date(400).toISOString() },
			msg(500, new Date(600).toISOString()),
			msg(700, new Date(9600).toISOString()),
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(tasksDir, "w1.jsonl"),
		[{ type: "session", version: 3, id: "worker-session-1", timestamp: new Date(1400).toISOString(), parentSession: "orch-session-1" }, msg(1500, new Date(2000).toISOString())]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:started", data: { id: "sub-x", type: "tester", description: "FG task" } },
			{ ts: 9000, ev: "subagents:completed", data: { id: "sub-x", type: "tester", description: "FG task" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const out = run([tmp]);
	const workerSection = out.slice(out.indexOf("## worker:"));
	assert.match(workerSection.split("\n")[0], /^## worker:\S+ \[tester\]/);
});
