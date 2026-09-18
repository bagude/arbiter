import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, loadTask, saveTask, acceptanceHash, spendBudget, setCurrent } from "../lib/manage/task-state.mjs";

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
