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
import { loadTask, saveTask, setCurrent, spendBudget, budgetLeft, staleBatchMs, staleRunMs, StaleVersion } from "./task-state.mjs";
import { appendLedger, findByKey, readLedger, reverseRow, reversedSeqs } from "./ledger.mjs";
import { checkpointDir, isCandidateId, isCheckpointId, readManifest } from "./checkpoint.mjs";
import { checkEvidence } from "./evidence.mjs";
import { ACTION_CLASSES } from "../../tools/decision-points.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const INSTRUCTION_VERBS = ["continue", "correct", "restore", "compare", "accept", "escalate"];

/** Verbs the contract names but the harness cannot yet carry out. Empty since Task 4 built
 * `accept`; kept, with the error class below, because this list is how a verb joins the contract
 * before its machinery exists — validation answers it, execution refuses loudly. */
export const NOT_YET_IMPLEMENTED = [];

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
 * A `ck-` checkpoint's precondition is the checkpoint directory, and it is allowed for `restore`
 * alone (`allowCk`). A `compare` runs branches through the fork runner, which resumes a recorded
 * inference — there is no inference to resume in an accepted workspace, so a comparison over one
 * would be two identical fresh runs charged as an experiment.
 */
export function checkpointRefusal(checkpoint, runsDir, { taskDir = null, allowCk = false } = {}) {
	const cp = parseCheckpoint(checkpoint);
	if (!cp) return `checkpoint must be ck-NNNN or run:<runId>#<call> (got ${JSON.stringify(checkpoint)})`;
	if (cp.kind === "ck") {
		if (!allowCk) return `${checkpoint} is an accepted checkpoint; a comparison runs from a captured inference (run:<runId>#<call>)`;
		// Skipped without a taskDir, like the captured-inference check below without a runsDir: a
		// dry validation over a packet has no task directory to look in.
		if (taskDir && !fs.existsSync(checkpointDir(taskDir, cp.id))) return `no checkpoint ${cp.id} in ${path.join(taskDir, "checkpoints")}`;
		return null;
	}
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

/** The triggers a LIVE run emits (§4): the run is going, and `continue` and `correct` are what
 * the manager answers them with — both of which require the run to be in `current.activeRuns`. */
export const LIVE_TRIGGERS = ["oracle_failed_repeatedly", "budget_threshold", "escalation"];

/** The triggers that mean this run is over, whatever the verdict. */
export const ENDED_TRIGGERS = ["run_ended_without_acceptance", "milestone_candidate", "comparison_ready"];

/**
 * Puts the run a trigger is about into `current.activeRuns`, or takes it out. Returns the saved
 * task, or null when nothing changed.
 *
 * Nothing else ever did, and that was a hole: the supervisor starts the runs but cannot write
 * task.json (it is not the executor, and one writer is the rule), while the executor only knew
 * about runs it had started itself — which is none of them. `activeRuns` stayed empty for every
 * real run, so §3's "run is still live" precondition refused every `continue` and `correct` a
 * manager could send. Found on the live check of 2026-09-18: the trigger fired, the packet
 * assembled, the 120 s default fired on time, and the instruction answering it could not
 * validate.
 *
 * The packet assembler's caller is where this belongs. A packet is assembled once per trigger,
 * on the executor's side, and a trigger is the harness saying what just happened to which run.
 * The save comes BEFORE the packet is assembled, so the `basedOnStateVersion` the manager
 * answers with is the version this registration produced.
 *
 * Idempotent both ways: a second packet for a run already registered changes nothing, and so
 * does an ended trigger for a run that was never registered (a fork run reaching
 * `comparison_ready` has never been in this list). It is deliberately NOT called from the batch
 * child, which assembles that `comparison_ready` packet but must never write task.json.
 */
/**
 * What a finished run actually consumed, from its own summary, or null when there is no summary
 * to read.
 *
 * `null` and `{ wallSec: 0, toolCalls: 0 }` are different facts and the caller treats them
 * differently: a run that ended without writing a summary (killed, crashed at startup) has an
 * unknown cost, and charging it zero would read as "this run was free".
 *
 * `summary.toolCalls` is per agent — `{ orchestrator: 41, "worker:a": 12 }` — so the task's
 * figure is their sum: the budget is the task's, and every agent in the run spent it.
 */
export function runConsumption(runsDir, runId) {
	if (!runsDir || !runId) return null;
	const file = path.join(runsDir, runId, "summary.json");
	if (!fs.existsSync(file)) return null;
	try {
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		const tc = s.toolCalls;
		return {
			wallSec: Math.max(0, Math.round(Number(s.wallSec ?? 0)) || 0),
			toolCalls: typeof tc === "number" ? Math.max(0, Math.round(tc)) : tc && typeof tc === "object" ? Object.values(tc).reduce((n, v) => n + (Math.max(0, Number(v)) || 0), 0) : 0,
		};
	} catch {
		return null;
	}
}

/**
 * Consumption clamped to what the task has left.
 *
 * `spendBudget` throws when a spend would cross a ceiling, which is right for a REQUEST — a
 * grant, a batch — and wrong for a measurement. A run that overran its task's wall budget is a
 * fact that has already happened; refusing to record it would leave `used` understating the
 * truth, and throwing here would take an ended trigger's packet down with it. So the charge is
 * clamped to the ceiling and the overrun is named in the ledger row instead.
 */
export function chargeableConsumption(task, spend) {
	const left = budgetLeft(task);
	const charge = {};
	const over = [];
	for (const [k, v] of Object.entries(spend ?? {})) {
		if (!v) continue;
		const room = left[k];
		const amount = room === null ? v : Math.min(v, Math.max(0, room));
		if (amount) charge[k] = amount;
		if (room !== null && v > room) over.push(`${k}: ${v} consumed, ${Math.max(0, room)} was left`);
	}
	return { charge, over };
}

export function registerRunForTrigger(taskDir, trigger, { save = saveTask, runsDir = null } = {}) {
	const runId = trigger?.runId;
	if (!runId || !taskDir) return null;
	const live = LIVE_TRIGGERS.includes(trigger.kind);
	const ended = ENDED_TRIGGERS.includes(trigger.kind);
	if (!live && !ended) return null;
	const task = loadTask(taskDir);
	const runs = task.current?.activeRuns ?? [];
	// Does the activeRuns list have to change? Not the same question as "is there anything to do":
	// an ended trigger for a run that was never registered folds nothing and must still be charged
	// (see below), which is most runs — a run that never paused mid-flight fires no live trigger.
	const folds = live !== runs.includes(runId);
	if (live && !folds) return null; // already registered
	// Registering is the direction that takes the trigger at its word, so it checks first: an id
	// with no run directory is a typo or a stale script, and registering it would have the task
	// refuse every restore and compare on behalf of a run that never existed. Only the ADD is
	// gated — a run whose records were cleaned up must still be removable.
	if (live && runsDir && !fs.existsSync(path.join(runsDir, runId))) {
		appendLedger(taskDir, { kind: "run_missing", runId, trigger: trigger.kind, reason: `no such run directory: ${path.join(runsDir, runId)}` });
		return null;
	}
	// §1 shows `wallSec: { total: 14400, used: 3812 }` — `used` is CONSUMPTION. It was not: only a
	// manager's explicit grant ever charged those two keys, so six half-hour runs left
	// `budgetLeft.wallSec` reporting the full four hours and every packet told the manager it had
	// a budget it had already spent. `runs` and `forkReplicates` were charged on consumption all
	// along, so one object meant two different things.
	//
	// An ended trigger is the moment: the run is over and its summary is written. NOT the fold —
	// most runs never fire a live trigger at all (nothing paused mid-flight), so they were never
	// in `activeRuns` and a charge behind the fold would skip exactly the six-ordinary-runs case
	// this exists for. What keeps it once-only is the ledger: the row below carries `charged`, so
	// "has this run been accounted for" is a question the record answers, whatever the fold did.
	const charged = !live && alreadyCharged(taskDir, runId);
	const consumed = live || charged ? null : runConsumption(runsDir, runId);
	const { charge, over } = consumed ? chargeableConsumption(task, consumed) : { charge: {}, over: [] };
	const spending = Object.keys(charge).length > 0;

	// Nothing to fold and nothing to spend: no save (a write would bump the state version and
	// invalidate a packet in flight for no change), but the fact is still recorded once.
	if (!folds && !spending) {
		if (!live && !charged) appendLedger(taskDir, { kind: "run_ended", runId, trigger: trigger.kind, folded: false, ...endedRow(consumed, charge, over, runId) });
		return null;
	}

	const folded = folds ? setCurrent(task, { activeRuns: live ? [...runs, runId] : runs.filter((r) => r !== runId) }) : task;
	const saved = save(taskDir, spending ? spendBudget(folded, charge) : folded, { expectedVersion: task.stateVersion });
	// After the save, like the batch drops and for the same reason: the row describes a change
	// the save made, not an act that has to be explained if the process dies before it.
	appendLedger(taskDir, {
		kind: live ? "run_registered" : "run_ended",
		runId,
		trigger: trigger.kind,
		...(live ? {} : { folded: folds, ...(charged ? { charged: "already" } : endedRow(consumed, charge, over, runId)) }),
	});
	return saved;
}

/** What an ended row says about the money: what was charged, what overran, or why nothing was. */
function endedRow(consumed, charge, over, runId) {
	return consumed
		? { charged: charge, ...(over.length ? { overran: over } : {}) }
		: { charged: null, note: `no summary.json for ${runId} — this run's wall time and tool calls are unknown and were not charged` };
}

/**
 * Has this run's consumption already been accounted for?
 *
 * The ledger is the record, not the fold: a run can reach two ended triggers (a
 * `milestone_candidate` and, later, a `comparison_ready` naming the same run), and the second
 * must not charge the same wall clock twice. A retracted row never counted, so it does not
 * count here either.
 */
export function alreadyCharged(taskDir, runId) {
	const rows = readLedger(taskDir);
	const retracted = reversedSeqs(rows);
	return rows.some((r) => r.kind === "run_ended" && r.runId === runId && "charged" in r && !retracted.has(r.seq));
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

/**
 * The runs in `current.activeRuns` that are over, and why — the mirror of `settledBatches`.
 *
 * A run is registered by the packet command at a live trigger and removed at an ended one. When
 * no ended trigger ever comes — the supervisor was killed, or died before `finish()` — the entry
 * would sit there forever, and §3's live-run precondition would refuse every `restore` and
 * `compare` on behalf of a run that is not running. Two signals end it without asking anyone:
 *
 * - `ended`: the run wrote `summary.json`, which `finish()` does on the way out. Whatever the
 *   verdict, that run is over.
 * - `ended` also covers a run id with no directory at all: the supervisor makes it before it
 *   does anything else, so its absence is the run's absence.
 * - `stale`: its `audit.jsonl` has not been touched for `staleRunMs`. A live run logs
 *   continuously — a tool call, a mail, an oracle line — so silence is a dead process, not slow
 *   work. A run that has written no audit file at all is NOT stale: it may have started
 *   seconds ago, and absence of evidence is not evidence here.
 */
export function settledRuns(task, runsDir, now = Date.now(), ceiling = staleRunMs(task)) {
	if (!runsDir) return [];
	return (task.current?.activeRuns ?? [])
		.map((runId) => {
			const dir = path.join(runsDir, runId);
			// No run directory at all is conclusive rather than ambiguous: the supervisor creates it
			// before it does anything else, so a registered run without one is a run that is not
			// there — removed, or never started. Only a missing audit file INSIDE an existing
			// directory is the inconclusive case handled below.
			if (!fs.existsSync(dir)) return { runId, why: "ended" };
			if (fs.existsSync(path.join(dir, "summary.json"))) return { runId, why: "ended" };
			try {
				if (now - fs.statSync(path.join(dir, "audit.jsonl")).mtimeMs > ceiling) return { runId, why: "stale" };
			} catch {
				// a directory with no audit line yet: the run may have started seconds ago
			}
			return null;
		})
		.filter(Boolean);
}

/** The registered runs that still count as live. Every validation goes through this rather than
 * `current.activeRuns` directly, the same way `pendingBatches` stands in front of
 * `current.activeBranches`: the record lags, because only the executor writes task.json. */
export function pendingRuns(task, { runsDir = null, now = Date.now(), staleRunMs: ceiling = staleRunMs(task) } = {}) {
	const over = new Set(settledRuns(task, runsDir, now, ceiling).map((r) => r.runId));
	return (task.current?.activeRuns ?? []).filter((r) => !over.has(r));
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
export function liveWorkRefusal(args, task, { taskDir = null, runsDir = null, now = Date.now() } = {}) {
	// `parallel: true` is an OPERATOR's bypass, not one the manager can reach: `defaultVerbs`
	// leaves `restore` and `compare` out of `verbsAllowed` while work is in flight, and the verb
	// check runs before these args are ever looked at — so a packet the harness assembled can
	// never carry a parallel restore past it. What it is for is a hand-written instruction
	// (`tools/manage.mjs execute`, or a packet assembled with an explicit `verbsAllowed`), where
	// a human has decided the contention is worth it. The manager's prompt does not offer it.
	if (args.parallel === true) return null;
	// pendingRuns, not activeRuns: a run whose supervisor died is not something to refuse work for.
	const runs = pendingRuns(task, { runsDir, now });
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
		check: (args, { task, taskDir, runsDir }) => {
			// A run is live if it is registered AND its own records still say so (pendingRuns), or
			// if a batch still in flight has reported it. See runsFromPendingBatches: a restored run
			// is dead before its id is known, so `continue` on one is refused here as not live.
			const live = [...pendingRuns(task, { runsDir }), ...runsFromPendingBatches(taskDir, task)];
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
		check: (args, { task, taskDir, runsDir }) => {
			// The same liveness rule as continue: a correction is delivered through the run's control
			// file, and only a running supervisor tails it.
			if (![...pendingRuns(task, { runsDir }), ...runsFromPendingBatches(taskDir, task)].includes(args.runId)) return `run ${args.runId} is not live (current.activeRuns: ${task.current.activeRuns.join(", ") || "none"})`;
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
			const busy = liveWorkRefusal(args, task, { taskDir, runsDir });
			if (busy) return busy;
			const why = checkpointRefusal(args.checkpoint, runsDir, { taskDir, allowCk: true });
			if (why) return why;
			// A restore from an accepted checkpoint is a PLAIN run — no recorded inference to
			// resume, so no fork — and the two things the fork carried for free have to be named or
			// refused here rather than silently dropped. The config: a `ck-` restore has no source
			// run to inherit one from, and the packet's `run.config` belongs to whatever run the
			// trigger was about, which may be a different task entirely. The message: it reaches an
			// orchestrator only through the control file the FORK path copies into the new run
			// (supervisor.mjs, ARBITER_FORK_CONTROL), so on this path it would be written and read
			// by nothing.
			const cp = parseCheckpoint(args.checkpoint);
			if (cp?.kind === "ck") {
				if (!a.config) return "a restore from an accepted checkpoint must name the config to run it with: approach.config";
				if (a.message) return "a message cannot be delivered to a run restored from an accepted checkpoint (there is no recorded inference to resume); restore first, then correct the run it starts";
				if (a.firstAction) return "a first action cannot be forced on a run restored from an accepted checkpoint: forcing applies to a resumed inference, and this run starts fresh";
				const { config, refusal } = configRefusal(args, packet);
				if (refusal) return refusal;
				let cfg;
				try {
					cfg = JSON.parse(fs.readFileSync(config, "utf8"));
				} catch (err) {
					return `config ${a.config} is not readable JSON: ${err.message}`;
				}
				// The workspace source is MANAGE-gated inside the supervisor (ARBITER_WS_SOURCE), so a
				// config without a manage block does not fail — it prints one line and starts from the
				// task's SEED. The run then produces an id, exits 0, and its outcome row is
				// indistinguishable from a real restore: the manager reads "restored from ck-0007"
				// while looking at a fresh start. Refused here, where a run has not been spent yet.
				if (cfg?.manage?.enabled !== true) return `a restore from an accepted checkpoint needs a config whose manage block is enabled — the workspace source is MANAGE-gated, and ${a.config} would start from the task's seed instead`;
				// The workspace is the checkpoint's; the oracle, the mounts and the spec are still the
				// config's. A config for another task runs that task's oracle against this tree and
				// spends the run on a comparison nobody asked for. It cannot produce a false
				// acceptance (`accept` re-derives the oracle dir from the run's own summary), so this
				// is about not wasting the run. Skipped for a checkpoint written before manifests
				// recorded a task.
				const of = readManifest(taskDir, cp.id)?.task ?? null;
				if (taskDir && of && cfg?.task && cfg.task !== of) return `${args.checkpoint} is a checkpoint of task ${of}, and ${a.config} runs task ${cfg.task} — its oracle and mounts would be the wrong ones for this workspace`;
				return null;
			}
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
			const busy = liveWorkRefusal(args, task, { taskDir, runsDir });
			if (busy) return busy;
			const why = checkpointRefusal(args.checkpoint, runsDir, { taskDir });
			if (why) return why;
			return configRefusal(args, packet).refusal ?? null;
		},
	},
	accept: {
		required: ["milestone", "checkpoint", "evidence"],
		// §6 in full, and it lives HERE rather than in the executor on purpose: a milestone that
		// cannot be accepted is refused exactly like a stale instruction or an exhausted budget —
		// one refusal row, one code, and task.json untouched. Verifying after the instruction's row
		// was written would need a second refusal path with its own retraction. What this does
		// write is the evidence_check row below and a playthrough's log: records of the attempt,
		// not changes to the task.
		check: (args, { task, taskDir, runsDir, spawn, out }) => {
			if (!Array.isArray(args.evidence)) return "evidence must be a list of run ids";
			if (args.evidence.some((e) => typeof e !== "string" || !e.trim())) return "evidence must be a list of run ids";
			const m = (task.milestones ?? []).find((x) => x.id === args.milestone);
			if (!m) return `no milestone ${args.milestone} in this task (${(task.milestones ?? []).map((x) => x.id).join(", ") || "none"})`;
			if (args.milestone !== task.current?.milestone) return `milestone ${args.milestone} is not current (${task.current?.milestone ?? "none"})`;
			if (m.status !== "active") return `milestone ${args.milestone} is ${m.status}, not active`;
			// Run ids are read by ONE kind. A milestone whose criteria are all artifact:, playthrough:
			// or review: is satisfied by the checkpoint and the ledger alone, and demanding a run id
			// anyway made the honest instruction name a run nothing would look at.
			const criteria = (m.criteria ?? []).map((id) => (task.acceptance?.criteria ?? []).find((c) => c.id === id) ?? { id, check: null });
			const oracles = criteria.filter((c) => String(c.check ?? "").startsWith("oracle:"));
			if (oracles.length && !args.evidence.length) return `accept needs at least one run id as evidence for ${oracles.map((c) => c.id).join(", ")}`;
			// A candidate is the workspace a run preserved on the way out, not a state anyone has
			// accepted; promoting it is a separate, human-run act (tools/manage.mjs checkpoint
			// promote). Named apart from the generic shape refusal below so the operator is told
			// what to do rather than that their id is malformed.
			if (isCandidateId(args.checkpoint)) return `${args.checkpoint} is a candidate preserved by its run — promote it first (tools/manage.mjs checkpoint promote <taskDir> ${args.checkpoint})`;
			if (!isCheckpointId(args.checkpoint)) return `accept needs a checkpoint id ck-NNNN (got ${JSON.stringify(args.checkpoint)})`;
			// Without a task directory there are no checkpoints and no ledger to verify against —
			// the same dry-validation allowance checkpointRefusal makes for a missing runsDir.
			if (!taskDir) return null;
			if (!fs.existsSync(checkpointDir(taskDir, args.checkpoint))) return `no checkpoint ${args.checkpoint} in ${path.join(taskDir, "checkpoints")}`;
			// Before the loop, because the loop has a side effect outside this process: a
			// `playthrough:` criterion spawns a script that may run for ten minutes. Killed at minute
			// five, it would otherwise leave a partial log inside the checkpoint and nothing anywhere
			// saying an acceptance had been attempted. Not an instruction row — it records an attempt
			// to verify, not an act — so nothing retracts it and findByKey never matches it.
			appendLedger(taskDir, { kind: "evidence_check", milestone: m.id, checkpoint: args.checkpoint, criteria: criteria.map((c) => c.id), evidence: args.evidence });
			const artefacts = [];
			for (const criterion of criteria) {
				const id = criterion.id;
				// Unreachable through createTask and fatal if it ever happened: a milestone naming a
				// criterion the acceptance does not define would otherwise be accepted on no evidence.
				if (!criterion.check) return `milestone ${m.id} names criterion ${id}, which this task's acceptance does not define`;
				const r = checkEvidence(criterion, { taskDir, checkpoint: args.checkpoint, runsDir, evidence: args.evidence, spawn });
				// The FIRST failure is the refusal, and it names the criterion, its kind and why —
				// §6's "the refusal names the criterion". Later criteria are not checked: a
				// playthrough is a ten-minute run, and the answer is already no.
				if (!r.ok) return `criterion ${id} (${criterion.check}): ${r.reason}`;
				artefacts.push(...r.artefacts);
			}
			// What actually satisfied the criteria, for §1's `milestones[].evidence`. Carried out on
			// the validation result rather than recomputed by the executor, so a playthrough runs
			// once per instruction.
			out.accept = { evidence: artefacts };
			return null;
		},
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
		// A restore from a captured inference is one run AND one fork replicate: it is started
		// through the fork runner, so it spends both, and a task out of replicates cannot start one
		// however many runs it has left. A restore from an accepted checkpoint spends a run alone —
		// it is a plain supervisor run with a different starting workspace, and nothing about it
		// consumes the fork budget. Charged exactly this way in executeInstruction, in one write.
		if (left.runs === 0) return "no run budget left";
		if (parseCheckpoint(instr.args?.checkpoint)?.kind === "ck") return null;
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
 *
 * `spawn` is `accept`'s injectable child-process runner (a `playthrough:` criterion runs a
 * script); it reaches checkEvidence and nothing else. A successful `accept` returns its verified
 * artefacts as `{ ok: true, accept: { evidence } }` — the check is where the work happens, so it
 * is also where the result comes from, and the executor must not run a playthrough twice.
 */
export function validateInstruction(instr, { task, packet, taskDir, runsDir, spawn: evidenceSpawn } = {}) {
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

	// §3's `escalate` "pauses the task … nothing else moves", and §1's `status` is where that is
	// written. Without a reader it was only a field: an escalated task answered the very next
	// trigger, spent the next grant and could launch a compare — the opposite of what the verb
	// promises — and a `complete` task went on being managed after its last milestone was
	// accepted. `escalate` itself stays legal at any status: it is how the next thing is put in
	// front of a human, and it moves nothing either way.
	if (instr.verb !== "escalate" && task.status && task.status !== "active") {
		const open = (task.blockers ?? []).filter((b) => b.status === "open").map((b) => b.id);
		return refuse(
			task.status === "complete" ? "task_complete" : "task_paused",
			`the task is ${task.status}, not active — only escalate is accepted until a human resumes it${open.length ? ` (open blockers: ${open.join(", ")})` : ""}`,
		);
	}

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
	//
	// `correct.message` is exempt for the same reason and no more: it is prose delivered to the
	// orchestrator, and "the acceptance criteria say 70/70 — you are at 68" is the most useful
	// correction there is. It was refused as an attempt to edit acceptance, which taught the
	// manager to talk around the word rather than protecting anything: a correction is a string
	// handed to an agent, it is never written near `acceptance`, and every OTHER arg of a
	// `correct` (the run id) is still scanned, as is every arg of every other verb.
	const scanned = instr.verb === "correct" ? { ...args, message: undefined } : args;
	if (instr.verb !== "escalate" && /acceptance/i.test(JSON.stringify(scanned))) return refuse("precondition", "acceptance criteria are immutable — no instruction can change them; escalate with wants=\"criteria_change\" instead");
	const spec = ARGS[instr.verb];
	for (const k of spec.required) if (args[k] == null) return refuse("precondition", `${instr.verb} requires args.${k}`);
	const out = {};
	// A precondition that THROWS is still a precondition that failed. Every refusal in this
	// contract is a ledger row, and executeInstruction's own try/catch begins after this call —
	// so an exception raised in here escaped as a stack trace out of tools/manage.mjs with no row,
	// no code and no reason. `accept` made that reachable from ordinary inputs: a truncated
	// manifest.json, a live run whose tree is being rewritten while it is hashed, a checkpoint on
	// a read-only disk. The instruction is refused with the error as its reason, which is what the
	// manager can act on. Nothing in the task's STATE has moved: `accept` may have appended an
	// evidence_check row and written a playthrough log by this point, both of which are records of
	// the attempt and correct to keep, but task.json is untouched and no run has been asked for.
	let why;
	try {
		why = spec.check(args, { task, packet, taskDir, runsDir, spawn: evidenceSpawn, out });
	} catch (err) {
		return refuse("precondition", `${instr.verb} could not be verified: ${err?.message ?? err}`);
	}
	if (why) return refuse("precondition", why);
	return { ok: true, ...out };
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

/**
 * The next compare directory, created exclusively — the id is a claim, not a guess.
 *
 * Two executors answering two packets at once both computed `max + 1`, both `mkdir`ed it
 * recursively (which succeeds on an existing directory) and both wrote `spec.json` before either
 * saved. The loser retracts its ledger row and never launches — but its spec has already
 * overwritten the winner's, so the winner's detached child runs the LOSER's branches under the
 * winner's row and idempotency key. An exclusive create makes the second writer take the next id
 * instead, which is the same technique `snapshotCheckpoint` uses for a checkpoint directory.
 */
export function claimCompareDir(taskDir, { attempts = 50 } = {}) {
	fs.mkdirSync(path.join(taskDir, "compares"), { recursive: true });
	let compareId = nextCompareId(taskDir);
	for (let i = 0; i < attempts; i++, compareId++) {
		const dir = path.join(taskDir, "compares", String(compareId));
		try {
			fs.mkdirSync(dir); // no recursive: EEXIST rather than a silent merge
			return { compareId, dir };
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
	}
	throw new Error(`could not claim a compare directory under ${path.join(taskDir, "compares")} after ${attempts} attempts`);
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
 *
 * A restore from an ACCEPTED checkpoint is the same machinery once more, with `wsSource` set and
 * no recorded inference: the child starts a plain supervisor run whose workspace is that
 * checkpoint. Everything else — the id, the spec file, the ledger row, the pending entry — is
 * identical, so one path reads out both.
 */
function prepareBatch({ taskDir, task, instr, packet, runsDir }) {
	const args = instr.args ?? {};
	const verb = instr.verb;
	const cp = parseCheckpoint(args.checkpoint); // validated already: `run:` here, or `ck-` for a restore
	const { config } = configRefusal(args, packet);
	const raw = verb === "restore" ? [{ label: forkBranchOf(args.approach ?? {}), firstAction: args.approach?.firstAction ?? null, message: args.approach?.message ?? null }] : args.branches;
	const replicates = verb === "restore" ? 1 : Number(args.replicates);
	const { compareId, dir } = claimCompareDir(taskDir);

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
	// A `ck-` restore has no recorded inference: `wsSource` is the whole difference, and it is what
	// the batch child branches on. Absolute, because the child spawns the supervisor with the repo
	// root as its cwd and hands this straight to it as ARBITER_WS_SOURCE.
	const fromCheckpoint = cp.kind === "ck";
	const spec = {
		kind: verb, compareId, taskDir: path.resolve(taskDir), runsDir: path.resolve(runsDir),
		packetId: instr.packetId ?? packet?.packetId ?? null, idempotencyKey: instr.idempotencyKey,
		checkpoint: args.checkpoint,
		wsSource: fromCheckpoint ? path.resolve(checkpointDir(taskDir, cp.id)) : null,
		runId: fromCheckpoint ? null : cp.runId, call: fromCheckpoint ? null : cp.call,
		recordedTool: fromCheckpoint ? null : recordedToolAt(runsDir, cp),
		config, replicates, branches, scope: `task:${task.taskId}`,
	};
	const specFile = path.join(dir, "spec.json");
	fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
	// A restore from a checkpoint spends a run and nothing else: no fork runner, no replicate.
	const spend = verb !== "restore" ? { forkReplicates: branches.length * replicates } : fromCheckpoint ? { runs: 1 } : { runs: 1, forkReplicates: 1 };
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
export function executeInstruction({ taskDir, instr, packet, runsDir, launchBatch = defaultLaunchBatch, save = saveTask, spawn: evidenceSpawn, manager = null }) {
	const task = loadTask(taskDir);
	const v = validateInstruction(instr, { task, packet, taskDir, runsDir, spawn: evidenceSpawn });

	if (!v.ok && v.code === "duplicate_key") {
		return { executed: false, duplicate: true, ledgerRow: findByKey(taskDir, instr.idempotencyKey), refusal: v.refusal };
	}

	const base = {
		packetId: instr?.packetId ?? packet?.packetId ?? null,
		stateVersion: task.stateVersion,
		trigger: packet?.trigger?.kind ?? null,
		// §5's own slot, beside the instruction rather than inside it: `{ model, ms, usd }` (and,
		// when the driver defaulted, the error that made it default) is a fact about the CALL that
		// produced this instruction, not part of the instruction the contract validates. Absent
		// unless a caller passes one, so every hand-written and operator-driven instruction records
		// exactly the row it always did.
		...(manager ? { manager } : {}),
		instruction: instr,
	};

	if (!v.ok) {
		const row = appendLedger(taskDir, { ...base, verified: false, refused: v.code, reason: v.refusal, executed: null });
		return { executed: false, ledgerRow: row, refusal: v.refusal, code: v.code };
	}

	if (NOT_YET_IMPLEMENTED.includes(instr.verb)) throw new NotYetImplemented(`${instr.verb} is in the contract but the harness cannot carry it out yet`);

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
			// Runs are folded on the same rule and in the same write (settledRuns): a supervisor that
			// was killed never emits an ended trigger, and its entry would otherwise refuse every
			// later restore and compare on behalf of a run that stopped hours ago.
			const settled = settledBatches(task, taskDir);
			const overRuns = settledRuns(task, runsDir);
			const keep = (task.current.activeBranches ?? []).filter((b) => !settled.some((s) => s.batchId === b.batchId));
			const keepRuns = (task.current.activeRuns ?? []).filter((r) => !overRuns.some((o) => o.runId === r));
			save(taskDir, setCurrent(spendBudget(task, batch.spend), { activeRuns: keepRuns, activeBranches: [...keep, batch.pending] }), { expectedVersion: task.stateVersion });
			// AFTER the save, unlike the instruction's own row: these rows describe drops the save
			// makes, not an act the ledger has to survive a crash to explain. Written first, a lost
			// compare-and-swap would leave the ledger claiming drops that never happened, and the
			// next attempt would write them all over again.
			for (const b of settled) appendLedger(taskDir, { kind: b.why === "stale" ? "batch_stale" : "batch_cleared", batchId: b.batchId, launchedAt: b.launchedAt ?? null });
			for (const r of overRuns) appendLedger(taskDir, { kind: r.why === "stale" ? "run_stale" : "run_ended", runId: r.runId, reason: r.why === "stale" ? "no audit line within staleRunMs" : "summary.json written" });
			extra.batchId = batch.compareId;
			extra.specFile = batch.specFile;
			extra.launched = launchBatch({ specFile: batch.specFile, dir: batch.dir, taskDir, runsDir });
		} else if (instr.verb === "accept") {
			// Everything §6 requires was verified in validateInstruction, and `v.accept.evidence` is
			// what satisfied it. All that is left is the state change, and it is ONE save: the
			// milestone, the next one, `current` and — when there is no next one — the task's own
			// status move together, or not at all. Two writes would bump the state version twice for
			// one instruction and could leave a task with an accepted milestone and no current one.
			const i = task.milestones.findIndex((m) => m.id === instr.args.milestone);
			const milestones = task.milestones.map((m, k) =>
				k === i ? { ...m, status: "accepted", acceptedCheckpoint: instr.args.checkpoint, acceptedAt: Date.now(), evidence: v.accept.evidence } : m,
			);
			// The next milestone in the task's own order, not the next one the manager names: §1's
			// list is the plan, and letting an instruction pick which milestone becomes active would
			// be a manager reordering the work it is being measured against.
			const nextIdx = milestones.findIndex((m, k) => k > i && m.status === "pending");
			if (nextIdx >= 0) milestones[nextIdx] = { ...milestones[nextIdx], status: "active" };
			const next = nextIdx >= 0 ? milestones[nextIdx] : null;
			extra.accepted = { milestone: instr.args.milestone, checkpoint: instr.args.checkpoint, evidence: v.accept.evidence, next: next?.id ?? null };
			save(
				taskDir,
				{
					...setCurrent({ ...task, milestones }, { milestone: next?.id ?? null, checkpoint: instr.args.checkpoint }),
					// Nothing left to accept is the task being over, and it has to be said in the state
					// rather than inferred by each reader from "every milestone is accepted" — §1's
					// `status` is what the packet and the CLI report.
					status: next ? task.status : "complete",
				},
				{ expectedVersion: task.stateVersion },
			);
			appendLedger(taskDir, { kind: "accepted", milestone: instr.args.milestone, checkpoint: instr.args.checkpoint, evidence: v.accept.evidence, next: next?.id ?? null });
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
