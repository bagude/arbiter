import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, loadTask, saveTask, spendBudget } from "../lib/manage/task-state.mjs";
import { assemblePacket, writePacket } from "../lib/manage/packet.mjs";

const criteria = [{ id: "c1", text: "all 70 oracle cases pass", check: "oracle:tasks/pathnorm/oracle" }];
const milestones = [{ id: "m1", title: "pass", criteria: ["c1"] }];

function mkTaskDir(budget = { wallSec: 3600, runs: 4, forkReplicates: 12, usd: 5 }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-"));
	createTask({ dir, taskId: "t1", goal: "pass pathnorm", criteria, milestones, budget });
	return dir;
}

function mkRunDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ reason: "FAILED: done attempts exhausted", wallSec: 100, task: "pathnorm", guards: {}, doneAttempts: 2 }));
	fs.writeFileSync(
		path.join(dir, "audit.jsonl"),
		[
			{ t: "1.0", type: "oracle", msg: "Oracle run #1: 68/70 passed." },
			{ t: "2.0", type: "oracle", msg: "Oracle run #2: 68/70 passed." },
			{ t: "3.0", type: "mail", msg: "MAIL #5 orchestrator -> supervisor [done] Claiming done." },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "decisions.jsonl"),
		[
			{ i: 0, substantive: { cls: "spawn" } },
			{ i: 1, substantive: { cls: "resume" } },
			{ i: 2, substantive: { cls: "done" } },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "decisions-replay-substantive.jsonl"),
		JSON.stringify({ i: 2, substantive: { cls: "done" }, head: { pickClass: "probe", confidence: 0.93, agreeSubstantive: false } }) + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "workers.jsonl"),
		[
			{ ts: 1, ev: "started", wid: "worker:a", description: "write tests", background: false, type: "tester" },
			{ ts: 2, ev: "completed", wid: "worker:a", status: "completed", outcome: "completed" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	const sessDir = path.join(dir, "sessions", "orchestrator");
	fs.mkdirSync(sessDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessDir, "2026-09-18T00-00-00-000Z_session.jsonl"),
		[
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Setting TYPESAFE_API_KEY=apikey_29abcdefghijklmnopqrstuvwxyz before probing." }] } },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	return dir;
}

test("assemblePacket builds the §2 shape, redacts secrets, bounds size, and numbers packets by directory count", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	const p = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { attempts: 2 } }, verbsAllowed: ["continue", "correct", "restore", "compare", "accept", "escalate"] });
	assert.equal(p.packetId, 1);
	assert.deepEqual(p.task, loadTask(taskDir), "the task state travels whole");
	assert.equal(p.run.oracle.length, 2);
	assert.equal(p.run.decisions.points, 3);
	assert.equal(p.run.heads.local27b.confidentDisagreements.length, 1);
	assert.ok(!JSON.stringify(p).includes("apikey_29abc"), "redacted");
	assert.ok(JSON.stringify(p).length <= 120000);
	assert.deepEqual(p.options.verbsAllowed, ["continue", "correct", "restore", "compare", "accept", "escalate"]);
	assert.equal(writePacket(taskDir, p), path.join(taskDir, "packets", "1.json"));
	const p2 = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { attempts: 2 } }, verbsAllowed: ["continue"] });
	assert.equal(p2.packetId, 2, "numbers by counting packets/*.json + 1, and only 1.json exists on disk yet");
});

test("default verbsAllowed prunes accept off milestone_candidate/comparison_ready, and prunes compare/restore once fork and run budget are both spent", () => {
	const runDir = mkRunDir();

	const plentyDir = mkTaskDir();
	const notMilestone = assemblePacket({ taskDir: plentyDir, runDir, trigger: { kind: "run_ended_without_acceptance", runId: "r1" } });
	assert.ok(!notMilestone.options.verbsAllowed.includes("accept"), "trigger is not milestone_candidate or comparison_ready");
	assert.ok(notMilestone.options.verbsAllowed.includes("restore"), "budget is not exhausted");
	assert.ok(notMilestone.options.verbsAllowed.includes("compare"));

	const isMilestone = assemblePacket({ taskDir: plentyDir, runDir, trigger: { kind: "milestone_candidate", runId: "r1" } });
	assert.ok(isMilestone.options.verbsAllowed.includes("accept"));

	const brokeDir = mkTaskDir({ runs: 1, forkReplicates: 1 });
	let t = loadTask(brokeDir);
	t = saveTask(brokeDir, spendBudget(t, { runs: 1, forkReplicates: 1 }));
	const exhausted = assemblePacket({ taskDir: brokeDir, runDir, trigger: { kind: "milestone_candidate", runId: "r1" } });
	assert.ok(!exhausted.options.verbsAllowed.includes("restore"), "both forkReplicates and runs budgetLeft are 0");
	assert.ok(!exhausted.options.verbsAllowed.includes("compare"));
	assert.ok(exhausted.options.verbsAllowed.includes("accept"), "accept is unaffected by the fork/run budget rule");
});

test("bounding ladder drops tail, then chain, in order, and the FINAL rendered packet (bounded field included) always fits maxChars", () => {
	const taskDir = mkTaskDir();
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
	fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ reason: "x", wallSec: 1, task: "pathnorm", guards: {}, doneAttempts: 1 }));
	// 40+ chain-eligible lines so the chain fills its 40-line cap with real bulk, and a long
	// tail, so a tight maxChars has to drop both — not just the first thing it tries.
	const auditRows = [];
	for (let i = 0; i < 50; i++) auditRows.push({ t: String(i), type: "oracle", msg: `Oracle run #${i}: 68/70 passed. padding ${"z".repeat(80)}` });
	fs.writeFileSync(path.join(runDir, "audit.jsonl"), auditRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	fs.writeFileSync(path.join(runDir, "decisions.jsonl"), "");
	const sessDir = path.join(runDir, "sessions", "orchestrator");
	fs.mkdirSync(sessDir, { recursive: true });
	fs.writeFileSync(path.join(sessDir, "s.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(3000) }] } }) + "\n");

	const full = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } });
	assert.equal(full.run.tail.length, 2000, "unbounded, the tail is the full 2 000-char slice");
	assert.equal(full.run.chain.length, 40, "unbounded, the chain keeps its 40-line cap");
	assert.equal(full.bounded, null);
	assert.ok(JSON.stringify(full).length > 8000, "the fixture is big enough that 8 000 chars forces real drops");

	const tight = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" }, maxChars: 8000 });
	assert.equal(tight.run.tail, "", "tail goes first");
	assert.deepEqual(tight.run.chain, [], "chain goes second, because tail alone was not enough");
	assert.deepEqual(tight.bounded, ["tail", "chain"]);
	assert.ok(JSON.stringify(tight).length <= 8000, "the size check must include packet.bounded itself, not just the pre-assignment render");
});
