import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRecord, appendLog, readLog, foldLog } from "../lib/memory.mjs";

// tools/verdict.mjs records a human's ruling on a run: into the run's summary.json,
// into memory as a human-sourced record, and onto the run's agent-sourced
// candidate findings (promote on accept, tombstone on reject). ARBITER_HOME points
// the tool at a scratch checkout so the real store is never touched.
function scratchHome(runId, candidates) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-verdict-"));
	fs.mkdirSync(path.join(home, "runs", runId), { recursive: true });
	fs.writeFileSync(path.join(home, "runs", runId, "summary.json"), JSON.stringify({ runId, task: "review-guard", reason: "SUCCESS: oracle passed" }));
	appendLog(path.join(home, "memory", "records.jsonl"), candidates.map((text) => makeRecord({ scope: "global", kind: "semantic", text, evidence: [`run:${runId}`], confidence: 0.4, source: "agent", ts: 1 })));
	return home;
}
function verdict(home, args) {
	const r = spawnSync(process.execPath, [path.resolve("tools/verdict.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ARBITER_HOME: home } });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("accept: summary gets the verdict, a human record is promoted, the run's candidates are promoted", () => {
	const home = scratchHome("r1", ["finding one", "finding two"]);
	const { status, out } = verdict(home, ["r1", "accept", "both findings reproduce"]);
	assert.equal(status, 0, out);
	const s = JSON.parse(fs.readFileSync(path.join(home, "runs", "r1", "summary.json"), "utf8"));
	assert.equal(s.humanVerdict.verdict, "accept");
	assert.equal(s.humanVerdict.why, "both findings reproduce");
	assert.equal(typeof s.humanVerdict.ts, "number");
	const records = [...foldLog(readLog(path.join(home, "memory", "records.jsonl"))).values()];
	const human = records.find((r) => r.source === "human");
	assert.equal(human.status, "promoted");
	assert.match(human.text, /human verdict on run r1: accept — both findings reproduce/);
	assert.deepEqual(human.evidence, ["run:r1"]);
	assert.deepEqual(records.filter((r) => r.source === "agent").map((r) => r.status), ["promoted", "promoted"]);
});

test("reject: candidates are tombstoned with the reason; nothing else is touched", () => {
	const home = scratchHome("r2", ["a claim"]);
	assert.equal(verdict(home, ["r2", "reject", "did not reproduce"]).status, 0);
	const records = [...foldLog(readLog(path.join(home, "memory", "records.jsonl"))).values()];
	const agent = records.find((r) => r.source === "agent");
	assert.equal(agent.status, "tombstoned");
	assert.match(agent.tombstoneReason, /rejected by human verdict on run r2/);
});

test("usage errors: unknown run, bad verdict word, missing reason", () => {
	const home = scratchHome("r3", []);
	assert.notEqual(verdict(home, ["nope", "accept", "x"]).status, 0);
	assert.notEqual(verdict(home, ["r3", "maybe", "x"]).status, 0);
	assert.notEqual(verdict(home, ["r3", "accept"]).status, 0);
});
