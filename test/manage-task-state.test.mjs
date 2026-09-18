import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, loadTask, saveTask, acceptanceHash, spendBudget, budgetLeft, setCurrent, BUDGET_KEYS, StaleVersion } from "../lib/manage/task-state.mjs";
import { assemblePacket } from "../lib/manage/packet.mjs";
import { validateInstruction } from "../lib/manage/instructions.mjs";

const criteria = [{ id: "c1", text: "all 70 oracle cases pass", check: "oracle:tasks/pathnorm/oracle" }];
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "task-"));

test("createTask writes task.json with version 1, the acceptance hash, and pending milestones", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "pass pathnorm", criteria, milestones: [{ id: "m1", title: "pass", criteria: ["c1"] }], budget: { wallSec: 3600, runs: 4, forkReplicates: 12, usd: 5 } });
	assert.equal(t.stateVersion, 1);
	assert.equal(t.acceptance.hash, acceptanceHash(criteria));
	assert.equal(t.milestones[0].status, "active", "the first milestone is active, later ones pending");
	assert.equal(t.current.milestone, "m1");
	assert.deepEqual(loadTask(dir), t);
	assert.ok(fs.existsSync(path.join(dir, "task.json")));
});

test("saveTask increments the version atomically and refuses a changed acceptance", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: {} });
	const t2 = saveTask(dir, setCurrent(t, { activeRuns: ["r1"] }));
	assert.equal(t2.stateVersion, 2);
	assert.deepEqual(loadTask(dir).current.activeRuns, ["r1"]);
	const tampered = { ...loadTask(dir), acceptance: { criteria: [{ id: "c1", text: "weaker", check: "oracle:x" }], hash: acceptanceHash(criteria) } };
	assert.throws(() => saveTask(dir, tampered), /acceptance/);
	assert.ok(!fs.existsSync(path.join(dir, "task.json.tmp")), "no temp file left behind");
});

// Two writers that loaded the same task both write, the second discards the first's change, and
// both results carry the SAME stateVersion — which is what §3's staleness check trusts to be
// impossible. expectedVersion makes the write a compare-and-swap for callers that hold a task.
test("saveTask with an expectedVersion that no longer matches throws and writes nothing", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: {} });
	const mine = setCurrent(t, { activeRuns: ["r1"] });

	// Somebody else saves first.
	saveTask(dir, setCurrent(t, { checkpoint: "ck-0001" }));
	const onDisk = loadTask(dir);
	assert.throws(() => saveTask(dir, mine, { expectedVersion: t.stateVersion }), StaleVersion);
	assert.deepEqual(loadTask(dir), onDisk, "the file is untouched — the whole change was computed against a task that no longer exists");

	// Against the current version it goes through, and the other writer's change survives.
	const ok = saveTask(dir, setCurrent(onDisk, { activeRuns: ["r1"] }), { expectedVersion: onDisk.stateVersion });
	assert.equal(ok.stateVersion, onDisk.stateVersion + 1);
	assert.equal(ok.current.checkpoint, "ck-0001");
	// Omitted, it behaves exactly as it always did.
	assert.equal(saveTask(dir, loadTask(dir)).stateVersion, ok.stateVersion + 1);
});

test("saveTask refuses a self-consistent hash for weaker criteria — acceptance is immutable against the persisted task, not just against itself", () => {
	const dir = mk();
	createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: {} });
	const before = fs.readFileSync(path.join(dir, "task.json"), "utf8");
	const weaker = [{ id: "c1", text: "only 1 of 70 oracle cases must pass", check: "oracle:tasks/pathnorm/oracle" }];
	const t = loadTask(dir);
	assert.throws(() => saveTask(dir, { ...t, acceptance: { criteria: weaker, hash: acceptanceHash(weaker) } }), /acceptance/);
	assert.equal(fs.readFileSync(path.join(dir, "task.json"), "utf8"), before, "the file on disk is untouched");
});

test("spendBudget charges and refuses past the total", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: { runs: 2 } });
	const t2 = spendBudget(t, { runs: 1 });
	assert.equal(t2.budget.runs.used, 1);
	assert.throws(() => spendBudget(t2, { runs: 2 }), /BudgetExceeded|budget/);
});

// A task.json outlives the code that wrote it — that is what the task directory is for — so
// BUDGET_KEYS can gain a key while tasks written under the old list are still live. This
// fixture is the shape tasks-live/pathnorm-night/task.json has on disk: no `toolCalls`. Before
// the read-side normalisation, every path through budgetLeft threw a TypeError on it, so
// assembling a packet or refusing an instruction CRASHED instead of answering.
function legacyTaskDir() {
	const dir = mk();
	createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: { wallSec: 25200, runs: 6, forkReplicates: 24, usd: 5 } });
	const file = path.join(dir, "task.json");
	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	delete raw.budget.toolCalls; // as written before toolCalls joined BUDGET_KEYS
	fs.writeFileSync(file, JSON.stringify(raw, null, 2));
	return dir;
}

test("a task.json missing a budget key reads as unset, not as a crash", () => {
	const dir = legacyTaskDir();
	assert.ok(!("toolCalls" in JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")).budget), "the fixture must really lack the key on disk");

	const task = loadTask(dir);
	for (const k of BUDGET_KEYS) assert.deepEqual(Object.keys(task.budget[k]).sort(), ["total", "used"], `loadTask must normalise ${k}`);
	assert.equal(budgetLeft(task).toolCalls, null, "a key the file never had is unbounded, like one set to zero");
	assert.equal(budgetLeft(task).wallSec, 25200, "and the keys it did have are untouched");
	assert.equal(spendBudget(task, { toolCalls: 400 }).budget.toolCalls.used, 400, "an unbounded key is charged, never refused");

	// The read must not rewrite the durable record: a load would otherwise bump the state
	// version through saveTask and invalidate a packet already in flight.
	assert.ok(!("toolCalls" in JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")).budget), "loadTask must not write");

	// Tolerant of a hand-built task object too, not only of what loadTask normalised.
	const raw = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
	assert.equal(budgetLeft(raw).toolCalls, null);
	assert.equal(spendBudget(raw, { toolCalls: 1 }).budget.toolCalls.used, 1);
});

test("the two commands Step 9 runs against such a task answer instead of throwing", () => {
	const dir = legacyTaskDir();
	const task = loadTask(dir);

	// `tools/manage.mjs packet` — assemblePacket over a minimal run record.
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
	fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ runId: "r1", wallSec: 10 }));
	const packet = assemblePacket({ taskDir: dir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: {} } });
	assert.equal(packet.options.budgetLeft.toolCalls, null);
	assert.ok(packet.options.verbsAllowed.includes("continue"));

	// `tools/manage.mjs execute` — an instruction that should be cleanly REFUSED must be
	// refused, not crash on its way through budgetRefusal.
	const bad = validateInstruction({ packetId: packet.packetId, basedOnStateVersion: task.stateVersion, idempotencyKey: "k1", verb: "continue", args: { runId: "nope", milestone: "m1" } }, { task, packet, taskDir: dir });
	assert.equal(bad.code, "precondition");
	assert.match(bad.refusal, /not live/);
});
