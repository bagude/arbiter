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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadTask, saveTask, setCurrent, spendBudget, budgetLeft, staleBatchMs, StaleVersion } from "./task-state.mjs";
import { appendLedger, findByKey, readLedger, reverseRow } from "./ledger.mjs";
import { ACTION_CLASSES } from "../../tools/decision-points.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const INSTRUCTION_VERBS = ["continue", "correct", "restore", "compare", "accept", "escalate"];

/** Verbs Task 4 builds; validation already accepts them so the contract is testable now. */
export const NOT_YET_IMPLEMENTED = ["accept"];

export class NotYetImplemented extends Error {}

export const MAX_RATIONALE = 500;
export const MAX_CORRECT_MESSAGE = 2000;

/**
 * A checkpoint is one of two things (§3): an accepted workspace checkpoint `ck-NNNN`, or a
 * captured inference `run:<runId>#<call>` — a point in a recorded run the fork runner can
 * restore. Returns { kind: "ck" | "run", ... } or null when it is neither.
 */
export function parseCheckpoint(cp) {
	if (typeof cp !== "string") return null;
	const run = /^run:([^#]+)#(\d+)$/.exec(cp);
	if (run) return { kind: "run", runId: run[1], call: Number(run[2]) };
	if (/^ck-\d+$/.test(cp)) return { kind: "ck", id: cp };
	return null;
}

/**
 * Why this checkpoint cannot be restored from, or null.
 *
 * A `run:` checkpoint's PRECONDITION is the captured request itself: the fork runner restores a
 * run from `runs/<id>/requests/<call>.json` (the recorded payload and its workspace snapshot),
 * so a checkpoint naming a call that was never captured is a batch that would spawn, fail its
 * own preflight and burn the budget the instruction was charged. The check is skipped when no
 * `runsDir` is given, exactly as the duplicate-key check is skipped without a `taskDir`: a
 * caller with no runs on disk (a dry run over a packet) can still validate everything else.
 *
 * `ck-` checkpoints are Task 4's — accepted checkpoints do not exist yet, and a `restore` that
 * silently fell back to something else would start a run from a state nobody named.
 */
export function checkpointRefusal(checkpoint, runsDir) {
	const cp = parseCheckpoint(checkpoint);
	if (!cp) return `checkpoint must be ck-NNNN or run:<runId>#<call> (got ${JSON.stringify(checkpoint)})`;
	if (cp.kind === "ck") return "checkpoint restore not yet available";
	if (!runsDir) return null;
	const file = path.join(runsDir, cp.runId, "requests", `${String(cp.call).padStart(4, "0")}.json`);
	if (!fs.existsSync(file)) return `no captured inference at ${checkpoint} (${file} does not exist)`;
	return null;
}

/**
 * Run ids a batch that is STILL IN FLIGHT has reported, from its outcome rows.
 *
 * `current.activeRuns` names the runs the manager started directly. A batch's run is not one of
 * them: the executor never learns it (the batch is a detached child) and the child only learns
 * it from the supervisor's exit. This makes the ledger the handle instead — an outcome row
 * carrying `{ batchId, runId }` while that `batchId` is still in `current.activeBranches`.
 *
 * In practice this path never validates a `continue`, and that is the honest answer rather than
 * a gap: `runOnce` awaits the supervisor's exit, so the run is already over by the time its id
 * exists, and the child writes the outcome row and its clearance marker in the same pass.
 * `continue` therefore does not apply to a restored run — the manager acts on it by restoring
 * again from a later checkpoint. Reading the ledger here keeps the rule ("a run a pending batch
 * reported is live") true the moment a future runner can publish an id mid-flight.
 */
export function runsFromPendingBatches(taskDir, task, now = Date.now()) {
	const pending = new Set(pendingBatches(task, taskDir, now).map((b) => b.batchId));
	if (!taskDir || !pending.size) return [];
	return readLedger(taskDir)
		.filter((r) => r.kind === "outcome" && pending.has(r.outcome?.batchId) && r.outcome?.runId)
		.map((r) => r.outcome.runId);
}

/** The file a batch child writes when it is done — its ONE statement about the task, and the
 * reason it never writes task.json (see settledBatches). */
export const batchDoneFile = (taskDir, batchId) => path.join(taskDir, "compares", String(batchId), "done.json");

/**
 * The entries in `current.activeBranches` that are over, and why.
 *
 * `task.json` has exactly one writer, the executor. The batch child runs in another process for
 * tens of minutes and cannot join it: a read-modify-write from each would let the second discard
 * the first's change, and — worse — both would bump `stateVersion` from the same base, so two
 * different task states would carry the same version and §3's staleness check would pass on a
 * state the manager never saw. So the child states that it finished by writing a marker file in
 * its own batch directory, and the executor folds that into `activeBranches` in the save it was
 * making anyway.
 *
 * `stale` is the other way an entry ends: a child killed outright writes no marker, and a
 * pending batch nothing ever clears refuses every later restore and compare until a human edits
 * task.json — the one state a manager cannot escape from. Past its ceiling the entry stops
 * counting. It fails safe: if that batch really is still running, the second one hits the fork
 * runner's collision preflight, which is now recorded as a failed batch rather than read out as
 * a comparison.
 */
export function settledBatches(task, taskDir, now = Date.now()) {
	return (task.current?.activeBranches ?? [])
		.map((b) => {
			if (taskDir && fs.existsSync(batchDoneFile(taskDir, b.batchId))) return { ...b, why: "cleared" };
			if (now - (b.launchedAt ?? 0) > batchCeiling(task, b)) return { ...b, why: "stale" };
			return null;
		})
		.filter(Boolean);
}

/**
 * How long this batch may run before it stops being believed: `max(staleBatchMs, 2 ×
 * expectedMs)`, never the task's setting alone.
 *
 * A batch's own length is knowable — `branches × replicates` supervisor runs, sequential, each
 * bounded by the config's wall cap — and `prepareBatch` records it as `expectedMs`. A flat two
 * hours calls a healthy 2×3 compare at a 1800 s cap stale halfway through, and that is where the
 * fail-safe stops being a safety net and starts costing the next batch's whole fork budget to
 * the collision preflight. The factor of two is slack for everything the wall cap does not
 * bound: the workspace copies, decision-point extraction, the reports.
 */
export function batchCeiling(task, b) {
	return Math.max(staleBatchMs(task), 2 * Number(b?.expectedMs ?? 0));
}

/** The batches that still count as in flight: neither finished nor abandoned to staleness. */
export function pendingBatches(task, taskDir, now = Date.now()) {
	const over = new Set(settledBatches(task, taskDir, now).map((b) => b.batchId));
	return (task.current?.activeBranches ?? []).filter((b) => !over.has(b.batchId));
}

/**
 * §3's restore precondition: "no live run on the same milestone unless `parallel: true`".
 *
 * Every live run is on the current milestone — a task has one — so `current.activeRuns` is the
 * list, and a batch still in flight counts as live too: it is one or more supervisor runs going,
 * and the model server has one slot. Two runs contending for it end with the fork runner's
 * collision preflight abandoning one of them, which is the failure this refusal exists to
 * prevent.
 */
export function liveWorkRefusal(args, task, { taskDir = null, now = Date.now() } = {}) {
	if (args.parallel === true) return null;
	const runs = task.current?.activeRuns ?? [];
	if (runs.length) return `a run is still live on milestone ${task.current.milestone} (${runs.join(", ")}) — finish or abandon it, or pass parallel: true`;
	const batches = pendingBatches(task, taskDir, now);
	if (batches.length) return `batch ${batches.map((b) => b.batchId).join(", ")} is still in flight — wait for its comparison_ready, or pass parallel: true`;
	return null;
}

/** Absolute path for a config named relative to the repo root (which is where a batch runs). */
const resolveConfig = (config) => (path.isAbsolute(config) ? config : path.join(ROOT, config));

/** The wall-clock cap one run of this config may take, or 0 when it sets none (uncapped runs
 * cannot bound a batch, so the task's own staleBatchMs is all there is). */
function configWallSec(config) {
	try {
		return Number(JSON.parse(fs.readFileSync(config, "utf8"))?.caps?.wallSec ?? 0) || 0;
	} catch {
		return 0;
	}
}

/**
 * The config a restored or compared run is spawned with, or a refusal.
 *
 * `approach.config` first, then the packet's own `run.config`. The fallback is checked against
 * the filesystem rather than trusted: packet.mjs fills `run.config` from
 * `summary.config?.configPath ?? summary.config ?? summary.task`, and that last one is a task
 * NAME, not a path — passing it to `--config` spawns a supervisor that dies on a file it cannot
 * read, after the instruction has already been recorded and charged.
 */
export function configRefusal(args, packet) {
	const named = args.approach?.config ?? args.config ?? packet?.run?.config ?? null;
	if (!named) return { refusal: "no config to run: name one in args.approach.config (the packet's run carries none)" };
	if (typeof named !== "string") return { refusal: `config must be a path (got ${JSON.stringify(named)})` };
	const config = resolveConfig(named);
	if (!fs.existsSync(config)) return { refusal: `config ${named} does not exist (resolved to ${config})` };
	// A message only reaches the orchestrator through runs/<id>/control.jsonl, which only a run
	// with a manage block ever reads (supervisor.mjs's controlTail and pumpControl are both
	// MANAGE-gated). Without this the file is copied into the new run, nothing tails it, and the
	// manager's correction vanishes into a run that reads as an ordinary null result.
	const needsControl = Boolean(args.approach?.message) || (args.branches ?? []).some((b) => b?.message);
	if (needsControl) {
		let cfg;
		try {
			cfg = JSON.parse(fs.readFileSync(config, "utf8"));
		} catch (err) {
			return { refusal: `config ${named} is not readable JSON: ${err.message}` };
		}
		if (cfg?.manage?.enabled !== true) return { refusal: `a message can only be delivered to a run whose config enables management, and ${named} has no manage.enabled block` };
	}
	return { config };
}

/** The fork branch a manager's branch describes: forcing a first action is A-natural, and
 * forcing nothing is G, the branch every comparison is measured against. */
export const forkBranchOf = (b) => (b?.firstAction ? "A-natural" : "G");

/** Is this branch spec something the fork runner can actually run? A first action outside
 * decision-points' nine classes is refused HERE rather than by planForks inside the batch
 * child, where the instruction has already been recorded and the budget already spent. */
function branchRefusal(b, i) {
	if (!b || typeof b !== "object" || Array.isArray(b)) return `branches[${i}] must be an object`;
	// The label names files (compares/<n>/report-<label>.md, control-<label>.jsonl), so it is
	// restricted to a filename-safe alphabet here rather than sanitised at every use — a branch
	// called "../G" is a manager writing outside its own task directory.
	if (typeof b.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b.label)) return `branches[${i}] needs a label of letters, digits, dot, dash or underscore (got ${JSON.stringify(b?.label)})`;
	if (b.firstAction != null) {
		if (!ACTION_CLASSES.includes(b.firstAction)) return `branches[${i}] (${b.label}): unknown action class ${JSON.stringify(b.firstAction)} — must be one of ${ACTION_CLASSES.join(", ")}`;
		if (b.firstAction === "answer") return `branches[${i}] (${b.label}): "answer" cannot be forced — it is the absence of a tool call, so every call of the run would be denied`;
	}
	if (b.message != null && (typeof b.message !== "string" || b.message.length > MAX_CORRECT_MESSAGE)) return `branches[${i}] (${b.label}): message must be a string of at most ${MAX_CORRECT_MESSAGE} chars`;
	return null;
}

// The args each verb requires, from §3's table. `check` returns a refusal string or null; it
// runs only after shape, version, key, verb and budget have all passed, so it may assume the
// keys named in `required` are present.
export const ARGS = {
	continue: {
		required: ["runId", "milestone"],
		check: (args, { task, taskDir }) => {
			// A run is live if the manager started it, or if a batch that is still in flight has
			// reported it. See runsFromPendingBatches: a restored run is dead before its id is
			// known, so `continue` on one is refused here as not live.
			const live = [...task.current.activeRuns, ...runsFromPendingBatches(taskDir, task)];
			if (!live.includes(args.runId)) return `run ${args.runId} is not live (current.activeRuns: ${task.current.activeRuns.join(", ") || "none"})`;
			if (args.milestone !== task.current.milestone) return `milestone ${args.milestone} is not current (${task.current.milestone})`;
			const g = args.budgetGrant ?? {};
			// Array.isArray as well as typeof: `[]` is an object, and [300] would then pass
			// shape and spend nothing, a grant silently worth zero.
			if (typeof g !== "object" || Array.isArray(g)) return "budgetGrant must be an object";
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
		check: (args, { task, packet, taskDir, runsDir }) => {
			const a = args.approach ?? {};
			if (typeof a !== "object" || Array.isArray(a)) return "approach must be an object";
			const bad = branchRefusal({ label: "restore", firstAction: a.firstAction, message: a.message }, 0);
			if (bad) return bad.replace("branches[0] (restore): ", "approach: ");
			const busy = liveWorkRefusal(args, task, { taskDir });
			if (busy) return busy;
			const why = checkpointRefusal(args.checkpoint, runsDir);
			if (why) return why;
			return configRefusal(args, packet).refusal ?? null;
		},
	},
	compare: {
		required: ["checkpoint", "branches", "replicates"],
		check: (args, { task, packet, taskDir, runsDir }) => {
			if (!Array.isArray(args.branches) || args.branches.length < 2) return "compare needs at least 2 branches";
			// Integer, not just ≥ 2: the budget is charged branches × replicates while planForks
			// runs Math.floor of it, so 2.5 would buy three replicates' budget and run two.
			if (!Number.isInteger(args.replicates) || args.replicates < 2) return `compare needs replicates >= 2, as a whole number (got ${JSON.stringify(args.replicates)})`;
			for (const [i, b] of args.branches.entries()) {
				const bad = branchRefusal(b, i);
				if (bad) return bad;
			}
			const labels = args.branches.map((b) => b.label);
			// Two branches under one label would write one report over the other and make every
			// row in the comparison unattributable — the numbers a finding then claims are
			// whichever branch happened to run last.
			if (new Set(labels).size !== labels.length) return `branch labels must be unique (got ${labels.join(", ")})`;
			// §3 names this precondition only for `restore`, but it is the verb that spends LESS.
			// Two batches in flight contend for the single model-server slot, and the fork runner
			// resolves that by abandoning one of them — after its whole branches × replicates
			// budget is charged. Same rule, same bypass.
			const busy = liveWorkRefusal(args, task, { taskDir });
			if (busy) return busy;
			const why = checkpointRefusal(args.checkpoint, runsDir);
			if (why) return why;
			return configRefusal(args, packet).refusal ?? null;
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
		// Both halves of the grant, or neither: raising a run's tool-call cap by an amount
		// nothing bounds is the same unchecked authority as raising its wall clock.
		const g = instr.args?.budgetGrant ?? {};
		for (const k of ["wallSec", "toolCalls"]) {
			const want = g[k] ?? 0;
			if (left[k] !== null && want > left[k]) return `budgetGrant.${k} ${want} exceeds the ${left[k]} left on the task`;
		}
		return null;
	}
	if (instr.verb === "restore") {
		// A restore is one run AND one fork replicate: it is started through the fork runner, so
		// it spends both, and a task out of replicates cannot start one however many runs it has
		// left. Charged the same way in executeInstruction, in one write.
		if (left.runs === 0) return "no run budget left";
		if (left.forkReplicates === 0) return "no fork replicate budget left";
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
 * ledger on disk, e.g. a dry run over a packet). `runsDir` is optional in the same way, and for
 * the same reason: without it a checkpoint's captured inference cannot be looked for, so only
 * its shape is checked. `executeInstruction` always passes both.
 */
export function validateInstruction(instr, { task, packet, taskDir, runsDir } = {}) {
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
	//
	// Executed rows only (findByKey's default): a refusal is a ledger row too, and matching
	// those as well made a refused key unusable. The manager's key names one answer to one
	// packet (§3's own example is `p17-v41`), so the natural retry after a refusal reuses it —
	// and would have been refused as a duplicate of its own rejection.
	if (taskDir) {
		const prior = findByKey(taskDir, instr.idempotencyKey);
		if (prior) return refuse("duplicate_key", `idempotencyKey ${instr.idempotencyKey} already executed (seq ${prior.seq}); acknowledged, not executed again`);
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
	//
	// `escalate` is exempt, and must be: it is the escape hatch this very refusal recommends,
	// and a manager explaining WHICH acceptance criterion looks wrong has to be able to use the
	// word. Nothing an escalate carries is written anywhere near acceptance — it records a
	// blocker and pauses the task for a human, who edits the file by hand.
	if (instr.verb !== "escalate" && /acceptance/i.test(JSON.stringify(args))) return refuse("precondition", "acceptance criteria are immutable — no instruction can change them; escalate with wants=\"criteria_change\" instead");
	const spec = ARGS[instr.verb];
	for (const k of spec.required) if (args[k] == null) return refuse("precondition", `${instr.verb} requires args.${k}`);
	const why = spec.check(args, { task, packet, taskDir, runsDir });
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

/** Next `compares/<n>` id: the max numeric directory already there, plus one. By max rather
 * than by count, for the reason packet.mjs's nextPacketId gives — counting reuses an id the
 * moment there is a gap, and a reused id would write one comparison's reports over another's. */
export function nextCompareId(taskDir) {
	const dir = path.join(taskDir, "compares");
	if (!fs.existsSync(dir)) return 1;
	const ids = fs.readdirSync(dir).map((f) => /^(\d+)$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
	return (ids.length ? Math.max(...ids) : 0) + 1;
}

/** The tool the source run actually called at this point, for the shape a finding settles
 * under (`read→done`). Best effort: a run whose decision points were never extracted still
 * compares fine, its findings just say `?→done`. */
function recordedToolAt(runsDir, cp) {
	try {
			const file = path.join(runsDir, cp.runId, "decisions.jsonl");
			const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
			return rows.find((r) => r.i === cp.call - 1)?.action?.tool ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Everything a batch needs, on disk, before the ledger row that names it.
	 *
	 * The id is allocated and its directory created FIRST, because the row records `executed:
	 * { batchId }` and an id that is not reserved by the time the row is written can be handed out
	 * twice. An orphaned `compares/<n>/` left by a crash between here and the row costs a directory;
	 * a reused id costs a comparison.
	 *
	 * That this writes files before the ledger row is deliberate and is not the thing the
	 * row-before-the-act rule guards against: everything written here is inert — a directory, a spec
	 * and a control file inside the task's own tree, read by nothing until a batch child is handed
	 * the spec path. The ledger row is what makes them count, and it is still down before the only
	 * act with a consequence outside this directory (the launch).
	 *
	 * A `restore` is a one-branch batch of one replicate — the same machinery, not a second path:
	 * `approach.firstAction` makes it A-natural, its absence makes it G, and `approach.message` is
	 * written as the control file the supervisor copies into the restored run.
	 */
	function prepareBatch({ taskDir, task, instr, packet, runsDir }) {
		const args = instr.args ?? {};
		const verb = instr.verb;
		const cp = parseCheckpoint(args.checkpoint); // validated already: a `run:` checkpoint
		const { config } = configRefusal(args, packet);
		const raw = verb === "restore" ? [{ label: forkBranchOf(args.approach ?? {}), firstAction: args.approach?.firstAction ?? null, message: args.approach?.message ?? null }] : args.branches;
		const replicates = verb === "restore" ? 1 : Number(args.replicates);
		const compareId = nextCompareId(taskDir);
		const dir = path.join(taskDir, "compares", String(compareId));
		fs.mkdirSync(dir, { recursive: true });

		const branches = raw.map((b) => {
			const out = { label: b.label, forkBranch: forkBranchOf(b), firstAction: b.firstAction ?? null, message: b.message ?? null, controlFile: null };
			if (out.message) {
				// One control file per BRANCH, not per batch: the message is a property of the branch,
				// and a shared file would deliver every branch's correction to every replicate.
				out.controlFile = path.join(dir, `control-${b.label}.jsonl`);
				fs.writeFileSync(out.controlFile, JSON.stringify({ ts: Date.now(), type: "correct", packetId: instr.packetId ?? packet?.packetId ?? null, message: out.message }) + "\n");
			}
			return out;
		});
		const spec = {
			kind: verb, compareId, taskDir: path.resolve(taskDir), runsDir: path.resolve(runsDir),
			packetId: instr.packetId ?? packet?.packetId ?? null, idempotencyKey: instr.idempotencyKey,
			checkpoint: args.checkpoint, runId: cp.runId, call: cp.call, recordedTool: recordedToolAt(runsDir, cp),
			config, replicates, branches, scope: `task:${task.taskId}`,
		};
		const specFile = path.join(dir, "spec.json");
		fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
		const spend = verb === "restore" ? { runs: 1, forkReplicates: 1 } : { forkReplicates: branches.length * replicates };
		// What `current.activeBranches` is for (§1): work in flight that is not a run the manager
		// holds. Written by the executor and cleared through the child's marker, it is the only
		// thing in task.json that says a comparison is running — without it the next packet shows
		// an idle task while tens of minutes of supervisor runs are in progress.
		//
		// `expectedMs` is how long this batch may legitimately take: its replicates run
		// sequentially, one model-server slot, each bounded by the config's own wall cap. It is
		// recorded here because this is the only place that knows the batch's shape, and
		// batchCeiling reads it so a long batch is not called stale in the middle of its work.
		const pending = { batchId: compareId, kind: verb, checkpoint: args.checkpoint, launchedAt: Date.now(), expectedMs: branches.length * replicates * configWallSec(config) * 1000 };
		return { compareId, dir, specFile, spend, pending };
	}

	/**
	 * Starts the batch and returns immediately. The executor must not block on it: a batch is
	 * branches × replicates full supervisor runs — tens of minutes — and the instruction it answers
	 * is one packet in a loop that has other triggers to serve. The child re-enters this same CLI
	 * (`tools/manage.mjs run-batch`), so everything it does is a command an operator can run by hand
	 * on the same spec file. Its output goes to the batch's own log; without that, a child that dies
	 * at startup leaves no trace anywhere.
	 */
	function defaultLaunchBatch({ specFile, dir, taskDir }) {
		const out = fs.openSync(path.join(dir, "batch.log"), "a");
		const child = spawn(process.execPath, [path.join(ROOT, "tools", "manage.mjs"), "run-batch", path.resolve(taskDir), specFile], {
			cwd: ROOT, detached: true, stdio: ["ignore", out, out],
		});
		child.unref();
		return { pid: child.pid };
	}

	/**
	 * Validate, record, act — in that order.
	 *
	 * `save` is `saveTask`, injectable: the window this executor can lose (its own load to its
 * own compare-and-swap) is microseconds wide, so the losing path is otherwise unreachable from
 * one process and would go untested.
 *
 * Returns `{ executed, ledgerRow, refusal? }`. A refusal is a ledger row too (`verified: false`,
	 * `refused: <code>`), because a manager that was told "no" and the reason why is part of the
	 * record §5 keeps. A DUPLICATE is the one exception: it is an acknowledgement, not a refusal
	 * (§3), so nothing is appended and the original row comes back with `executed: false`.
	 */
	export function executeInstruction({ taskDir, instr, packet, runsDir, launchBatch = defaultLaunchBatch, save = saveTask }) {
		const task = loadTask(taskDir);
		const v = validateInstruction(instr, { task, packet, taskDir, runsDir });

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

		if (NOT_YET_IMPLEMENTED.includes(instr.verb)) throw new NotYetImplemented(`${instr.verb} arrives with the checkpoint work (Task 4)`);

		const runId = runIdFor(instr, packet);
		const runDir = runsDir && runId ? path.join(runsDir, runId) : null;
		const batching = instr.verb === "restore" || instr.verb === "compare";
		const batch = batching ? prepareBatch({ taskDir, task, instr, packet, runsDir }) : null;
		// The row goes down before the act. Everything below is idempotent-by-key from here on:
		// a crash after this line leaves a row whose outcome a later reader can check against the
		// control file, which is strictly better than an act with no record of who asked for it.
		//
		// A batching verb records `executed: { batchId }`, never `{ runId }`: the run in scope here
		// is the SOURCE run the checkpoint came from, and naming it would read as "this instruction
		// acted on that run". The runs a batch produces are its own, and the child appends them as
		// outcome rows once they exist.
		const row = appendLedger(taskDir, { ...base, verified: true, refused: null, executed: batch ? { batchId: batch.compareId } : { runId } });
		const extra = {};

		// Every save below is a compare-and-swap against the version this call loaded, so another
		// executor answering another packet at the same time makes exactly one of them the loser.
		// The loser's row is already on disk (the row goes down before the act), and it says
		// `verified: true` for an instruction that did not run — and `findByKey` would then refuse
		// its honest retry as a duplicate of something that never happened. So the row is retracted
		// by a compensating row and the caller is told what it would have been told had the check
		// come first: the task moved, here is a stale_version refusal, issue a fresh packet.
		try {
		if (instr.verb === "continue") {
			const grant = instr.args.budgetGrant ?? {};
			// Spent in ONE saveTask: two writes would bump the state version twice for one
			// instruction, and a throw between them would leave half a grant charged against a task
			// whose run is about to have both halves of it.
			const spend = {};
			if (grant.wallSec) spend.wallSec = grant.wallSec;
			if (grant.toolCalls) spend.toolCalls = grant.toolCalls;
			if (Object.keys(spend).length) save(taskDir, spendBudget(task, spend), { expectedVersion: task.stateVersion });
			if (runDir) controlAppend(runDir, { type: "grant", packetId: row.packetId, wallSec: grant.wallSec ?? 0, toolCalls: grant.toolCalls ?? 0 });
		} else if (instr.verb === "correct") {
			if (runDir) controlAppend(runDir, { type: "correct", packetId: row.packetId, message: instr.args.message });
		} else if (batching) {
			// Charged before the batch starts, in one write (the same rule the grant above follows):
			// a restore spends a run AND a replicate, and a second instruction must be measured
			// against what this one already committed, not against what its runs have finished. The
			// pending batch joins the same write — a spend the task records without the work it paid
			// for would be a comparison nothing knows is running.
			//
			// The same write is where finished and stale batches leave `activeBranches`. The executor
			// is task.json's only writer (see settledBatches), so the child's marker file is only ever
			// folded in by a later instruction — which is exactly when it matters, because the list is
			// read to decide whether new work may start. Each drop is a ledger row: a batch that ended
			// without saying so is a fact about the task, not bookkeeping.
			const settled = settledBatches(task, taskDir);
			const keep = (task.current.activeBranches ?? []).filter((b) => !settled.some((s) => s.batchId === b.batchId));
			save(taskDir, setCurrent(spendBudget(task, batch.spend), { activeBranches: [...keep, batch.pending] }), { expectedVersion: task.stateVersion });
			// AFTER the save, unlike the instruction's own row: these rows describe drops the save
			// makes, not an act the ledger has to survive a crash to explain. Written first, a lost
			// compare-and-swap would leave the ledger claiming drops that never happened, and the
			// next attempt would write them all over again.
			for (const b of settled) appendLedger(taskDir, { kind: b.why === "stale" ? "batch_stale" : "batch_cleared", batchId: b.batchId, launchedAt: b.launchedAt ?? null });
			extra.batchId = batch.compareId;
			extra.specFile = batch.specFile;
			extra.launched = launchBatch({ specFile: batch.specFile, dir: batch.dir, taskDir, runsDir });
		} else if (instr.verb === "escalate") {
			const blockers = [...(task.blockers ?? []), { id: `b${(task.blockers?.length ?? 0) + 1}`, text: instr.args.reason, wants: instr.args.wants, raisedBy: "manager", raisedIn: runId, status: "open" }];
			save(taskDir, { ...task, status: "paused", blockers }, { expectedVersion: task.stateVersion });
		}
	} catch (err) {
		if (!(err instanceof StaleVersion)) throw err;
		// Nothing outside the task directory moved: every save above precedes its own control
		// entry, its launch and the trailing `decision`, so the retraction is the whole cleanup.
		reverseRow(taskDir, row.seq, "stale_version");
		return { executed: false, ledgerRow: row, reversed: true, code: "stale_version", refusal: `${err.message} — nothing was executed; a fresh packet is issued instead` };
	}

	// Last, always, for every verb: a paused supervisor is waiting on exactly this, and any
	// grant/correct written above must already be on disk when it reads the batch that
	// releases it (the supervisor attaches a correct from the same batch to the delivery).
	if (runDir) controlAppend(runDir, { type: "decision", packetId: row.packetId, verb: instr.verb });

	return { executed: true, ledgerRow: row, ...extra };
}
