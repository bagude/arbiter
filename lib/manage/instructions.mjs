// instructions — the manager's one instruction per packet (spec §3): what it may say, what
// the harness checks before anything moves, and what executing it actually does.
//
// Three rules shape this file:
//   - The ledger row is written BEFORE the act, never after. A crash between the two leaves a
//     row saying what was attempted; the reverse leaves an act nobody recorded.
//   - `idempotencyKey` is looked up in that same ledger first, so a retried delivery is
//     acknowledged and NOT executed again (spec §3: "a restore or compare can never launch twice").
//   - The executor never imports the supervisor. It talks to a live run through one file,
//     `runs/<id>/control.jsonl`, which the supervisor tails. That keeps `tools/manage.mjs`
//     runnable with no run in flight and keeps the supervisor free of packet code.
import fs from "node:fs";
import path from "node:path";
import { loadTask, saveTask, spendBudget, budgetLeft } from "./task-state.mjs";
import { appendLedger, findByKey } from "./ledger.mjs";

export const INSTRUCTION_VERBS = ["continue", "correct", "restore", "compare", "accept", "escalate"];

/** Verbs Tasks 3–4 build; validation already accepts them so the contract is testable now. */
export const NOT_YET_IMPLEMENTED = ["restore", "compare", "accept"];

export class NotYetImplemented extends Error {}

export const MAX_RATIONALE = 500;
export const MAX_CORRECT_MESSAGE = 2000;

// The args each verb requires, from §3's table. `check` returns a refusal string or null; it
// runs only after shape, version, key, verb and budget have all passed, so it may assume the
// keys named in `required` are present.
export const ARGS = {
	continue: {
		required: ["runId", "milestone"],
		check: (args, { task }) => {
			if (!task.current.activeRuns.includes(args.runId)) return `run ${args.runId} is not live (current.activeRuns: ${task.current.activeRuns.join(", ") || "none"})`;
			if (args.milestone !== task.current.milestone) return `milestone ${args.milestone} is not current (${task.current.milestone})`;
			const g = args.budgetGrant ?? {};
			if (g && typeof g !== "object") return "budgetGrant must be an object";
			for (const k of ["wallSec", "toolCalls"]) if (g[k] != null && (typeof g[k] !== "number" || g[k] < 0)) return `budgetGrant.${k} must be a non-negative number`;
			return null;
		},
	},
	correct: {
		required: ["runId", "message"],
		check: (args, { task }) => {
			if (!task.current.activeRuns.includes(args.runId)) return `run ${args.runId} is not live (current.activeRuns: ${task.current.activeRuns.join(", ") || "none"})`;
			if (typeof args.message !== "string" || !args.message.trim()) return "message must be a non-empty string";
			if (args.message.length > MAX_CORRECT_MESSAGE) return `message is ${args.message.length} chars; the limit is ${MAX_CORRECT_MESSAGE}`;
			return null;
		},
	},
	restore: {
		required: ["checkpoint"],
		check: (args) => (typeof args.checkpoint === "string" && args.checkpoint ? null : "checkpoint must be a checkpoint id"),
	},
	compare: {
		required: ["checkpoint", "branches", "replicates"],
		check: (args) => {
			if (!Array.isArray(args.branches) || args.branches.length < 2) return "compare needs at least 2 branches";
			if (!(Number(args.replicates) >= 2)) return "compare needs replicates >= 2";
			return null;
		},
	},
	accept: {
		required: ["milestone", "checkpoint", "evidence"],
		check: (args) => (Array.isArray(args.evidence) && args.evidence.length ? null : "accept needs evidence for every criterion the milestone names"),
	},
	escalate: {
		required: ["reason", "wants"],
		check: (args) => {
			if (typeof args.reason !== "string" || !args.reason.trim()) return "reason must be a non-empty string";
			if (!["criteria_change", "human_review", "budget"].includes(args.wants)) return `wants must be criteria_change, human_review or budget (got ${JSON.stringify(args.wants)})`;
			return null;
		},
	},
};

const refuse = (code, refusal) => ({ ok: false, code, refusal });

/** Does this instruction's budget ask fit what the task has left? `null` left = unbounded. */
function budgetRefusal(instr, task) {
	const left = budgetLeft(task);
	if (instr.verb === "continue") {
		const want = instr.args?.budgetGrant?.wallSec ?? 0;
		if (left.wallSec !== null && want > left.wallSec) return `budgetGrant.wallSec ${want} exceeds the ${left.wallSec}s left on the task`;
		return null;
	}
	if (instr.verb === "restore") {
		if (left.runs === 0) return "no run budget left";
		return null;
	}
	if (instr.verb === "compare") {
		const want = (Array.isArray(instr.args?.branches) ? instr.args.branches.length : 0) * Number(instr.args?.replicates ?? 0);
		if (left.forkReplicates === 0) return "no fork replicate budget left";
		if (left.forkReplicates !== null && want > left.forkReplicates) return `compare needs ${want} replicates; ${left.forkReplicates} left`;
		return null;
	}
	return null;
}

/**
 * The gate every instruction passes before anything moves. Order is the contract, not an
 * implementation detail: shape → key → version → verb allowed → budget → per-verb
 * preconditions. A stale instruction must be refused as stale even when its args are also
 * wrong, because the manager is being told "you did not see the current state", and a
 * duplicate must be recognised before anything else is judged at all (see the key check).
 *
 * `taskDir` is optional: without it the duplicate-key check is skipped (a caller that has no
 * ledger on disk, e.g. a dry run over a packet).
 */
export function validateInstruction(instr, { task, packet, taskDir } = {}) {
	if (!instr || typeof instr !== "object") return refuse("precondition", "an instruction must be an object");
	if (typeof instr.verb !== "string" || !INSTRUCTION_VERBS.includes(instr.verb)) return refuse("verb_not_allowed", `no such verb ${JSON.stringify(instr.verb)}; the contract has ${INSTRUCTION_VERBS.join(", ")}`);
	if (typeof instr.idempotencyKey !== "string" || !instr.idempotencyKey) return refuse("precondition", "idempotencyKey is required");
	if (typeof instr.basedOnStateVersion !== "number") return refuse("precondition", "basedOnStateVersion is required");
	if (instr.args != null && (typeof instr.args !== "object" || Array.isArray(instr.args))) return refuse("precondition", "args must be an object");
	if (packet && instr.packetId !== packet.packetId) return refuse("precondition", `instruction answers packet ${instr.packetId}, not ${packet.packetId} — one instruction per packet`);
	if (instr.rationale != null && (typeof instr.rationale !== "string" || instr.rationale.length > MAX_RATIONALE)) return refuse("precondition", `rationale must be a string of at most ${MAX_RATIONALE} chars`);

	// Key BEFORE version, deliberately against the brief's stated order. Executing an
	// instruction moves the task (a grant is spent, a blocker is added), so a RETRIED delivery
	// of an instruction that already ran is ALWAYS stale by definition. With version first,
	// every retry becomes a stale refusal and a fresh packet — the opposite of §3's "a retried
	// delivery with the same key is acknowledged and not executed again", and a packet loop a
	// flaky transport could ride forever. Idempotency is a property of the delivery, so it is
	// answered before anything about the state the delivery describes.
	if (taskDir) {
		const prior = findByKey(taskDir, instr.idempotencyKey);
		if (prior) return refuse("duplicate_key", `idempotencyKey ${instr.idempotencyKey} was already recorded (seq ${prior.seq}); acknowledged, not executed again`);
	}

	if (instr.basedOnStateVersion !== task.stateVersion) return refuse("stale_version", `instruction is based on state version ${instr.basedOnStateVersion}; the task is at ${task.stateVersion} — a fresh packet is issued instead`);

	const allowed = packet?.options?.verbsAllowed ?? INSTRUCTION_VERBS;
	if (!allowed.includes(instr.verb)) return refuse("verb_not_allowed", `${instr.verb} is not in this packet's verbsAllowed (${allowed.join(", ")})`);

	const bad = budgetRefusal(instr, task);
	if (bad) return refuse("budget", bad);

	const args = instr.args ?? {};
	// Acceptance criteria are written by a human and hashed at creation; §1 and §3 both say no
	// instruction can touch them. Checked over the rendered args rather than a key list so a
	// nested or renamed field cannot slip an acceptance edit in as data.
	if (/acceptance/i.test(JSON.stringify(args))) return refuse("precondition", "acceptance criteria are immutable — no instruction can change them; escalate with wants=\"criteria_change\" instead");
	const spec = ARGS[instr.verb];
	for (const k of spec.required) if (args[k] == null) return refuse("precondition", `${instr.verb} requires args.${k}`);
	const why = spec.check(args, { task, packet });
	if (why) return refuse("precondition", why);
	return { ok: true };
}

/** Appends one entry to `runs/<id>/control.jsonl` — the one channel from executor to supervisor. */
export function controlAppend(runDir, entry) {
	fs.mkdirSync(runDir, { recursive: true });
	const out = { ts: Date.now(), ...entry };
	fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify(out) + "\n");
	return out;
}

/** The run this instruction acts on: its own args first, then the packet's trigger/run. */
function runIdFor(instr, packet) {
	return instr.args?.runId ?? packet?.trigger?.runId ?? packet?.run?.id ?? null;
}

/**
 * Validate, record, act — in that order.
 *
 * Returns `{ executed, ledgerRow, refusal? }`. A refusal is a ledger row too (`verified: false`,
 * `refused: <code>`), because a manager that was told "no" and the reason why is part of the
 * record §5 keeps. A DUPLICATE is the one exception: it is an acknowledgement, not a refusal
 * (§3), so nothing is appended and the original row comes back with `executed: false`.
 */
export function executeInstruction({ taskDir, instr, packet, runsDir }) {
	const task = loadTask(taskDir);
	const v = validateInstruction(instr, { task, packet, taskDir });

	if (!v.ok && v.code === "duplicate_key") {
		return { executed: false, duplicate: true, ledgerRow: findByKey(taskDir, instr.idempotencyKey), refusal: v.refusal };
	}

	const base = {
		packetId: instr?.packetId ?? packet?.packetId ?? null,
		stateVersion: task.stateVersion,
		trigger: packet?.trigger?.kind ?? null,
		instruction: instr,
	};

	if (!v.ok) {
		const row = appendLedger(taskDir, { ...base, verified: false, refused: v.code, reason: v.refusal, executed: null });
		return { executed: false, ledgerRow: row, refusal: v.refusal, code: v.code };
	}

	if (NOT_YET_IMPLEMENTED.includes(instr.verb)) throw new NotYetImplemented(`${instr.verb} arrives with the checkpoint and fork work (Tasks 3–4)`);

	const runId = runIdFor(instr, packet);
	const runDir = runsDir && runId ? path.join(runsDir, runId) : null;
	// The row goes down before the act. Everything below is idempotent-by-key from here on:
	// a crash after this line leaves a row whose outcome a later reader can check against the
	// control file, which is strictly better than an act with no record of who asked for it.
	const row = appendLedger(taskDir, { ...base, verified: true, refused: null, executed: { runId } });

	if (instr.verb === "continue") {
		const grant = instr.args.budgetGrant ?? {};
		if (grant.wallSec) saveTask(taskDir, spendBudget(task, { wallSec: grant.wallSec }));
		if (runDir) controlAppend(runDir, { type: "grant", packetId: row.packetId, wallSec: grant.wallSec ?? 0, toolCalls: grant.toolCalls ?? 0 });
	} else if (instr.verb === "correct") {
		if (runDir) controlAppend(runDir, { type: "correct", packetId: row.packetId, message: instr.args.message });
	} else if (instr.verb === "escalate") {
		const blockers = [...(task.blockers ?? []), { id: `b${(task.blockers?.length ?? 0) + 1}`, text: instr.args.reason, wants: instr.args.wants, raisedBy: "manager", raisedIn: runId, status: "open" }];
		saveTask(taskDir, { ...task, status: "paused", blockers });
	}

	// Last, always, for every verb: a paused supervisor is waiting on exactly this, and any
	// grant/correct written above must already be on disk when it reads the batch that
	// releases it (the supervisor attaches a correct from the same batch to the delivery).
	if (runDir) controlAppend(runDir, { type: "decision", packetId: row.packetId, verb: instr.verb });

	return { executed: true, ledgerRow: row };
}
