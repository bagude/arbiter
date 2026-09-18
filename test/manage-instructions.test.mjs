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

// §1 says budgets are the harness's to enforce, and §3's grant carries both halves. A grant
// larger than the task has left is refused BEFORE anything raises a cap, and an executed one
// is charged to the task, so the manager cannot hand out the same budget twice.
test("a continue grant is bounded by the task budget, in both wallSec and toolCalls", () => {
	const { dir, runsDir, task } = fixture({ budget: { wallSec: 1000, toolCalls: 100, runs: 20 } });
	const p = packetFor(task);
	const over = (grant) => validateInstruction(instr({ args: { runId: RUN_ID, milestone: "m1", budgetGrant: grant } }), { task, packet: p, taskDir: dir });
	assert.equal(over({ wallSec: 1001 }).code, "budget");
	assert.match(over({ wallSec: 1001 }).refusal, /wallSec 1001 exceeds the 1000/);
	assert.equal(over({ toolCalls: 101 }).code, "budget", "a tool-call grant must be bounded too — it raises a cap exactly as wallSec does");
	assert.equal(over({ wallSec: 1000, toolCalls: 100 }).ok, true, "spending the budget to the last unit is allowed");
	assert.equal(over({ wallSec: 300, toolCalls: [50] }).code, "precondition", "an array budgetGrant is not an object");

	// Executed: both halves are charged, in one write, and the second grant is measured
	// against what the first left.
	executeInstruction({ taskDir: dir, instr: instr({ args: { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 900, toolCalls: 90 } } }), packet: p, runsDir });
	const spent = loadTask(dir);
	assert.equal(spent.budget.wallSec.used, 900);
	assert.equal(spent.budget.toolCalls.used, 90);
	assert.equal(spent.stateVersion, 5, "one instruction, one state version bump");
	const next = validateInstruction(instr({ idempotencyKey: "p7-v5", basedOnStateVersion: 5, args: { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 200 } } }), { task: spent, packet: packetFor(spent), taskDir: dir });
	assert.equal(next.code, "budget", "only 100s remain");
});

test("a budget key the task never set is unbounded, not a ceiling of zero", () => {
	const { dir, task } = fixture({ budget: { runs: 20 } });
	const r = validateInstruction(instr({ args: { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 99999, toolCalls: 99999 } } }), { task, packet: packetFor(task), taskDir: dir });
	assert.deepEqual(r, { ok: true }, "a task created without a wall or tool budget grants freely, as it always did");
});

test("the remaining preconditions: a milestone that is not current, compare's limits, escalate's wants", () => {
	const { dir, task } = fixture();
	const p = packetFor(task);
	const v = (over) => validateInstruction(instr(over), { task, packet: p, taskDir: dir });
	assert.match(v({ args: { runId: RUN_ID, milestone: "m9" } }).refusal, /milestone m9 is not current \(m1\)/);
	assert.match(v({ verb: "compare", args: { checkpoint: "ck-0007", branches: [{ label: "a" }], replicates: 3 } }).refusal, /at least 2 branches/);
	assert.match(v({ verb: "compare", args: { checkpoint: "ck-0007", branches: [{ label: "a" }, { label: "b" }], replicates: 1 } }).refusal, /replicates >= 2/);
	assert.match(v({ verb: "escalate", args: { reason: "blocked", wants: "more_time" } }).refusal, /criteria_change, human_review or budget/);
	assert.match(v({ verb: "escalate", args: { wants: "budget" } }).refusal, /requires args\.reason/);
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

// The refusal above tells the manager to escalate instead, so an escalate that cannot name the
// acceptance criterion it is objecting to would make that advice impossible to follow.
test("escalate is exempt from the acceptance scan — it is the escape hatch the refusal recommends", () => {
	const { dir, runsDir, task } = fixture();
	const reason = "criterion c1's acceptance check tests an interface the specification never names";
	const args = { reason, wants: "criteria_change" };
	assert.deepEqual(validateInstruction(instr({ verb: "escalate", args }), { task, packet: packetFor(task), taskDir: dir }), { ok: true });
	const r = executeInstruction({ taskDir: dir, instr: instr({ verb: "escalate", args }), packet: packetFor(task), runsDir });
	assert.equal(r.executed, true);
	// Exempt from the scan, still powerless over the criteria: what it writes is a blocker and a
	// paused task, and saveTask refuses an acceptance change independently of any of this.
	const after = loadTask(dir);
	assert.equal(after.acceptance.hash, task.acceptance.hash);
	assert.equal(after.blockers[0].text, reason);
	// The other five verbs keep the scan. (A fresh key: the escalate above took p7-v4.)
	assert.equal(validateInstruction(instr({ idempotencyKey: "p7-v4-correct", verb: "correct", args: { runId: RUN_ID, message: reason } }), { task, packet: packetFor(task), taskDir: dir }).code, "precondition");
});

// A refusal is a ledger row, but it is not an execution. Reusing the key after one is the
// natural retry — the key names one answer to one packet, and the packet is still open.
test("a refused key is free to be retried with a corrected instruction", () => {
	const { dir, runsDir, task } = fixture();
	const packet = packetFor(task);
	const first = executeInstruction({ taskDir: dir, instr: instr({ rationale: "y".repeat(501) }), packet, runsDir });
	assert.equal(first.executed, false);
	assert.equal(first.code, "precondition");

	// Same key, corrected instruction. Nothing ran under it, the task never moved: this executes.
	const good = executeInstruction({ taskDir: dir, instr: instr({ rationale: "short enough now" }), packet, runsDir });
	assert.equal(good.executed, true, good.refusal);
	assert.deepEqual(control(runsDir).map((e) => e.type), ["grant", "decision"]);

	// And now the key IS taken: a third delivery is an acknowledgement, not a third run.
	const third = executeInstruction({ taskDir: dir, instr: instr(), packet: packetFor(loadTask(dir)), runsDir });
	assert.equal(third.duplicate, true);
	assert.equal(third.ledgerRow.seq, good.ledgerRow.seq, "the acknowledgement names the row that executed, never the refusal");
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
