// task-state — the durable account of where a task stands (spec §1). task.json is rewritten
// atomically on every change and carries a stateVersion that every packet and instruction
// names; acceptance criteria are hashed at creation and can never be changed by a save.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const BUDGET_KEYS = ["wallSec", "runs", "forkReplicates", "usd"];

export function acceptanceHash(criteria) {
	return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

function budgetShape(budget = {}) {
	const out = {};
	for (const k of BUDGET_KEYS) out[k] = { total: Number(budget[k] ?? 0), used: 0 };
	return out;
}

export function createTask({ dir, taskId, goal, criteria, milestones, budget = {} }) {
	if (!Array.isArray(criteria) || !criteria.length) throw new Error("a task needs at least one acceptance criterion");
	for (const c of criteria) if (!c.id || !c.text || !/^(oracle|playthrough|artifact|review):/.test(c.check ?? "")) throw new Error(`criterion ${c.id ?? "?"}: needs id, text and a check of kind oracle:|playthrough:|artifact:|review:`);
	const ms = (milestones ?? []).map((m, i) => ({ id: m.id, title: m.title, criteria: m.criteria ?? [], status: i === 0 ? "active" : "pending" }));
	const task = {
		taskId, goal,
		acceptance: { criteria, hash: acceptanceHash(criteria) },
		milestones: ms,
		current: { milestone: ms[0]?.id ?? null, checkpoint: null, activeRuns: [], activeBranches: [] },
		blockers: [],
		budget: budgetShape(budget),
		status: "active",
		stateVersion: 0,
	};
	fs.mkdirSync(path.join(dir, "packets"), { recursive: true });
	fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
	return saveTask(dir, task);
}

export function loadTask(dir) {
	return JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
}

/** Atomic write; bumps stateVersion; refuses a task whose acceptance no longer matches its hash. */
export function saveTask(dir, task) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error("acceptance criteria do not match their hash — criteria are immutable; escalate instead");
	const next = { ...task, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: Date.now() };
	const file = path.join(dir, "task.json");
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
	fs.renameSync(tmp, file);
	return next;
}

export function setCurrent(task, patch) {
	return { ...task, current: { ...task.current, ...patch } };
}

export class BudgetExceeded extends Error {}

export function spendBudget(task, spend) {
	const budget = { ...task.budget };
	for (const [k, v] of Object.entries(spend)) {
		if (!BUDGET_KEYS.includes(k)) throw new Error(`unknown budget ${k}`);
		const b = budget[k];
		if (b.total && b.used + v > b.total) throw new BudgetExceeded(`budget ${k}: ${b.used} + ${v} > ${b.total}`);
		budget[k] = { ...b, used: b.used + v };
	}
	return { ...task, budget };
}

export function budgetLeft(task) {
	return Object.fromEntries(BUDGET_KEYS.map((k) => [k, task.budget[k].total ? task.budget[k].total - task.budget[k].used : null]));
}
