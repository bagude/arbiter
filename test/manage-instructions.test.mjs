import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
import { readLedger, appendLedger, recordOutcome } from "../lib/manage/ledger.mjs";
import { INSTRUCTION_VERBS, NOT_YET_IMPLEMENTED, validateInstruction, executeInstruction, controlAppend, NotYetImplemented, batchCeiling, settledBatches, registerRunForTrigger, pendingRuns, settledRuns } from "../lib/manage/instructions.mjs";
import { snapshotCheckpoint } from "../lib/manage/checkpoint.mjs";

const RUN_ID = "2026-09-18T01-02-03";

/** A run as it looks on disk. `ended` writes summary.json; `quietForMs` backdates its audit. */
function mkRun(runsDir, runId, { ended = false, quietForMs = 0, audit = true } = {}) {
	const dir = path.join(runsDir, runId);
	fs.mkdirSync(dir, { recursive: true });
	if (audit) {
		const f = path.join(dir, "audit.jsonl");
		fs.writeFileSync(f, JSON.stringify({ t: "1.0", type: "tool", msg: "bash npm test" }) + "\n");
		if (quietForMs) {
			const when = new Date(Date.now() - quietForMs);
			fs.utimesSync(f, when, when);
		}
	}
	if (ended) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ runId, reason: "SUCCESS: oracle passed" }));
	return dir;
}

/**
 * A task at stateVersion 4 with one live run. The version is reached by saving until the file
 * says 4 rather than by writing the number: saveTask bumps on every write (createTask persists
 * 1), so a hand-set version would be a fixture that could never exist on disk.
 */
function fixture({ budget = { wallSec: 14400, runs: 20, forkReplicates: 24 }, activeRuns = [RUN_ID] } = {}) {
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
	// A registered run has a run directory being written to — that is what makes it live
	// (pendingRuns). A fixture without one describes a state the harness reads as over.
	for (const id of activeRuns) mkRun(runsDir, id);
	task = saveTask(dir, setCurrent(task, { activeRuns, checkpoint: "ck-0007" }));
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

// Task 4 built `accept`, so the list is empty — but the mechanism stays, and so does the test: a
// verb may join the contract (validation, packets, replays) before the harness can carry it out,
// and until it can, executing it must throw rather than quietly do nothing. The `accept` tests
// themselves are at the end of this file.
test("nothing in the contract is unimplemented, and the class that says so is still exported", () => {
	assert.deepEqual(NOT_YET_IMPLEMENTED, []);
	assert.ok(NotYetImplemented.prototype instanceof Error);
});

// ---------- restore and compare (Task 3) ----------

const CALL = 4;

/** The fixture above, plus what a `run:` checkpoint needs on disk: a captured inference and a
 * config to spawn it with. `manage` says whether that config enables the management block a
 * delivered message can only arrive through. No live run by default: §3 refuses a restore while
 * one is going, and the trigger a restore answers is almost always a run that has ENDED. */
function forkFixture({ manage = true, captured = true, budget, live = false } = {}) {
	const f = fixture({ ...(budget ? { budget } : {}), activeRuns: live ? [RUN_ID] : [] });
	const reqDir = path.join(f.runsDir, RUN_ID, "requests");
	fs.mkdirSync(reqDir, { recursive: true });
	if (captured) fs.writeFileSync(path.join(reqDir, "0004.json"), JSON.stringify({ payload: {}, ts: 1 }));
	fs.writeFileSync(path.join(f.runsDir, RUN_ID, "decisions.jsonl"), JSON.stringify({ i: CALL - 1, action: { cls: "inspect", tool: "read" } }) + "\n");
	const config = path.join(f.dir, "config.json");
	fs.writeFileSync(config, JSON.stringify({ task: "x", caps: { wallSec: 60 }, manage: manage ? { enabled: true } : undefined }));
	return { ...f, config, checkpoint: `run:${RUN_ID}#${CALL}` };
}

/** A launcher that records instead of spawning: no test may start a supervisor. */
function recorder() {
	const calls = [];
	return { calls, launchBatch: (arg) => { calls.push(arg); return { pid: 1234 }; } };
}

const spawnsNothing = () => { throw new Error("a test must never launch a batch"); };

test("compare: fewer than two branches, fewer than two replicates, and a budget that cannot pay are all refused", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const p = packetFor(task);
	const v = (args) => validateInstruction(instr({ verb: "compare", args: { checkpoint, config, ...args } }), { task, packet: p, taskDir: dir, runsDir });
	const two = [{ label: "G" }, { label: "A", firstAction: "done" }];
	assert.match(v({ branches: [{ label: "G" }], replicates: 3 }).refusal, /at least 2 branches/);
	assert.match(v({ branches: two, replicates: 1 }).refusal, /replicates >= 2/);
	assert.deepEqual(v({ branches: two, replicates: 3 }), { ok: true });

	// 2 × 13 replicates against the 24 the fixture's budget allows.
	const over = v({ branches: two, replicates: 13 });
	assert.equal(over.code, "budget");
	assert.match(over.refusal, /needs 26 replicates; 24 left/);
});

test("compare: a branch the fork runner could not run is refused here, not inside the batch child", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const p = packetFor(task);
	const v = (branches) => validateInstruction(instr({ verb: "compare", args: { checkpoint, config, branches, replicates: 2 } }), { task, packet: p, taskDir: dir, runsDir });
	assert.match(v([{ label: "G" }, { label: "A", firstAction: "dnoe" }]).refusal, /unknown action class "dnoe"/);
	assert.match(v([{ label: "G" }, { label: "A", firstAction: "answer" }]).refusal, /"answer" cannot be forced/);
	assert.match(v([{ label: "G" }, { label: "G", firstAction: "done" }]).refusal, /labels must be unique/);
	assert.match(v([{ label: "G" }, { label: "../evil", firstAction: "done" }]).refusal, /letters, digits, dot, dash or underscore/);
});

test("restore: a checkpoint whose captured inference is missing is a precondition, through execute as well as validate", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture({ captured: false });
	const i = instr({ verb: "restore", args: { checkpoint, approach: { config } } });
	assert.match(validateInstruction(i, { task, packet: packetFor(task), taskDir: dir, runsDir }).refusal, /no captured inference at run:/);
	const r = executeInstruction({ taskDir: dir, instr: i, packet: packetFor(task), runsDir, launchBatch: spawnsNothing });
	assert.equal(r.executed, false);
	assert.equal(r.code, "precondition");
	assert.equal(readLedger(dir)[0].refused, "precondition", "the refusal is recorded, and nothing was launched");
});

// ck-NNNN checkpoints arrive with Task 4. Refusing by name is the point: a restore that quietly
// fell back to something else would start a run from a state nobody named.
test("restore: a ck- checkpoint is refused as not yet available, and a malformed one by shape", () => {
	const { dir, runsDir, task, config } = forkFixture();
	const v = (checkpoint) => validateInstruction(instr({ verb: "restore", args: { checkpoint, approach: { config } } }), { task, packet: packetFor(task), taskDir: dir, runsDir });
	assert.equal(v("ck-0007").refusal, "checkpoint restore not yet available");
	assert.match(v("yesterday").refusal, /must be ck-NNNN or run:<runId>#<call>/);
});

test("restore: the config must exist, and a message needs a run that reads a control file", () => {
	const noManage = forkFixture({ manage: false });
	const v = (args, f) => validateInstruction(instr({ verb: "restore", args: { checkpoint: f.checkpoint, approach: args } }), { task: f.task, packet: packetFor(f.task), taskDir: f.dir, runsDir: f.runsDir });
	assert.match(v({ config: "configs/nope.json" }, noManage).refusal, /does not exist/);
	assert.match(v({}, noManage).refusal, /name one in args\.approach\.config/, "the packet's run carries no config in this fixture");
	assert.equal(v({ config: noManage.config }, noManage).ok, true, "no message, no control file, no manage block needed");
	assert.match(v({ config: noManage.config, message: "try the tester first" }, noManage).refusal, /no manage\.enabled block/);
	const withManage = forkFixture();
	assert.equal(v({ config: withManage.config, message: "try the tester first" }, withManage).ok, true);
});

// §3's restore precondition. Every live run is on the current milestone — a task has one — and a
// batch in flight is one or more supervisor runs against the single model-server slot, so it
// counts as live too. Without this, two supervisors contend and the fork runner's collision
// preflight resolves it by abandoning a batch the task has already been charged for.
test("restore: refused while a run is live or a batch is in flight, unless parallel is asked for", () => {
	const live = forkFixture({ live: true });
	const v = (f, args, task = f.task, key = "p7-v4") => validateInstruction(instr({ verb: "restore", idempotencyKey: key, basedOnStateVersion: task.stateVersion, args: { checkpoint: f.checkpoint, approach: { config: f.config }, ...args } }), { task, packet: packetFor(task), taskDir: f.dir, runsDir: f.runsDir });
	assert.match(v(live, {}).refusal, /a run is still live on milestone m1 \(2026-09-18T01-02-03\)/);
	assert.equal(v(live, { parallel: true }).ok, true, "parallel: true is the manager saying it meant to");

	// A batch the executor launched is pending until its child clears it.
	const f = forkFixture();
	const { launchBatch } = recorder();
	executeInstruction({ taskDir: f.dir, runsDir: f.runsDir, launchBatch, packet: packetFor(f.task), instr: instr({ verb: "restore", args: { checkpoint: f.checkpoint, approach: { config: f.config } } }) });
	const after = loadTask(f.dir);
	// One branch × one replicate × the fixture config's 60 s cap: the batch says how long it may
	// legitimately take, and batchCeiling reads it so a long batch is not called stale mid-work.
	assert.deepEqual(after.current.activeBranches, [{ batchId: 1, kind: "restore", checkpoint: f.checkpoint, launchedAt: after.current.activeBranches[0].launchedAt, expectedMs: 60_000 }]);
	const second = v(f, {}, after, "p7-v5");
	assert.equal(second.code, "precondition");
	assert.match(second.refusal, /batch 1 is still in flight/);
});

// A restored run is over by the time its id exists (runOnce awaits the supervisor's exit), and
// the child clears the pending batch in the same pass as the outcome row. So `continue` can
// never name one, and must refuse rather than charge a grant into a control file nothing tails.
test("continue cannot name a restored run: the id arrives after the run is dead", () => {
	const { dir, runsDir, task } = fixture({ activeRuns: [] });
	// Written by the producer, not hand-rolled: the reader matches on `kind` and `outcome.runId`,
	// and a fixture row would pass even if recordOutcome wrote something else.
	recordOutcome(dir, "p7-v4", { batchId: 1, runId: "run-from-a-batch" });
	const p = packetFor(task);
	const v = (t) => validateInstruction(instr({ idempotencyKey: "k2", args: { runId: "run-from-a-batch", milestone: "m1" } }), { task: t, packet: packetFor(t), taskDir: dir, runsDir });
	assert.equal(v(task).code, "precondition", "no pending batch: the outcome row is history, not a live run");
	assert.match(v(task).refusal, /not live/);

	// And while the batch IS pending, the same row does make it live — the rule holds for a
	// runner that can publish an id mid-flight, which this one cannot.
	const pending = saveTask(dir, setCurrent(task, { activeBranches: [{ batchId: 1, kind: "restore", launchedAt: Date.now() }] }));
	assert.equal(validateInstruction(instr({ idempotencyKey: "k3", basedOnStateVersion: pending.stateVersion, args: { runId: "run-from-a-batch", milestone: "m1" } }), { task: pending, packet: packetFor(pending), taskDir: dir, runsDir }).ok, true);

	// A batch past the task's staleBatchMs is not pending any more, so neither is its run.
	const old = saveTask(dir, setCurrent(pending, { activeBranches: [{ batchId: 1, kind: "restore", launchedAt: Date.now() - 3 * 60 * 60 * 1000 }] }));
	assert.equal(validateInstruction(instr({ idempotencyKey: "k4", basedOnStateVersion: old.stateVersion, args: { runId: "run-from-a-batch", milestone: "m1" } }), { task: old, packet: packetFor(old), taskDir: dir, runsDir }).code, "precondition");
	void p;
});

// task.json has one writer. The batch child says it is done by writing a marker in its own
// directory, and the executor folds that out of activeBranches in the save it was making anyway.
test("a batch whose child left a done marker stops blocking, and the executor drops it with a ledger note", () => {
	const f = forkFixture();
	const { calls, launchBatch } = recorder();
	const first = instr({ verb: "restore", args: { checkpoint: f.checkpoint, approach: { config: f.config } } });
	executeInstruction({ taskDir: f.dir, runsDir: f.runsDir, launchBatch, packet: packetFor(f.task), instr: first });

	// The child's whole statement about the task: one file, no task.json write.
	fs.writeFileSync(path.join(f.dir, "compares", "1", "done.json"), JSON.stringify({ batchId: 1, status: "ready", ts: Date.now() }));
	const beforeVersion = loadTask(f.dir).stateVersion;

	const second = executeInstruction({
		taskDir: f.dir, runsDir: f.runsDir, launchBatch, packet: packetFor(loadTask(f.dir)),
		instr: instr({ verb: "restore", idempotencyKey: "p7-v5", basedOnStateVersion: beforeVersion, args: { checkpoint: f.checkpoint, approach: { config: f.config } } }),
	});
	assert.equal(second.executed, true, second.refusal);
	assert.deepEqual(loadTask(f.dir).current.activeBranches.map((b) => b.batchId), [2], "the cleared batch is gone, the new one is in");
	assert.ok(readLedger(f.dir).some((r) => r.kind === "batch_cleared" && r.batchId === 1), "and the drop is a fact in the ledger");
	assert.equal(calls.length, 2);
});

// A child killed outright writes no marker. Without this the task refuses every later restore
// and compare until a human edits task.json — the one state a manager cannot escape from.
test("a pending batch older than staleBatchMs stops counting, and is dropped as stale", () => {
	const f = forkFixture();
	const { launchBatch } = recorder();
	const stale = saveTask(f.dir, setCurrent(f.task, { activeBranches: [{ batchId: 1, kind: "compare", checkpoint: f.checkpoint, launchedAt: Date.now() - 3 * 60 * 60 * 1000 }] }));
	const fresh = { ...stale, current: { ...stale.current, activeBranches: [{ ...stale.current.activeBranches[0], launchedAt: Date.now() }] } };
	assert.match(validateInstruction(instr({ verb: "restore", basedOnStateVersion: stale.stateVersion, args: { checkpoint: f.checkpoint, approach: { config: f.config } } }), { task: fresh, packet: packetFor(fresh), taskDir: f.dir, runsDir: f.runsDir }).refusal, /still in flight/, "the same entry, two hours younger, does block");

	const r = executeInstruction({ taskDir: f.dir, runsDir: f.runsDir, launchBatch, packet: packetFor(stale), instr: instr({ verb: "restore", basedOnStateVersion: stale.stateVersion, args: { checkpoint: f.checkpoint, approach: { config: f.config } } }) });
	assert.equal(r.executed, true, r.refusal);
	assert.deepEqual(loadTask(f.dir).current.activeBranches.map((b) => b.batchId), [1], "the stale entry is gone; the id is free again");
	const note = readLedger(f.dir).find((x) => x.kind === "batch_stale");
	assert.ok(note, "dropping a batch nobody closed is a fact about the task, not bookkeeping");
	assert.equal(note.batchId, 1);
});

// The row goes down before the act, so an executor whose compare-and-swap loses leaves a row
// saying `verified: true` for an instruction that never ran — and findByKey would then refuse
// its honest retry as a duplicate of something that never happened. `save` is injected because
// the losing window (load → save) is microseconds wide and cannot be hit from one process.
test("an executor that loses the compare-and-swap refuses stale_version, retracts its row, and frees the key", () => {
	const { dir, runsDir, task } = fixture();
	const packet = packetFor(task);
	// The other executor: it answered its own packet and saved while this one was deciding.
	const loser = (d, t, opts) => {
		saveTask(d, setCurrent(loadTask(d), { checkpoint: "ck-0009" }));
		return saveTask(d, t, opts);
	};

	const r = executeInstruction({ taskDir: dir, runsDir, packet, instr: instr(), launchBatch: spawnsNothing, save: loser });
	assert.equal(r.executed, false);
	assert.equal(r.code, "stale_version");
	assert.equal(r.reversed, true);
	assert.deepEqual(control(runsDir), [], "nothing outside the task directory moved: no grant, no decision");
	assert.equal(loadTask(dir).budget.wallSec.used, 0, "and the grant was not charged");

	const rows = readLedger(dir);
	assert.equal(rows[0].verified, true, "the row is not edited — the ledger is append-only");
	assert.deepEqual({ kind: rows.at(-1).kind, forSeq: rows.at(-1).forSeq, reason: rows.at(-1).reason }, { kind: "reversed", forSeq: rows[0].seq, reason: "stale_version" });

	// The key is free again: the honest retry against the version that won executes.
	const now = loadTask(dir);
	const retry = executeInstruction({ taskDir: dir, runsDir, packet: packetFor(now), instr: instr({ basedOnStateVersion: now.stateVersion }), launchBatch: spawnsNothing });
	assert.equal(retry.executed, true, retry.refusal);
	assert.equal(loadTask(dir).budget.wallSec.used, 300);
});

test("a batch is not stale while its own shape says it should still be running", () => {
	const { task } = fixture();
	const hour = 60 * 60 * 1000;
	// A 2 × 3 compare at the 1800 s cap: six sequential runs, three hours of legitimate work,
	// against a default ceiling of two. The batch's own expectedMs is what saves it.
	const batch = { batchId: 1, kind: "compare", expectedMs: 2 * 3 * 1800 * 1000 };
	assert.equal(batchCeiling(task, batch), 6 * hour);
	const at = (ms) => settledBatches({ ...task, current: { ...task.current, activeBranches: [{ ...batch, launchedAt: Date.now() - ms }] } }, null);
	assert.deepEqual(at(3 * hour), [], "still working, three hours in");
	assert.equal(at(7 * hour)[0]?.why, "stale");
	// A config that caps nothing bounds nothing: the task's own setting is all there is.
	assert.equal(batchCeiling(task, { batchId: 2, expectedMs: 0 }), 2 * hour);
});

// Nothing used to put a supervisor's run into activeRuns: the supervisor cannot write task.json
// and the executor only knew about runs it started itself, which is none of them. Every
// `continue` and `correct` for a real run was therefore refused as "not live" — found on the
// live check of 2026-09-18, where the trigger, the packet and the 120 s default all worked and
// only the instruction answering them could not validate.
test("a live trigger registers its run; an ended trigger removes it; a second packet does neither twice", () => {
	const { dir, runsDir } = fixture({ activeRuns: [] });
	mkRun(runsDir, RUN_ID); // the run the supervisor just triggered on, as it is on disk
	const t = (kind) => ({ kind, runId: RUN_ID, detail: {} });

	const registered = registerRunForTrigger(dir, t("oracle_failed_repeatedly"), { runsDir });
	assert.deepEqual(registered.current.activeRuns, [RUN_ID]);
	assert.equal(readLedger(dir).at(-1).kind, "run_registered");

	// The whole point: a correct now validates, against the version the registration produced.
	const live = loadTask(dir);
	const ok = validateInstruction(instr({ verb: "correct", basedOnStateVersion: live.stateVersion, args: { runId: RUN_ID, message: "the tester's suite is the gate" } }), { task: live, packet: packetFor(live), taskDir: dir, runsDir });
	assert.deepEqual(ok, { ok: true });

	// A second packet for the same run is not a second registration.
	const rows = readLedger(dir).length;
	assert.equal(registerRunForTrigger(dir, t("budget_threshold")), null);
	assert.equal(readLedger(dir).length, rows, "and no second ledger note");
	assert.equal(loadTask(dir).stateVersion, live.stateVersion, "nor a state version bump");

	const ended = registerRunForTrigger(dir, t("run_ended_without_acceptance"));
	assert.deepEqual(ended.current.activeRuns, []);
	assert.equal(readLedger(dir).at(-1).kind, "run_ended");
	// Ending a run that was never live — a fork run reaching comparison_ready — changes nothing.
	assert.equal(registerRunForTrigger(dir, { kind: "comparison_ready", runId: "some-fork-run" }), null);
	assert.equal(registerRunForTrigger(dir, { kind: "not_a_trigger", runId: RUN_ID }), null);
	assert.equal(registerRunForTrigger(dir, { kind: "escalation" }), null, "a trigger with no run is not about a run");
});

// The trigger's runId is the harness's, but `packet` is also a command an operator types. An id
// with no run directory would register as live and then refuse every restore and compare on
// behalf of a run that never existed.
test("registering refuses a run id with no run directory, and says so in the ledger", () => {
	const { dir, runsDir } = fixture({ activeRuns: [] });
	const trigger = { kind: "oracle_failed_repeatedly", runId: "2026-09-18T99-99-99", detail: {} };
	assert.equal(registerRunForTrigger(dir, trigger, { runsDir }), null);
	assert.deepEqual(loadTask(dir).current.activeRuns, []);
	const note = readLedger(dir).at(-1);
	assert.equal(note.kind, "run_missing");
	assert.match(note.reason, /no such run directory/);

	// With the directory there it registers as before.
	mkRun(runsDir, trigger.runId);
	assert.deepEqual(registerRunForTrigger(dir, trigger, { runsDir }).current.activeRuns, [trigger.runId]);

	// Removal is not gated: a run whose records were cleaned up must still be able to leave.
	fs.rmSync(path.join(runsDir, trigger.runId), { recursive: true });
	assert.deepEqual(registerRunForTrigger(dir, { kind: "run_ended_without_acceptance", runId: trigger.runId }, { runsDir }).current.activeRuns, []);
});

// The mirror of the pending-batch rule. A supervisor that is killed never emits an ended
// trigger, and its entry would otherwise refuse every later restore and compare for good.
test("a registered run stops counting when it wrote a summary, or when its audit went quiet", () => {
	const { runsDir, task } = fixture({ activeRuns: ["alive", "finished", "quiet", "just-started"] });
	mkRun(runsDir, "alive");
	mkRun(runsDir, "finished", { ended: true });
	mkRun(runsDir, "quiet", { quietForMs: 45 * 60 * 1000 });
	mkRun(runsDir, "just-started", { audit: false });

	assert.deepEqual(pendingRuns(task, { runsDir }), ["alive", "just-started"], "a directory with no audit line yet may have started seconds ago");
	// A run id with no directory at all is a different case, and a conclusive one: the supervisor
	// makes that directory before it does anything else.
	const gone = { ...task, current: { ...task.current, activeRuns: ["never-was"] } };
	assert.deepEqual(settledRuns(gone, runsDir).map((r) => [r.runId, r.why]), [["never-was", "ended"]]);
	assert.deepEqual(pendingRuns(gone, { runsDir }), []);
	assert.deepEqual(settledRuns(task, runsDir).map((r) => [r.runId, r.why]), [["finished", "ended"], ["quiet", "stale"]]);
	// The ceiling is a ceiling on silence: the same run is live under a longer one.
	assert.equal(pendingRuns(task, { runsDir, staleRunMs: 60 * 60 * 1000 }).includes("quiet"), true);
	// With no runs directory nothing can be judged, so nothing is taken away.
	assert.deepEqual(pendingRuns(task, {}), ["alive", "finished", "quiet", "just-started"]);
});

test("continue and correct are refused for a run whose own records say it is over", () => {
	const { dir, runsDir, task } = fixture();
	mkRun(runsDir, RUN_ID, { ended: true });
	const v = (over) => validateInstruction(instr(over), { task, packet: packetFor(task), taskDir: dir, runsDir });
	assert.match(v({}).refusal, /is not live/, "the summary is on disk: the run is finished, whatever the list still says");
	assert.match(v({ verb: "correct", args: { runId: RUN_ID, message: "keep going" } }).refusal, /is not live/);
});

test("a run that went quiet is folded out of activeRuns by the executor's next save", () => {
	const f = forkFixture();
	saveTask(f.dir, setCurrent(loadTask(f.dir), { activeRuns: ["dead-run"] }));
	mkRun(f.runsDir, "dead-run", { quietForMs: 90 * 60 * 1000 });
	const now = loadTask(f.dir);
	const { launchBatch } = recorder();
	const r = executeInstruction({ taskDir: f.dir, runsDir: f.runsDir, launchBatch, packet: packetFor(now), instr: instr({ verb: "restore", basedOnStateVersion: now.stateVersion, args: { checkpoint: f.checkpoint, approach: { config: f.config } } }) });
	assert.equal(r.executed, true, r.refusal ?? "a run whose supervisor died must not block a restore");
	assert.deepEqual(loadTask(f.dir).current.activeRuns, [], "and it leaves the list in the same save");
	assert.equal(readLedger(f.dir).find((x) => x.kind === "run_stale")?.runId, "dead-run");
});

test("compare: replicates must be a whole number — the budget is charged branches × replicates", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const r = validateInstruction(instr({ verb: "compare", args: { checkpoint, config, branches: [{ label: "G" }, { label: "A", firstAction: "done" }], replicates: 2.5 } }), { task, packet: packetFor(task), taskDir: dir, runsDir });
	assert.equal(r.code, "precondition");
	assert.match(r.refusal, /whole number/);
});

test("restore: spends a run AND a replicate, writes a one-branch spec, and launches the batch detached", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const { calls, launchBatch } = recorder();
	const r = executeInstruction({
		taskDir: dir, runsDir, launchBatch, packet: packetFor(task),
		instr: instr({ verb: "restore", args: { checkpoint, approach: { config, firstAction: "done", message: "the tester's suite is the gate" } } }),
	});
	assert.equal(r.executed, true, r.refusal);
	assert.equal(r.batchId, 1);
	assert.deepEqual(r.ledgerRow.executed, { batchId: 1 }, "a batch names its batch, never the source run it forked from");

	assert.equal(calls.length, 1, "launched exactly once");
	assert.equal(calls[0].specFile, path.join(dir, "compares", "1", "spec.json"));

	const spec = JSON.parse(fs.readFileSync(calls[0].specFile, "utf8"));
	assert.equal(spec.kind, "restore");
	assert.equal(spec.replicates, 1);
	assert.equal(spec.runId, RUN_ID);
	assert.equal(spec.call, CALL);
	assert.equal(spec.recordedTool, "read", "the shape a finding settles under comes from the source run's own record");
	assert.equal(spec.branches.length, 1);
	assert.equal(spec.branches[0].forkBranch, "A-natural", "a forced first action is an A-natural fork; without one it is G");
	assert.equal(spec.branches[0].label, "A-natural");
	const ctl = JSON.parse(fs.readFileSync(spec.branches[0].controlFile, "utf8").trim());
	assert.equal(ctl.type, "correct");
	assert.match(ctl.message, /tester's suite/);

	const after = loadTask(dir);
	assert.equal(after.budget.runs.used, 1);
	assert.equal(after.budget.forkReplicates.used, 1);
	assert.equal(after.stateVersion, 5, "one instruction, one state version bump");
});

test("restore without a forced action is the G branch, and no control file is written", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const { calls, launchBatch } = recorder();
	executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(task), instr: instr({ verb: "restore", args: { checkpoint, approach: { config } } }) });
	const spec = JSON.parse(fs.readFileSync(calls[0].specFile, "utf8"));
	assert.equal(spec.branches[0].forkBranch, "G");
	assert.equal(spec.branches[0].controlFile, null);
	assert.deepEqual(fs.readdirSync(path.join(dir, "compares", "1")).sort(), ["spec.json"]);
});

test("compare: spends branches × replicates, writes the spec both branches, and keeps the ids apart", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const { calls, launchBatch } = recorder();
	const branches = [{ label: "G" }, { label: "A", firstAction: "done", message: "claim now" }];
	const r = executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(task), instr: instr({ verb: "compare", args: { checkpoint, config, branches, replicates: 3 } }) });
	assert.equal(r.executed, true, r.refusal);
	const spec = JSON.parse(fs.readFileSync(calls[0].specFile, "utf8"));
	assert.deepEqual(spec.branches.map((b) => [b.label, b.forkBranch, b.firstAction]), [["G", "G", null], ["A", "A-natural", "done"]]);
	assert.equal(spec.branches[0].controlFile, null);
	assert.ok(spec.branches[1].controlFile.endsWith("control-A.jsonl"));
	assert.equal(spec.scope, "task:t1");

	const after = loadTask(dir);
	assert.equal(after.budget.forkReplicates.used, 6, "two branches × three replicates");
	assert.equal(after.budget.runs.used, 0, "a comparison's replicates are fork budget, not run budget");

	// A second compare while the first is in flight is refused for the same reason a restore is:
	// two batches contend for the one model-server slot and one of them is abandoned, after its
	// whole budget is charged. With parallel it runs, and takes the next id rather than writing
	// over the first one's reports.
	const next = () => ({ idempotencyKey: `p7-v${loadTask(dir).stateVersion}`, basedOnStateVersion: loadTask(dir).stateVersion, verb: "compare" });
	const refused = executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(loadTask(dir)), instr: instr({ ...next(), args: { checkpoint, config, branches: [{ label: "G" }, { label: "A", firstAction: "probe" }], replicates: 2 } }) });
	assert.equal(refused.code, "precondition");
	assert.match(refused.refusal, /batch 1 is still in flight/);

	const second = executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(loadTask(dir)), instr: instr({ ...next(), args: { checkpoint, config, parallel: true, branches: [{ label: "G" }, { label: "A", firstAction: "probe" }], replicates: 2 } }) });
	assert.equal(second.batchId, 2, second.refusal);
	assert.deepEqual(fs.readdirSync(path.join(dir, "compares")).sort(), ["1", "2"]);
});

test("a retried compare launches nothing a second time", () => {
	const { dir, runsDir, task, config, checkpoint } = forkFixture();
	const { calls, launchBatch } = recorder();
	const i = instr({ verb: "compare", args: { checkpoint, config, branches: [{ label: "G" }, { label: "A", firstAction: "done" }], replicates: 2 } });
	executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(task), instr: i });
	const retry = executeInstruction({ taskDir: dir, runsDir, launchBatch, packet: packetFor(loadTask(dir)), instr: i });
	assert.equal(retry.duplicate, true);
	assert.equal(calls.length, 1, "§3: a restore or compare can never launch twice");
	assert.deepEqual(fs.readdirSync(path.join(dir, "compares")), ["1"], "and no second batch directory is reserved");
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
	// The message carries stderr: this assertion saw a null status once in review, and a spawn
	// that failed to start says why there and nowhere else.
	assert.equal(retry.status, 0, retry.stderr ?? String(retry.error));
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

// ---------- accept (Task 4) ----------

/**
 * A task whose three milestones want the three evidence kinds a test can produce, a checkpoint of
 * a real workspace, and a run that passed the oracle on exactly that tree.
 *
 * Everything is real on disk rather than stubbed: §6 is a claim about what the harness can verify
 * from a run's own records, and a fixture that hands checkEvidence a prepared answer would test
 * the accept branch against itself.
 */
function acceptFixture({ oracle = [[1, 70, 70]], mutateRunWorkspace = null } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-accept-"));
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-accept-runs-"));
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "manage-accept-ws-"));
	fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
	fs.writeFileSync(path.join(ws, "docs", "a.md"), "notes\n");
	fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(ws, ".pi", "agents.md"), "host\n");

	createTask({
		dir,
		taskId: "t4",
		goal: "a goal",
		criteria: [
			{ id: "c1", text: "the oracle passes", check: "oracle:tasks/pathnorm/oracle" },
			{ id: "c2", text: "the notes exist", check: "artifact:docs/a.md:nonempty" },
			{ id: "c3", text: "a human looked", check: "review:human" },
		],
		milestones: [
			{ id: "m1", title: "first", criteria: ["c1", "c2"] },
			{ id: "m2", title: "second", criteria: ["c3"] },
			{ id: "m3", title: "third", criteria: [] },
		],
		budget: { runs: 20 },
	});
	const ck = snapshotCheckpoint({ taskDir: dir, fromDir: ws, runId: "2026-09-18T09-00-00", oracle: { attempt: 1, pass: 70, total: 70 } });

	const runDir = path.join(runsDir, "r1");
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ runId: "r1", task: "pathnorm", reason: "SUCCESS" }));
	fs.writeFileSync(path.join(runDir, "audit.jsonl"), oracle.map(([n, p, t]) => JSON.stringify({ t: "1.0", type: "oracle", msg: `Oracle run #${n}: ${p}/${t} passed.` })).join("\n") + "\n");
	fs.cpSync(ws, path.join(runDir, "ws-builder"), { recursive: true, filter: (src) => path.basename(src) !== ".pi" });
	if (mutateRunWorkspace) mutateRunWorkspace(path.join(runDir, "ws-builder"));

	const task = loadTask(dir);
	return { dir, runsDir, ws, ck, task };
}

const acceptInstr = (task, over = {}) => ({
	packetId: 11,
	basedOnStateVersion: task.stateVersion,
	idempotencyKey: `p11-v${task.stateVersion}`,
	verb: "accept",
	args: { milestone: "m1", checkpoint: "ck-0001", evidence: ["r1"] },
	rationale: "the oracle passed on this checkpoint",
	...over,
});

const acceptPacket = (task) => ({
	packetId: 11,
	trigger: { kind: "milestone_candidate", runId: "r1", detail: {} },
	task,
	run: { id: "r1" },
	options: { verbsAllowed: ["accept", "escalate"], budgetLeft: {} },
});

test("accept advances the milestone, the current pointer and the checkpoint, in one version bump", () => {
	const { dir, runsDir, task } = acceptFixture();
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });

	assert.equal(out.executed, true, out.refusal);
	const after = loadTask(dir);
	assert.equal(after.stateVersion, task.stateVersion + 1, "one instruction, one write");
	assert.equal(after.milestones[0].status, "accepted");
	assert.equal(after.milestones[0].acceptedCheckpoint, "ck-0001");
	assert.ok(after.milestones[0].acceptedAt > 0);
	assert.deepEqual(after.milestones[0].evidence, ["oracle:runs/r1/oracle-1", "artifact:docs/a.md:nonempty"], "what satisfied the criteria, not the run ids that were offered");
	assert.equal(after.milestones[1].status, "active", "the next pending milestone becomes active");
	assert.equal(after.milestones[2].status, "pending");
	assert.equal(after.current.milestone, "m2");
	assert.equal(after.current.checkpoint, "ck-0001");
	assert.equal(after.status, "active");
	assert.equal(out.accepted.next, "m2");
	// The ledger says what happened, beside the instruction's own row.
	const rows = readLedger(dir);
	assert.equal(rows.at(-1).kind, "accepted");
	assert.deepEqual(rows.at(-1).evidence, ["oracle:runs/r1/oracle-1", "artifact:docs/a.md:nonempty"]);
});

test("one failing criterion refuses the whole accept, names it, and changes nothing", () => {
	// m1 wants c1 (oracle) and c2 (a non-empty docs/a.md). Emptying the file in the CHECKPOINT is
	// the honest failure: the checkpoint is the state being accepted.
	const { dir, runsDir, task, ck } = acceptFixture();
	fs.writeFileSync(path.join(ck.dir, "docs", "a.md"), "");
	const before = fs.readFileSync(path.join(dir, "task.json"), "utf8");

	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });
	assert.equal(out.executed, false);
	assert.equal(out.code, "precondition");
	assert.match(out.refusal, /criterion c2 \(artifact:docs\/a\.md:nonempty\)/);
	assert.match(out.refusal, /is empty/);
	assert.equal(fs.readFileSync(path.join(dir, "task.json"), "utf8"), before, "a refused accept must not touch task.json");
	assert.equal(out.ledgerRow.verified, false, "and the refusal is a ledger row");
});

test("a run that passed a different tree is not evidence for this checkpoint", () => {
	const { dir, runsDir, task } = acceptFixture({ mutateRunWorkspace: (ws) => fs.writeFileSync(path.join(ws, "docs", "a.md"), "notes, edited after the oracle\n") });
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });
	assert.equal(out.executed, false);
	assert.match(out.refusal, /criterion c1 \(oracle:tasks\/pathnorm\/oracle\)/);
	assert.match(out.refusal, /hashes [0-9a-f]{40}/);
	assert.equal(loadTask(dir).milestones[0].status, "active");
});

test("a failing oracle refuses, whatever the manager asserts", () => {
	const { dir, runsDir, task } = acceptFixture({ oracle: [[1, 69, 70]] });
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });
	assert.equal(out.executed, false);
	assert.match(out.refusal, /69\/70/);
});

test("a milestone that is not the current, active one cannot be accepted", () => {
	const { dir, runsDir, task } = acceptFixture();
	const later = executeInstruction({ taskDir: dir, instr: acceptInstr(task, { args: { milestone: "m2", checkpoint: "ck-0001", evidence: ["r1"] } }), packet: acceptPacket(task), runsDir });
	assert.equal(later.executed, false);
	assert.match(later.refusal, /milestone m2 is not current \(m1\)/);

	const none = executeInstruction({ taskDir: dir, instr: acceptInstr(task, { idempotencyKey: "p11-x", args: { milestone: "m9", checkpoint: "ck-0001", evidence: ["r1"] } }), packet: acceptPacket(task), runsDir });
	assert.equal(none.executed, false);
	assert.match(none.refusal, /no milestone m9/);
});

test("a candidate checkpoint is refused with the command that promotes it", () => {
	const { dir, runsDir, task, ws } = acceptFixture();
	snapshotCheckpoint({ taskDir: dir, fromDir: ws, runId: "r1", id: "cand-r1" });
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task, { args: { milestone: "m1", checkpoint: "cand-r1", evidence: ["r1"] } }), packet: acceptPacket(task), runsDir });
	assert.equal(out.executed, false);
	assert.match(out.refusal, /promote it first/);
});

test("a checkpoint that is not on disk is refused before any criterion is checked", () => {
	const { dir, runsDir, task } = acceptFixture();
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task, { args: { milestone: "m1", checkpoint: "ck-0099", evidence: ["r1"] } }), packet: acceptPacket(task), runsDir });
	assert.equal(out.executed, false);
	assert.match(out.refusal, /no checkpoint ck-0099/);
});

test("accepting the last milestone completes the task", () => {
	const { dir, runsDir, task } = acceptFixture();
	let t = task;
	const step = (milestone, key) => {
		const r = executeInstruction({ taskDir: dir, instr: acceptInstr(t, { idempotencyKey: key, args: { milestone, checkpoint: "ck-0001", evidence: ["r1"] } }), packet: acceptPacket(t), runsDir });
		assert.equal(r.executed, true, r.refusal);
		t = loadTask(dir);
	};
	step("m1", "a1");
	// m2 wants review:human — the one kind only a human can produce.
	const refused = executeInstruction({ taskDir: dir, instr: acceptInstr(t, { idempotencyKey: "a2-early", args: { milestone: "m2", checkpoint: "ck-0001", evidence: ["r1"] } }), packet: acceptPacket(t), runsDir });
	assert.equal(refused.executed, false);
	assert.match(refused.refusal, /criterion c3 \(review:human\): no signed review row/);
	appendLedger(dir, { kind: "review", criterion: "c3", checkpoint: "ck-0001", by: "david", signed: true });
	t = loadTask(dir);
	step("m2", "a2");
	assert.equal(loadTask(dir).milestones[1].evidence[0], "review:david");
	step("m3", "a3");

	const done = loadTask(dir);
	assert.equal(done.status, "complete");
	assert.equal(done.current.milestone, null);
	assert.equal(done.current.checkpoint, "ck-0001");
	assert.ok(done.milestones.every((m) => m.status === "accepted"));
});

test("a playthrough criterion runs the script once, through the injected spawn", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-play-"));
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-play-runs-"));
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "manage-play-ws-"));
	fs.writeFileSync(path.join(ws, "game.mjs"), "export const play = 1;\n");
	const script = path.join(dir, "play.mjs");
	fs.writeFileSync(script, "// a playthrough\n");
	createTask({ dir, taskId: "t4p", goal: "g", criteria: [{ id: "c1", text: "it plays", check: `playthrough:${script}` }], milestones: [{ id: "m1", title: "only", criteria: ["c1"] }] });
	snapshotCheckpoint({ taskDir: dir, fromDir: ws, runId: "r1" });
	const task = loadTask(dir);

	let calls = 0;
	const spawn = () => (calls++, { status: 0, stdout: "played 12 rooms\n", stderr: "" });
	const out = executeInstruction({ taskDir: dir, instr: acceptInstr(task, { args: { milestone: "m1", checkpoint: "ck-0001", evidence: ["r1"] } }), packet: acceptPacket(task), runsDir, spawn });

	assert.equal(out.executed, true, out.refusal);
	assert.equal(calls, 1, "the executor must not re-run what validation already ran");
	assert.equal(loadTask(dir).status, "complete");
	assert.equal(fs.readFileSync(path.join(dir, "checkpoints", "ck-0001", "evidence", "c1.log"), "utf8"), "played 12 rooms\n");
});

test("tools/manage.mjs accept and checkpoint drive the same executor from a terminal", () => {
	const { dir, runsDir, task, ws } = acceptFixture();
	const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

	// A candidate the run left behind: listed, promoted, and only then acceptable.
	snapshotCheckpoint({ taskDir: dir, fromDir: ws, runId: "r1", id: "cand-r1" });
	const listed = run("checkpoint", "list", dir);
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /cand-r1\tcandidate/);
	assert.match(listed.stdout, /ck-0001\taccepted/);

	const early = run("accept", dir, "m1", "cand-r1", "--evidence", "r1", "--runs", runsDir);
	assert.equal(early.status, 3);
	assert.match(early.stderr, /promote it first/);

	const promoted = run("checkpoint", "promote", dir, "cand-r1");
	assert.equal(promoted.status, 0, promoted.stderr);
	assert.match(promoted.stdout, /cand-r1 → ck-0002/);

	// No packet on disk: the command synthesises one, and the executor checks it like any other.
	const ok = run("accept", dir, "m1", "ck-0001", "--evidence", "r1", "--runs", runsDir);
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout.trim()).verified, true);
	assert.equal(loadTask(dir).current.milestone, "m2");
	assert.equal(loadTask(dir).stateVersion, task.stateVersion + 1);

	const again = run("accept", dir, "m1", "ck-0001", "--evidence", "r1", "--runs", runsDir);
	assert.equal(again.status, 0, again.stderr);
	assert.match(again.stdout, /already executed/, "the same acceptance twice is an acknowledgement");
});

test("a retried accept is acknowledged, not verified again", () => {
	const { dir, runsDir, task } = acceptFixture();
	const first = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });
	assert.equal(first.executed, true, first.refusal);
	const again = executeInstruction({ taskDir: dir, instr: acceptInstr(task), packet: acceptPacket(task), runsDir });
	assert.equal(again.duplicate, true);
	assert.equal(loadTask(dir).stateVersion, task.stateVersion + 1, "and nothing is written a second time");
});
