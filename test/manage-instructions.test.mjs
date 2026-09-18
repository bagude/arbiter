import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
import { readLedger, appendLedger } from "../lib/manage/ledger.mjs";
import { INSTRUCTION_VERBS, validateInstruction, executeInstruction, controlAppend, NotYetImplemented } from "../lib/manage/instructions.mjs";

const RUN_ID = "2026-09-18T01-02-03";

/**
 * A task at stateVersion 4 with one live run. The version is reached by saving until the file
 * says 4 rather than by writing the number: saveTask bumps on every write (createTask persists
 * 1), so a hand-set version would be a fixture that could never exist on disk.
 */
function fixture({ budget = { wallSec: 14400, runs: 20, forkReplicates: 24 } } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-instr-"));
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-runs-"));
	let task = createTask({
		dir,
		taskId: "t1",
		goal: "a goal",
		criteria: [{ id: "c1", text: "the oracle passes", check: "oracle:tasks/x/oracle" }],
		milestones: [{ id: "m1", title: "first", criteria: ["c1"] }],
		budget,
	});
	task = saveTask(dir, setCurrent(task, { activeRuns: [RUN_ID], checkpoint: "ck-0007" }));
	while (loadTask(dir).stateVersion < 4) task = saveTask(dir, task);
	assert.equal(loadTask(dir).stateVersion, 4, "fixture must be at version 4");
	return { dir, runsDir, task: loadTask(dir) };
}

const packetFor = (task, { verbsAllowed = ["continue", "correct", "restore", "compare", "escalate"] } = {}) => ({
	packetId: 7,
	trigger: { kind: "oracle_failed_repeatedly", runId: RUN_ID, detail: { attempts: 2 } },
	task,
	run: { id: RUN_ID },
	options: { verbsAllowed, budgetLeft: { wallSec: 14400, runs: 1, forkReplicates: 24, usd: null } },
});

const instr = (over = {}) => ({ packetId: 7, basedOnStateVersion: 4, idempotencyKey: "p7-v4", verb: "continue", args: { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 300, toolCalls: 50 } }, rationale: "keep going", ...over });

const control = (runsDir, runId = RUN_ID) => {
	const f = path.join(runsDir, runId, "control.jsonl");
	return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// ---------- validation ----------

test("the six verbs are the contract, in spec order", () => {
	assert.deepEqual(INSTRUCTION_VERBS, ["continue", "correct", "restore", "compare", "accept", "escalate"]);
});

test("a well-formed continue passes", () => {
	const { dir, task } = fixture();
	assert.deepEqual(validateInstruction(instr(), { task, packet: packetFor(task), taskDir: dir }), { ok: true });
});

test("an instruction based on an older state version is refused as stale, not executed against state the manager never saw", () => {
	const { dir, task } = fixture();
	const r = validateInstruction(instr({ basedOnStateVersion: 3 }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.ok, false);
	assert.equal(r.code, "stale_version");
	assert.match(r.refusal, /version 3.*at 4/);
});

test("a key already in the ledger is a duplicate", () => {
	const { dir, task } = fixture();
	appendLedger(dir, { packetId: 7, instruction: { idempotencyKey: "p7-v4", verb: "continue" }, verified: true });
	const r = validateInstruction(instr(), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "duplicate_key");
});

test("a verb the packet does not allow is refused; so is a verb that does not exist", () => {
	const { dir, task } = fixture();
	const p = packetFor(task); // no "accept"
	const r = validateInstruction(instr({ verb: "accept", idempotencyKey: "k-accept", args: { milestone: "m1", checkpoint: "ck-0007", evidence: ["oracle:x"] } }), { task, packet: p, taskDir: dir });
	assert.equal(r.code, "verb_not_allowed");
	assert.equal(validateInstruction(instr({ verb: "ponder" }), { task, packet: p, taskDir: dir }).code, "verb_not_allowed");
});

test("restore with no run budget left is refused on budget", () => {
	const { dir, task } = fixture({ budget: { wallSec: 14400, runs: 1, forkReplicates: 24 } });
	const spent = saveTask(dir, { ...task, budget: { ...task.budget, runs: { total: 1, used: 1 } } });
	const r = validateInstruction(instr({ verb: "restore", basedOnStateVersion: spent.stateVersion, args: { checkpoint: "ck-0007" } }), { task: spent, packet: packetFor(spent), taskDir: dir });
	assert.equal(r.code, "budget");
	assert.match(r.refusal, /no run budget left/);
});

test("a correction longer than 2 000 chars is refused", () => {
	const { dir, task } = fixture();
	const r = validateInstruction(instr({ verb: "correct", args: { runId: RUN_ID, message: "x".repeat(3000) } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "precondition");
	assert.match(r.refusal, /3000 chars/);
});

test("continue naming a run that is not live is refused", () => {
	const { dir, task } = fixture();
	const r = validateInstruction(instr({ args: { runId: "some-other-run", milestone: "m1" } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "precondition");
	assert.match(r.refusal, /not live/);
});

test("a rationale longer than 500 chars is refused", () => {
	const { dir, task } = fixture();
	const r = validateInstruction(instr({ rationale: "y".repeat(501) }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "precondition");
	assert.match(r.refusal, /500/);
});

test("any instruction whose args mention acceptance is refused — criteria are immutable", () => {
	const { dir, task } = fixture();
	const r = validateInstruction(instr({ verb: "correct", args: { runId: RUN_ID, message: "fine", acceptance: { criteria: [] } } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "precondition");
	assert.match(r.refusal, /immutable/);
	// Nested and renamed, too: the check is over the rendered args, not a key list.
	const deep = validateInstruction(instr({ verb: "correct", args: { runId: RUN_ID, message: "please relax the acceptance criteria" } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(deep.code, "precondition");
});

// Executing an instruction moves the task, so a retry of one that already ran is always stale
// too. If the version check came first, no retry could ever be acknowledged as a duplicate and
// §3's idempotency rule would be unreachable — so the key is answered before the version.
test("validation order: a stale duplicate with a disallowed verb is acknowledged as a duplicate first", () => {
	const { dir, task } = fixture();
	appendLedger(dir, { packetId: 7, instruction: { idempotencyKey: "p7-v4", verb: "accept" }, verified: true });
	const r = validateInstruction(instr({ basedOnStateVersion: 2, verb: "accept", args: { milestone: "m1", checkpoint: "c", evidence: ["e"] } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(r.code, "duplicate_key");
	// A fresh key on the same stale version is still stale, and stale still beats the verb.
	const fresh = validateInstruction(instr({ idempotencyKey: "other", basedOnStateVersion: 2, verb: "accept", args: { milestone: "m1", checkpoint: "c", evidence: ["e"] } }), { task, packet: packetFor(task), taskDir: dir });
	assert.equal(fresh.code, "stale_version");
});

// ---------- execution ----------

test("continue: the ledger row is written BEFORE the control entry, the grant is spent, and decision comes last", () => {
	const { dir, runsDir, task } = fixture();
	const r = executeInstruction({ taskDir: dir, instr: instr(), packet: packetFor(task), runsDir });
	assert.equal(r.executed, true);
	assert.equal(r.ledgerRow.verified, true);
	assert.equal(r.ledgerRow.stateVersion, 4, "the row records the version the instruction was based on");

	const rows = readLedger(dir);
	assert.equal(rows.length, 1);
	const entries = control(runsDir);
	assert.deepEqual(entries.map((e) => e.type), ["grant", "decision"], "grant before decision: the supervisor attaches same-batch entries to the delivery it releases");
	assert.ok(rows[0].ts <= entries[0].ts, "the ledger row must be on disk before the act");
	assert.equal(entries[0].wallSec, 300);
	assert.equal(entries[0].toolCalls, 50);
	assert.equal(entries[1].verb, "continue");
	assert.equal(loadTask(dir).budget.wallSec.used, 300);
});

test("correct: writes the correct entry then the decision, and spends no budget", () => {
	const { dir, runsDir, task } = fixture();
	const r = executeInstruction({ taskDir: dir, instr: instr({ verb: "correct", args: { runId: RUN_ID, message: "the tester's suite is the gate, not your probes" } }), packet: packetFor(task), runsDir });
	assert.equal(r.executed, true);
	const entries = control(runsDir);
	assert.deepEqual(entries.map((e) => e.type), ["correct", "decision"]);
	assert.match(entries[0].message, /tester's suite/);
	assert.equal(loadTask(dir).budget.wallSec.used, 0);
});

test("escalate: pauses the task, records a blocker, and still releases a paused supervisor", () => {
	const { dir, runsDir, task } = fixture();
	const r = executeInstruction({ taskDir: dir, instr: instr({ verb: "escalate", args: { reason: "criterion c1 tests something the spec never asked for", wants: "criteria_change" } }), packet: packetFor(task), runsDir });
	assert.equal(r.executed, true);
	const after = loadTask(dir);
	assert.equal(after.status, "paused");
	assert.equal(after.blockers.length, 1);
	assert.equal(after.blockers[0].wants, "criteria_change");
	assert.equal(after.blockers[0].raisedBy, "manager");
	assert.deepEqual(control(runsDir).map((e) => e.type), ["decision"]);
});

test("a refusal is a ledger row too, and nothing reaches the control file", () => {
	const { dir, runsDir, task } = fixture();
	const r = executeInstruction({ taskDir: dir, instr: instr({ basedOnStateVersion: 3 }), packet: packetFor(task), runsDir });
	assert.equal(r.executed, false);
	assert.equal(r.code, "stale_version");
	const [row] = readLedger(dir);
	assert.equal(row.verified, false);
	assert.equal(row.refused, "stale_version");
	assert.deepEqual(control(runsDir), []);
});

test("a retried delivery with the same key is acknowledged, not executed again: no second ledger row, no second control entry", () => {
	const { dir, runsDir, task } = fixture();
	const first = executeInstruction({ taskDir: dir, instr: instr(), packet: packetFor(task), runsDir });
	const rowsAfterFirst = readLedger(dir).length;
	const entriesAfterFirst = control(runsDir).length;

	const retry = executeInstruction({ taskDir: dir, instr: instr(), packet: packetFor(loadTask(dir)), runsDir });
	assert.equal(retry.executed, false);
	assert.equal(retry.duplicate, true);
	assert.equal(retry.ledgerRow.seq, first.ledgerRow.seq, "the acknowledgement returns the original row");
	assert.equal(readLedger(dir).length, rowsAfterFirst, "an acknowledgement appends nothing");
	assert.equal(control(runsDir).length, entriesAfterFirst, "and nothing is executed a second time");
	assert.equal(loadTask(dir).budget.wallSec.used, 300, "the grant is spent once");
});

test("restore, compare and accept validate but do not execute yet", () => {
	const { dir, runsDir, task } = fixture();
	assert.throws(
		() => executeInstruction({ taskDir: dir, instr: instr({ verb: "restore", args: { checkpoint: "ck-0007" } }), packet: packetFor(task), runsDir }),
		NotYetImplemented,
	);
});

// ---------- the CLI the manager's side actually calls ----------

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "manage.mjs");

function cli(taskDir, instruction, runsDir) {
	const file = path.join(taskDir, "instr.json");
	fs.writeFileSync(file, JSON.stringify(instruction));
	return spawnSync(process.execPath, [CLI, "execute", taskDir, file, "--runs", runsDir], { encoding: "utf8" });
}

test("tools/manage.mjs execute prints the ledger row, and exits 3 on a refusal", () => {
	const { dir, runsDir, task } = fixture();
	fs.writeFileSync(path.join(dir, "packets", "7.json"), JSON.stringify(packetFor(task)));

	const ok = cli(dir, instr(), runsDir);
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout.trim()).verified, true);
	assert.deepEqual(control(runsDir).map((e) => e.type), ["grant", "decision"]);

	// Stale now, because the grant above moved the task.
	const stale = cli(dir, instr({ idempotencyKey: "p7-v4-again" }), runsDir);
	assert.equal(stale.status, 3);
	assert.match(stale.stderr, /refused \(stale_version\)/);

	// The same key twice is an acknowledgement, not a failure.
	const retry = cli(dir, instr(), runsDir);
	assert.equal(retry.status, 0);
	assert.match(retry.stdout, /already executed/);
});

test("controlAppend creates the run directory and appends one JSON line per entry", () => {
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-ctl-"));
	const runDir = path.join(runsDir, "never-ran");
	controlAppend(runDir, { type: "grant", wallSec: 60 });
	controlAppend(runDir, { type: "decision", verb: "continue" });
	const lines = fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[0]).type, "grant");
	assert.ok(JSON.parse(lines[0]).ts > 0);
});
