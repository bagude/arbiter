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

/**
 * Every BUDGET_KEYS entry present, preserving whatever the file already had.
 *
 * A task.json outlives the code that wrote it — that is the whole point of the task directory —
 * so BUDGET_KEYS can gain a key while tasks created under the old list are still live. A
 * missing entry means the same thing an unset one does: `{ total: 0, used: 0 }`, which the
 * zero-is-unbounded convention below reads as "this resource was never capped". Without this,
 * adding `toolCalls` made `budgetLeft` throw a TypeError on every task written before it, and a
 * packet assembly or an instruction refusal crashed instead of answering.
 */
function withEveryBudgetKey(budget = {}) {
	const out = { ...budget };
	for (const k of BUDGET_KEYS) out[k] = { total: 0, used: 0, ...(budget[k] ?? {}) };
	return out;
}

/** How long a batch may sit in `current.activeBranches` before a reader stops believing in it.
 * A batch is branches × replicates supervisor runs, so the ceiling is generous; past it the
 * entry is ignored and then dropped, rather than blocking every later restore and compare until
 * a human edits task.json. */
export const DEFAULT_STALE_BATCH_MS = 2 * 60 * 60 * 1000;

/** This task's ceiling, for a task.json written before the field existed. */
export const staleBatchMs = (task) => Number(task?.staleBatchMs ?? DEFAULT_STALE_BATCH_MS);

export function createTask({ dir, taskId, goal, criteria, milestones, budget = {}, staleBatchMs: stale = DEFAULT_STALE_BATCH_MS }) {
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
		staleBatchMs: stale,
		status: "active",
		stateVersion: 0,
	};
	fs.mkdirSync(path.join(dir, "packets"), { recursive: true });
	fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
	return saveTask(dir, task);
}

/**
 * The task as written, with the budget normalised so every caller sees every key. Normalising
 * on read rather than on write keeps the file itself untouched until something else saves it:
 * a read must never rewrite the durable record, and `saveTask` bumps the state version, which
 * would invalidate a packet in flight just because someone loaded the task.
 */
export function loadTask(dir) {
	const task = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
	return { ...task, budget: withEveryBudgetKey(task.budget) };
}

/** A save whose base was not the state on disk. Thrown, never swallowed: the caller's whole
 * change was computed against a task that no longer exists. */
export class StaleVersion extends Error {}

/**
 * Atomic write; bumps stateVersion; refuses a task whose acceptance no longer matches its own
 * hash (self-consistency), AND — when a task.json already exists — refuses one whose hash
 * differs from the persisted one, even if the caller recomputed a matching hash for weaker
 * criteria (true immutability: acceptance can never change after createTask, full stop).
 *
 * `expectedVersion` makes the write a compare-and-swap. Every save here is a read-modify-write,
 * and the version is bumped from whatever the CALLER loaded — so two writers that loaded the
 * same task both write, the second silently discards the first's change, and both results carry
 * the SAME stateVersion. §3's version check is the whole basis for "the manager did not see this
 * state", and a duplicated version defeats it without a trace. Callers that hold a task they
 * loaded pass the version they loaded; the write throws StaleVersion and leaves the file
 * untouched if anything moved in between.
 */
export function saveTask(dir, task, { expectedVersion = null } = {}) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error("acceptance criteria do not match their hash — criteria are immutable; escalate instead");
	const file = path.join(dir, "task.json");
	if (fs.existsSync(file)) {
		const prev = JSON.parse(fs.readFileSync(file, "utf8"));
		if (prev.acceptance.hash !== task.acceptance.hash) throw new Error("acceptance is immutable — hash differs from the persisted task; escalate instead");
		if (expectedVersion !== null && prev.stateVersion !== expectedVersion) throw new StaleVersion(`task.json is at stateVersion ${prev.stateVersion}, this write was computed against ${expectedVersion} — nothing was written`);
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
//
// Both functions below tolerate a budget with a key missing entirely, as well as one set to
// zero: loadTask normalises what it reads, but a task object can also reach here hand-built or
// from an older in-memory copy, and a missing key means exactly what an unset one means.
export function spendBudget(task, spend) {
	const budget = withEveryBudgetKey(task.budget);
	for (const [k, v] of Object.entries(spend)) {
		if (!BUDGET_KEYS.includes(k)) throw new Error(`unknown budget ${k}`);
		const b = budget[k];
		if (b.total && b.used + v > b.total) throw new BudgetExceeded(`budget ${k}: ${b.used} + ${v} > ${b.total}`);
		budget[k] = { ...b, used: b.used + v };
	}
	return { ...task, budget };
}

export function budgetLeft(task) {
	const budget = withEveryBudgetKey(task.budget);
	return Object.fromEntries(BUDGET_KEYS.map((k) => [k, budget[k].total ? budget[k].total - budget[k].used : null]));
}
