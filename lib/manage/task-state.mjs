// task-state — the durable account of where a task stands (spec §1). task.json is rewritten
// atomically on every change and carries a stateVersion that every packet and instruction
// names; acceptance criteria are hashed at creation and can never be changed by a save.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// §1's budget shape, plus `toolCalls`. §3's `continue` grant carries `{ wallSec, toolCalls }`
// while §1's example budget names only wall time, which left a tool-call grant bounded by
// nothing: the harness raised the run's cap by whatever the manager asked for, so "budgets are
// the harness's to enforce" held for one half of the same grant. `toolCalls` behaves exactly
// like every other key here, including the zero-is-unbounded convention spendBudget documents
// below — a task created without one grants tool calls freely, as it always did.
export const BUDGET_KEYS = ["wallSec", "toolCalls", "runs", "forkReplicates", "usd"];

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

/**
 * Atomic write; bumps stateVersion; refuses a task whose acceptance no longer matches its own
 * hash (self-consistency), AND — when a task.json already exists — refuses one whose hash
 * differs from the persisted one, even if the caller recomputed a matching hash for weaker
 * criteria (true immutability: acceptance can never change after createTask, full stop).
 */
export function saveTask(dir, task) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error("acceptance criteria do not match their hash — criteria are immutable; escalate instead");
	const file = path.join(dir, "task.json");
	if (fs.existsSync(file)) {
		const prev = JSON.parse(fs.readFileSync(file, "utf8"));
		if (prev.acceptance.hash !== task.acceptance.hash) throw new Error("acceptance is immutable — hash differs from the persisted task; escalate instead");
	}
	const next = { ...task, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: Date.now() };
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
	fs.renameSync(tmp, file);
	return next;
}

export function setCurrent(task, patch) {
	return { ...task, current: { ...task.current, ...patch } };
}

export class BudgetExceeded extends Error {}

// Convention, deliberate on both sides: a budget key whose `total` is 0 (a human never set it
// in `createTask`) is treated as UNBOUNDED for that resource, not as a hard cap of zero — there
// is currently no way to express "this resource is capped at exactly zero." `spendBudget`'s
// `if (b.total && ...)` guard skips the ceiling check when total is 0, and `budgetLeft` reports
// `null` (not 0) for the same case, so callers can tell "uncapped" apart from "fully spent".
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
