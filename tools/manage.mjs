// tools/manage.mjs — CLI over lib/manage/*: create a task, assemble+write an observation
// packet from an existing run's records, execute one manager instruction, and print the
// ledger. `execute` is the only command with an effect outside the task
// directory, and even that reaches a live run through one appended file
// (runs/<id>/control.jsonl) which the supervisor tails — this process never touches an
// agent, a workspace or the oracle.
//
// Three commands DO reach the network, and only these: `decide`, `replay` and `serve` call the
// Messages API through lib/manage/manager.mjs. The key is read here and nowhere else (§3's
// driver is pure over an injected fetch), from ANTHROPIC_API_KEY or the repo's .env, and it is
// never printed, never logged and never put in an error message.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// loadTask, never saveTask: `accept` needs the version its synthetic packet is built on, and
// reading is not writing — the batch child still never writes task.json (markBatchDone).
import { createTask, loadTask, budgetLeft } from "../lib/manage/task-state.mjs";
import { assemblePacket, writePacket } from "../lib/manage/packet.mjs";
import { readLedger, readFindings, appendFinding, settleFinding, recordOutcome, appendLedger } from "../lib/manage/ledger.mjs";
import { executeInstruction, registerRunForTrigger } from "../lib/manage/instructions.mjs";
import { listCheckpoints, promoteCandidate, isCandidateId } from "../lib/manage/checkpoint.mjs";
import { compareTable, findingsFromCompare, incompleteBranches, settleOrAppend } from "../lib/manage/compare.mjs";
import { decide, replay, serve, releaseServeLock, DEFAULT_MANAGER_MODEL, DEFAULT_TIMEOUT_MS, UNSUPPORTED_MODEL, unsupportedModelReason } from "../lib/manage/manager.mjs";
import { runBatch, runOnce } from "./fork.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

const USAGE = `usage:
  node tools/manage.mjs init <taskDir> --task <id> --goal "<text>" --criteria <json> --milestones <json> [--budget <json>]
  node tools/manage.mjs packet <taskDir> <runId> --trigger <kind> [--detail <json>] [--runs <dir>]
  node tools/manage.mjs execute <taskDir> <instruction.json> [--packet <n|file>] [--runs <dir>]
  node tools/manage.mjs accept <taskDir> <milestone> <checkpoint> --evidence <runId,...> [--packet <n|file>] [--runs <dir>]
  node tools/manage.mjs review <taskDir> <criterionId> <checkpoint> --by <name>
  node tools/manage.mjs checkpoint promote <taskDir> cand-<runId>
  node tools/manage.mjs checkpoint list <taskDir>
  node tools/manage.mjs run-batch <taskDir> <compares/<n>/spec.json>
  node tools/manage.mjs compare-ready <taskDir> <compares/<n>>
  node tools/manage.mjs ledger <taskDir>
  node tools/manage.mjs decide <taskDir> <packetId> [--model <m>] [--timeout <ms>] [--execute] [--runs <dir>]
  node tools/manage.mjs replay <taskDir> --model <m> [--packets 1,2,3] [--timeout <ms>]
  node tools/manage.mjs serve <taskDir> [--model <m>] [--timeout <ms>] [--runs <dir>] [--run <runId>] [--once]`;

/** Splits argv into --flag value pairs and the remaining positionals, in order. */
export function splitArgs(argv) {
	const flags = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			// A flag whose next token is another flag (or nothing) is a switch, not a flag with a
			// value: `serve <dir> --once --model m` must not read "--model" as `once`'s value and
			// then leave "m" standing as a positional task directory.
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				flags[a.slice(2)] = true;
				continue;
			}
			flags[a.slice(2)] = next;
			i++;
		} else {
			positionals.push(a);
		}
	}
	return { flags, positionals };
}

function parseJsonFlag(flags, name, fallback) {
	if (flags[name] == null) return fallback;
	try {
		return JSON.parse(flags[name]);
	} catch (err) {
		throw new Error(`--${name} must be JSON: ${err.message}`);
	}
}

function usageExit() {
	console.error(USAGE);
	process.exit(2);
}

function cmdInit(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir] = positionals;
	if (!taskDir || !flags.task || !flags.goal || !flags.criteria || !flags.milestones) return usageExit();
	const criteria = parseJsonFlag(flags, "criteria");
	const milestones = parseJsonFlag(flags, "milestones");
	const budget = parseJsonFlag(flags, "budget", {});
	fs.mkdirSync(taskDir, { recursive: true });
	const task = createTask({ dir: taskDir, taskId: flags.task, goal: flags.goal, criteria, milestones, budget });
	console.log(JSON.stringify(task, null, 2));
}

function cmdPacket(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir, runId] = positionals;
	if (!taskDir || !runId || !flags.trigger) return usageExit();
	const runsRoot = flags.runs ?? path.join(here, "..", "runs");
	const runDir = path.join(runsRoot, runId);
	const detail = parseJsonFlag(flags, "detail", {});
	const trigger = { kind: flags.trigger, runId, detail };
	// Before the packet, never after. A live trigger is the only moment anything can put this run
	// into current.activeRuns — the supervisor starts runs but must not write task.json — and
	// `continue` and `correct` are refused for a run that is not in that list. The packet has to
	// carry the version this registration produced, because that is the version the manager's
	// `basedOnStateVersion` will name.
	const registered = registerRunForTrigger(taskDir, trigger, { runsDir: runsRoot });
	if (registered) console.error(`[manage] ${runId}: activeRuns is now [${registered.current.activeRuns.join(", ")}] at stateVersion ${registered.stateVersion}`);
	const packet = assemblePacket({ taskDir, runDir, trigger });
	const file = writePacket(taskDir, packet);
	console.log(`${file} (${JSON.stringify(packet).length} chars)`);
}

/**
 * Executes one instruction against a task. The packet it answers is loaded from
 * packets/<packetId>.json (or --packet, which takes an id or a path) so the verbs the harness
 * pruned and the state the manager actually saw are the ones checked — never re-derived here.
 * Exit 3 on a refusal, 0 on execution or on a duplicate acknowledgement.
 */
function cmdExecute(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir, instrFile] = positionals;
	if (!taskDir || !instrFile) return usageExit();
	const instr = JSON.parse(fs.readFileSync(instrFile, "utf8"));
	const packetArg = flags.packet ?? String(instr.packetId ?? "");
	const packetFile = packetArg && /^\d+$/.test(packetArg) ? path.join(taskDir, "packets", `${packetArg}.json`) : packetArg;
	if (!packetFile || !fs.existsSync(packetFile)) {
		console.error(`no packet for this instruction (looked for ${packetFile || "nothing"}); pass --packet <n|file>`);
		process.exit(2);
	}
	const packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
	const runsDir = flags.runs ?? path.join(here, "..", "runs");
	reportResult(executeInstruction({ taskDir, instr, packet, runsDir }));
}

/** What an operator sees for any executed instruction: the ledger row on success, the reason and
 * exit 3 on a refusal, and an acknowledgement (exit 0) for a key that already ran. */
function reportResult(result) {
	if (result.executed) {
		console.log(JSON.stringify(result.ledgerRow));
		return;
	}
	if (result.duplicate) {
		console.log(`already executed: ${result.refusal}`);
		console.log(JSON.stringify(result.ledgerRow));
		return;
	}
	console.error(`refused (${result.code}): ${result.refusal}`);
	console.error(JSON.stringify(result.ledgerRow));
	process.exit(3);
}

/**
 * `accept <taskDir> <milestone> <checkpoint> --evidence <runId,...>` — the human's way to ask for
 * §6's verification, and the only verb with a hand-driven entry point.
 *
 * It goes through `executeInstruction` like everything else: the checking, the ledger row, the
 * single save and the refusal codes are the contract, and a second acceptance path would be a
 * second place §6 could be got wrong. What is synthesised is only the PACKET — an `accept` asked
 * for at a terminal answers no trigger and has no packet on disk, so one is built naming the
 * verb it allows and the version the task is at right now. `--packet` overrides it whenever a
 * real one exists (a `milestone_candidate` the manager was shown), and then the manager's own
 * verbsAllowed and packetId are what get checked.
 */
function cmdAccept(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir, milestone, checkpoint] = positionals;
	if (!taskDir || !milestone || !checkpoint) return usageExit();
	// Optional: run ids are read by `oracle:` criteria alone, and a milestone made of artifact:,
	// playthrough: and review: checks is satisfied by the checkpoint and the ledger. The executor
	// refuses an empty list only when the milestone actually names an oracle criterion.
	const evidence = String(flags.evidence ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const runsDir = flags.runs ?? path.join(here, "..", "runs");
	const task = loadTask(taskDir);
	const packetFile = flags.packet && /^\d+$/.test(flags.packet) ? path.join(taskDir, "packets", `${flags.packet}.json`) : flags.packet;
	const packet = packetFile
		? JSON.parse(fs.readFileSync(packetFile, "utf8"))
		: { packetId: null, trigger: { kind: "milestone_candidate", runId: evidence[0] ?? null, detail: { by: "operator" } }, task, run: { id: evidence[0] ?? null }, options: { verbsAllowed: ["accept", "escalate"], budgetLeft: budgetLeft(task) } };
	const instr = {
		packetId: packet.packetId ?? null,
		basedOnStateVersion: task.stateVersion,
		// The key names one answer to one packet (§3). With no packet, the milestone and the
		// checkpoint are the answer: accepting m2 at ck-0007 is one act however many times the
		// command is typed. The state version is deliberately NOT in it — executing an accept moves
		// the version, so a key carrying it would be different on the retry, and the retry would be
		// verified all over again and then refused for a milestone that is no longer current, which
		// is §3's duplicate rule exactly inverted. `--key` overrides for the rare second acceptance
		// of the same pair (a checkpoint re-promoted after a human fixed something by hand).
		idempotencyKey: flags.key ?? `accept-${milestone}-${checkpoint}`,
		verb: "accept",
		args: { milestone, checkpoint, evidence },
		rationale: flags.rationale ?? "accepted by an operator at the command line",
	};
	reportResult(executeInstruction({ taskDir, instr, packet, runsDir }));
}

/**
 * `review <taskDir> <criterionId> <checkpoint> --by <name>` — the producer of §6's one kind of
 * evidence a human must write, and the reason `review:human` is not a thing to hand-append.
 *
 * Two refusals earn their place. A review against a `cand-` id is void by construction: promotion
 * RENAMES the directory, so the row would name a checkpoint that no longer exists, and the CLI's
 * own list → promote → accept order invites signing too early. And a criterion whose check is not
 * `review:` is a signature nothing will ever read — `checkEvidence` looks at the ledger only for
 * that kind.
 */
function cmdReview(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir, criterionId, checkpoint] = positionals;
	// A bare `--by` with nothing after it leaves `flags.by` undefined, and the row would be signed
	// by nobody — which `checkEvidence` refuses, but only after the human believes they signed it.
	if (!taskDir || !criterionId || !checkpoint || typeof flags.by !== "string" || !flags.by.trim()) return usageExit();
	const task = loadTask(taskDir);
	const criterion = (task.acceptance?.criteria ?? []).find((c) => c.id === criterionId);
	const bad = !criterion
		? `no criterion ${criterionId} in this task (${(task.acceptance?.criteria ?? []).map((c) => c.id).join(", ") || "none"})`
		: !String(criterion.check).startsWith("review:")
			? `criterion ${criterionId} is ${criterion.check}, which the harness verifies itself — only a review: criterion takes a signature`
			: isCandidateId(checkpoint)
				? `${checkpoint} is a candidate; promote it first and sign the ck- id it becomes, or the row names a checkpoint that no longer exists`
				: !fs.existsSync(path.join(taskDir, "checkpoints", checkpoint))
					? `no checkpoint ${checkpoint} in ${path.join(taskDir, "checkpoints")}`
					: null;
	if (bad) {
		console.error(bad);
		process.exit(3);
	}
	const row = appendLedger(taskDir, { kind: "review", criterion: criterionId, checkpoint, by: flags.by, signed: true, note: flags.note ?? null });
	console.log(JSON.stringify(row));
}

/** `checkpoint promote|list` — the two things a human does with checkpoints. Promotion is
 * deliberately not a verb: no instruction promotes a candidate, because a candidate is the state
 * a run left behind and turning it into something acceptable is the operator's judgement. */
function cmdCheckpoint(argv) {
	const { positionals } = splitArgs(argv);
	const [sub, taskDir, id] = positionals;
	if (sub === "list" && taskDir) {
		for (const c of listCheckpoints(taskDir)) console.log(`${c.id}\t${c.candidate ? "candidate" : "accepted"}\t${c.manifest?.treeHash ?? "no manifest"}\t${c.manifest?.runId ?? "-"}\t${c.manifest?.oracle ? `${c.manifest.oracle.pass}/${c.manifest.oracle.total}` : "-"}`);
		return;
	}
	if (sub === "promote" && taskDir && id) {
		try {
			const out = promoteCandidate(taskDir, id);
			console.log(`${id} → ${out.id} (${out.manifest.treeHash})`);
		} catch (err) {
			console.error(err.message);
			process.exit(3);
		}
		return;
	}
	return usageExit();
}

/**
 * One plain supervisor run started from an accepted checkpoint: `runOnce` with
 * `ARBITER_WS_SOURCE` set, which is the single thing that makes it a restore.
 *
 * The three fork variables are cleared explicitly rather than left to the inherited environment.
 * `runOnce` spreads `process.env` under this, and a stale `ARBITER_FORK` in the shell that
 * launched the batch would turn this plain run into a fork of somebody else's recording — the
 * same trap `planForks` documents for `ARBITER_FORK_FORCE`.
 */
const defaultRestoreRun = ({ config, wsSource, runsDir, logFile }) =>
	runOnce(config, { ARBITER_WS_SOURCE: wsSource, ARBITER_FORK: "", ARBITER_FORK_FORCE: "", ARBITER_FORK_CONTROL: "" }, logFile, runsDir);

/** The last few hundred characters of a child's log, for an outcome row that has to say why a
 * run produced nothing. Bounded because the ledger is read into packets. */
function logTail(file, chars = 600) {
	try {
		const text = fs.readFileSync(file, "utf8").trim();
		return text ? text.slice(-chars) : "the run produced no output and no run directory";
	} catch {
		return "the run produced no run directory and no log";
	}
}

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
/** A path as a finding's evidence should read it: relative to the repo root when it is inside. */
const relRoot = (p) => (path.resolve(p).startsWith(path.resolve(ROOT) + path.sep) ? path.relative(ROOT, p).split(path.sep).join("/") : p);

/**
 * Runs the batch a `restore` or `compare` prepared: one `runBatch` per branch, sequentially
 * (one model server slot — the same reason the fork runner's replicates are sequential), then
 * the read-out. This is the detached child `executeInstruction` launches, and it is a plain CLI
 * command over a spec file on disk, so an operator can re-run exactly what the manager asked
 * for, or drive a comparison entirely by hand.
 *
 * A `restore` ends here: it is one branch of one replicate, it produces no findings (there is
 * nothing to compare it against), and what it owes the task is the new run's id — appended as an
 * outcome row, which is the manager's only handle on it. It is deliberately NOT added to
 * `current.activeRuns`: `runOnce` awaits the supervisor's exit, so the id exists only once the
 * run is over, and a dead run in `activeRuns` would validate a `continue` whose grant is charged
 * against a control file nothing is tailing.
 *
 * Either way the batch says it is over before this returns — success, abandonment or throw — by
 * writing `done.json` in its own directory. It never writes task.json: see markBatchDone.
 */
export async function runBatchSpec({ taskDir, specFile, runner = runBatch, restoreRun = defaultRestoreRun }) {
	const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
	const dir = path.dirname(path.resolve(specFile));
	// Before anything spawns. The budget was charged when the instruction executed, and every
	// replicate below is a real supervisor run: a second `run-batch` over a spec whose batch has
	// already been read out would re-run all of them, overwrite the rows and reports the findings
	// were drawn from, and only then hit compareReady's own refusal.
	const readyFile = path.join(dir, "ready.json");
	const rows = [];
	let abandoned = null;
	let status = "failed";
	try {
		if (fs.existsSync(readyFile)) {
			// Inside the try, so the finally below still writes the clearance marker: a first child
			// that wrote ready.json and then died before marking would otherwise leave this batch
			// pending until staleBatchMs, refusing every restore and compare in between.
			status = "ready";
			const prior = JSON.parse(fs.readFileSync(readyFile, "utf8"));
			console.log(`[batch ${spec.compareId}] already ready (packet ${prior.packetId ?? "none"}); nothing re-run`);
			return { alreadyReady: true, ...prior };
		}
		// A restore from an accepted checkpoint: one plain supervisor run whose workspace is that
		// checkpoint, not a fork of a recorded inference. It owes the task the same one thing a
		// `run:` restore owes it — the new run's id, as an outcome row, which is the manager's only
		// handle on it — and, like that one, it is deliberately NOT added to current.activeRuns:
		// the id exists only once the run is over.
		if (spec.wsSource) {
			console.log(`[batch ${spec.compareId}] restore from ${spec.checkpoint} (${spec.wsSource})`);
			const logFile = path.join(dir, "restore.log");
			const out = await restoreRun({ config: spec.config, wsSource: spec.wsSource, runsDir: spec.runsDir, logFile });
			const row = { label: spec.branches[0]?.label ?? "restore", runId: out.runId ?? null, exit: out.code ?? null, crashed: out.code !== 0, checkpoint: spec.checkpoint };
			rows.push(row);
			fs.writeFileSync(path.join(dir, "rows.jsonl"), JSON.stringify(row) + "\n");
			// A run that never made a run directory left nothing in the run records to explain
			// itself: the supervisor's startup refusals (a WS_SOURCE that names nothing, a config it
			// cannot read) print to stderr and exit before the audit stream exists. That stderr is in
			// this log and nothing else reads it, so its tail goes into the outcome row — otherwise a
			// mistyped path is a restore that fails silently from the next packet's point of view.
			const failed = row.runId ? null : logTail(logFile);
			recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, runId: row.runId, crashed: row.crashed, checkpoint: spec.checkpoint, ...(failed ? { failed } : {}) });
			console.log(`[batch ${spec.compareId}] restore → ${row.runId ?? "no run"} (exit ${row.exit})`);
			status = "ready";
			return { rows, runId: row.runId };
		}
		for (const b of spec.branches) {
			console.log(`[batch ${spec.compareId}] branch ${b.label} (${b.forkBranch}${b.firstAction ? ` ${b.firstAction}` : ""}) × ${spec.replicates}`);
			const out = await runner({
				runId: spec.runId, call: spec.call, branch: b.forkBranch, action: b.firstAction ?? null, label: b.label,
				replicates: spec.replicates, config: spec.config, control: b.controlFile ?? null, runsDir: spec.runsDir,
			});
			fs.writeFileSync(path.join(dir, `report-${b.label}.md`), out.report);
			for (const row of out.rows) rows.push({ ...row, label: b.label });
			// Written after every branch, not once at the end: a batch that dies on its third
			// branch must still leave the two that finished readable.
			fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
			if (out.abandoned) {
				// The collision preflight holds the SOURCE run's out-of-tree paths, so it is not
				// this branch's problem and not this branch's alone: every later branch forks the
				// same run and would fail identically. Stop, and above all do not read the batch
				// out — one crashed row per branch compares to one crashed row per branch, and
				// `same` on both sides is how a finding gets verified by a batch that never ran.
				abandoned = { branch: b.label, ...out.abandoned };
				console.error(`[batch ${spec.compareId}] abandoned on branch ${b.label}: ${out.abandoned.collision}`);
				break;
			}
		}

		if (abandoned) {
			recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, failed: "collision", branch: abandoned.branch, rows: rows.length });
			return { rows, abandoned };
		}
		if (spec.kind === "restore") {
			const runId = rows.find((r) => r.runId)?.runId ?? null;
			recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, runId, crashed: rows.every((r) => r.crashed) });
			console.log(`[batch ${spec.compareId}] restore → ${runId ?? "no run"}`);
			status = "ready";
			return { rows, runId };
		}
		const out = compareReady({ taskDir, batchDir: dir });
		status = "ready";
		// §5's outcome slot, for the success case too: the packet says a comparison happened, but
		// the ledger is what the next manager reads about the instruction it answered.
		recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, packetId: out.packetId, findings: out.findings.map((f) => f.id), short: out.short ?? null, runs: rows.map((r) => r.runId).filter(Boolean) });
		return { rows, ...out };
	} catch (err) {
		// The ledger's last word on this instruction must not be "launched". Nothing is watching
		// this child: anything that throws in here would otherwise leave a charged fork budget,
		// no packet, and a manager waiting on a comparison_ready that can never arrive. The
		// outcome row is the only place that failure becomes visible to the next packet.
		recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, failed: String(err?.message ?? err), branchesDone: new Set(rows.map((r) => r.label)).size });
		throw err;
	} finally {
		markBatchDone(dir, spec.compareId, status);
	}
}

/**
 * The batch child's clearance: a marker file in its own directory, NOT a write to task.json.
 *
 * task.json has exactly one writer, the executor. This child runs in a separate process for tens
 * of minutes, and if it did a read-modify-write of its own, the two would bump `stateVersion`
 * from the same base — two different task states carrying one version, which is precisely what
 * §3's staleness check trusts to be impossible, and either write could revert the other's spend.
 * The executor folds this marker out of `current.activeBranches` on the next save it makes
 * anyway (lib/manage/instructions.mjs, settledBatches).
 */
function markBatchDone(dir, batchId, status) {
	try {
		fs.writeFileSync(path.join(dir, "done.json"), JSON.stringify({ batchId, status, ts: Date.now() }, null, 2));
	} catch (err) {
		// Never the reason a batch's own failure is lost: the outcome row is already down, and a
		// batch with no marker ages out of activeBranches on staleBatchMs instead.
		console.error(`[batch ${batchId}] could not write the clearance marker: ${err?.message ?? err}`);
	}
}

async function cmdRunBatch(argv) {
	const { positionals } = splitArgs(argv);
	const [taskDir, specFile] = positionals;
	if (!taskDir || !specFile) return usageExit();
	const out = await runBatchSpec({ taskDir, specFile });
	// Abandoned is not an exception — the rows and the outcome row are written — but it is not a
	// finished comparison either, and the exit code is what the batch log's reader sees first.
	if (out?.abandoned) process.exit(2);
}

/**
 * The read-out of a finished batch: candidate findings, then the `comparison_ready` packet the
 * manager answers next. Separate from the batch itself so a comparison run by hand ends the same
 * way, and so a batch whose child died after its last branch can be closed without re-running it.
 *
 * Runs once per batch: `ready.json` records that it did. A second call would either duplicate a
 * finding or settle one twice against the same evidence, and `writePacket` creates exclusively,
 * so it would otherwise fail on a raw EEXIST after the findings were already written.
 */
export function compareReady({ taskDir, batchDir }) {
	const readyFile = path.join(batchDir, "ready.json");
	if (fs.existsSync(readyFile)) {
		const prior = JSON.parse(fs.readFileSync(readyFile, "utf8"));
		throw new Error(`compare-ready already ran for this batch (packet ${prior.packetId ?? "none"}, findings ${(prior.findings ?? []).join(", ") || "none"})`);
	}
	const spec = JSON.parse(fs.readFileSync(path.join(batchDir, "spec.json"), "utf8"));
	const rows = readJsonl(path.join(batchDir, "rows.jsonl"));
	const evidence = Object.fromEntries(spec.branches.map((b) => [b.label, relRoot(path.join(batchDir, `report-${b.label}.md`))]));
	const table = compareTable(spec.branches, rows);

	// The gate between a crashed batch and a harness rule. A finding is a claim about a
	// difference between branches; a branch that was charged three replicates and finished one
	// supports no claim, and its numbers would still settle a candidate of the same shape either
	// way — `verified` from a batch that never ran. The table and the packet still go out: the
	// manager is owed the read-out, and it is the manager's to decide whether to spend the
	// budget again. Nothing is written to findings.jsonl at all in this case, so a later,
	// complete comparison of the same shape lands as the candidate it should be.
	const short = incompleteBranches(spec.branches, rows, spec.replicates);
	const candidates = short.length ? [] : findingsFromCompare({
		compareId: spec.compareId, branches: spec.branches, rows,
		recordedTool: spec.recordedTool ?? null, checkpoint: spec.checkpoint ?? null, evidence, scope: spec.scope ?? "harness:fork",
	});
	if (short.length) console.error(`[compare ${spec.compareId}] no finding: ${short.map((b) => `${b.label} ran ${b.rows}/${b.replicates}, ${b.crashed} crashed`).join(", ")}`);

	const written = [];
	for (const finding of candidates) {
		// Re-read every time: two branches of one batch can share a shape (same forced action,
		// different message), and the second must then settle the first rather than sit beside it.
		const what = settleOrAppend(readFindings(taskDir), finding);
		if (what.action === "append") {
			appendFinding(taskDir, finding);
			written.push(`${finding.id} candidate`);
		} else if (what.action === "settle") {
			settleFinding(taskDir, what.id, { status: what.status, verifiedOn: what.verifiedOn });
			written.push(`${what.id} ${what.status}`);
		} else {
			written.push(`${finding.id} skipped (${what.reason})`);
		}
	}
	for (const w of written) console.log(`[compare ${spec.compareId}] finding ${w}`);

	// The packet is assembled over a run the batch produced — the manager is being shown a
	// finished comparison, and §2's packet is always a packet ABOUT a run. The last replicate
	// that wrote a summary is the one still on disk in full.
	const withSummary = [...rows].reverse().find((r) => r.runId && fs.existsSync(path.join(spec.runsDir, r.runId, "summary.json")));
	if (!withSummary) {
		// Whatever this batch produced is already on disk — but no packet means nothing will ask
		// the manager about the comparison it paid for, and that silence is the failure to
		// report. Recorded as run, so a retry cannot double-write the findings.
		fs.writeFileSync(readyFile, JSON.stringify({ compareId: spec.compareId, packetId: null, findings: candidates.map((f) => f.id), short, reason: "no replicate wrote a summary.json — no run to assemble a packet over", ts: Date.now() }, null, 2));
		throw new Error(`compare ${spec.compareId}: every replicate crashed before writing a summary; ${candidates.length ? `${candidates.length} finding(s) written` : "no finding written"}, no comparison_ready packet assembled`);
	}
	const packet = assemblePacket({
		taskDir, runDir: path.join(spec.runsDir, withSummary.runId),
		trigger: { kind: "comparison_ready", runId: withSummary.runId, detail: { compareId: spec.compareId, table } },
	});
	const packetFile = writePacket(taskDir, packet);
	fs.writeFileSync(readyFile, JSON.stringify({ compareId: spec.compareId, packetId: packet.packetId, findings: candidates.map((f) => f.id), short, ts: Date.now() }, null, 2));
	console.log(`[compare ${spec.compareId}] ${packetFile}`);
	return { packetId: packet.packetId, packetFile, table, findings: candidates, short: short.length ? short : null };
}

function cmdCompareReady(argv) {
	const { positionals } = splitArgs(argv);
	const [taskDir, batchDir] = positionals;
	if (!taskDir || !batchDir) return usageExit();
	try {
		compareReady({ taskDir, batchDir });
	} catch (err) {
		console.error(err.message);
		process.exit(3);
	}
}

/**
 * The manager's key: `ANTHROPIC_API_KEY`, else an `ANTHROPIC_API_KEY=` line in the repo's `.env`.
 * Read here and passed down as an argument — `decide` never reads the environment, which is what
 * makes the whole driver testable without one. Returned, never printed.
 */
export function readApiKey({ env = process.env, root = ROOT } = {}) {
	const fromEnv = String(env.ANTHROPIC_API_KEY ?? "").trim();
	if (fromEnv) return unquote(fromEnv);
	// `ARBITER_DOTENV` names the file instead of the repo's own: a seam for tests, and for an
	// operator whose key lives somewhere other than beside the code.
	const file = env.ARBITER_DOTENV ? String(env.ARBITER_DOTENV) : path.join(root, ".env");
	if (fs.existsSync(file)) {
		const m = fs.readFileSync(file, "utf8").match(/^ANTHROPIC_API_KEY=(\S+)/m);
		if (m) return unquote(m[1]);
	}
	return null;
}

/** `KEY="sk-…"` in a .env file is a key with two quotes attached, and what it produces is a 401
 * that arrives as a defaulted packet rather than as the operator error it is. Only matching
 * quotes are stripped — a key that genuinely starts with one is not silently rewritten. */
const unquote = (s) => (/^"(.*)"$/.test(s) || /^'(.*)'$/.test(s) ? s.slice(1, -1) : s);

/** Exit 2 with a clear message rather than a 401 from the API — a missing key is an operator's
 * mistake, and the run on the other side would otherwise be told the manager failed. */
function requireApiKey() {
	const key = readApiKey();
	if (!key) {
		console.error("no ANTHROPIC_API_KEY in the environment or in .env — the manager cannot be called");
		process.exit(2);
	}
	return key;
}

/**
 * The model, refused here as well as in `decide`.
 *
 * Every packet forces the `instruct` tool call, and forced `tool_choice` is a hard 400 on the
 * fable and mythos families — so a loop pointed at one of them runs to completion writing
 * nothing but defaulted zero-grant continues. `decide` refuses it too (a library caller gets the
 * default with the reason on `manager.error`); at a terminal it is an operator's typo, and the
 * honest answer is to stop before spending a run.
 */
function requireSupportedModel(flags) {
	const model = flags.model ?? DEFAULT_MANAGER_MODEL;
	if (UNSUPPORTED_MODEL.test(String(model))) {
		console.error(unsupportedModelReason(model));
		process.exit(2);
	}
	return model;
}

/** `--timeout <ms>`, the driver's budget for one decision. Left alone it is 0.75 of the
 * supervisor's deadline (lib/manage/manager.mjs), which is what keeps an answer from arriving at
 * a pause that has already closed. */
function timeoutFlag(flags) {
	const raw = Number(flags.timeout ?? "");
	if (flags.timeout != null && !(raw > 0)) {
		console.error(`--timeout must be a positive number of milliseconds (got ${JSON.stringify(flags.timeout)})`);
		process.exit(2);
	}
	return raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * `decide <taskDir> <packetId>` — one packet, one instruction, printed. With `--execute` the
 * instruction goes through the same executor everything else uses, so the checks, the ledger row
 * and the refusal codes are identical to a hand-written instruction's.
 */
async function cmdDecide(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir, packetArg] = positionals;
	if (!taskDir || !packetArg) return usageExit();
	const packetFile = /^\d+$/.test(packetArg) ? path.join(taskDir, "packets", `${packetArg}.json`) : packetArg;
	if (!fs.existsSync(packetFile)) {
		console.error(`no packet at ${packetFile}`);
		process.exit(2);
	}
	const model = requireSupportedModel(flags);
	const timeoutMs = timeoutFlag(flags);
	const packet = JSON.parse(fs.readFileSync(packetFile, "utf8"));
	const decision = await decide({ packet, model, timeoutMs, apiKey: requireApiKey() });
	const { manager, ...instr } = decision;
	console.log(JSON.stringify({ ...instr, manager }, null, 2));
	if (!("execute" in flags)) return;
	const runsDir = flags.runs ?? path.join(here, "..", "runs");
	reportResult(executeInstruction({ taskDir, instr, packet, runsDir, manager }));
}

/** `replay <taskDir> --model m` — §7's offline evaluation of a candidate manager against the
 * packets and instructions this task already recorded. Reads the task directory and writes only
 * under `replays/`; nothing else moves. */
async function cmdReplay(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir] = positionals;
	if (!taskDir) return usageExit();
	const model = requireSupportedModel(flags);
	const timeoutMs = timeoutFlag(flags);
	const packetIds = flags.packets ? String(flags.packets).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : null;
	await replay({ taskDir, packetIds, model, timeoutMs, apiKey: requireApiKey() });
}

/**
 * `serve <taskDir>` — the loop the first live manager runs in: watch this task's live runs for
 * `manage:trigger`, and for each one assemble a packet, decide and execute.
 *
 * `--run <runId>` adopts a run explicitly — a belt-and-braces handle for a run whose trigger
 * events and config both fail to name this task (see runsForTask, which admits by either).
 */
async function cmdServe(argv) {
	const { flags, positionals } = splitArgs(argv);
	const [taskDir] = positionals;
	if (!taskDir) return usageExit();
	const runsDir = flags.runs ?? path.join(here, "..", "runs");
	const model = requireSupportedModel(flags);
	const timeoutMs = timeoutFlag(flags);
	// The loop's own `finally` covers a return and a throw; this covers the way an operator
	// actually stops one. `exit` handlers do not run on a signal, so both signals are caught and
	// re-exited, and `releaseServeLock` deletes the file only when it names THIS process — so the
	// locked path below, which never took the lock, cannot delete the live owner's.
	const release = () => releaseServeLock(taskDir);
	process.on("exit", release);
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			release();
			process.exit(130);
		});
	}
	const out = await serve({
		taskDir, runsDir, model, timeoutMs,
		apiKey: requireApiKey(),
		once: "once" in flags,
		adopt: flags.run ? [flags.run] : [],
	});
	// A loop that answered nothing because another one holds the lock is not a successful run of
	// this command, and an operator who started a second one by mistake must be told at the exit
	// code, not only in a log line.
	if (out?.refused === "locked") process.exit(3);
}

function cmdLedger(argv) {
	const { positionals } = splitArgs(argv);
	const [taskDir] = positionals;
	if (!taskDir) return usageExit();
	for (const row of readLedger(taskDir)) console.log(JSON.stringify(row));
	for (const f of readFindings(taskDir)) console.log(JSON.stringify(f));
}

export function main(argv = process.argv.slice(2)) {
	const [cmd, ...rest] = argv;
	if (cmd === "init") return cmdInit(rest);
	if (cmd === "packet") return cmdPacket(rest);
	if (cmd === "execute") return cmdExecute(rest);
	if (cmd === "accept") return cmdAccept(rest);
	if (cmd === "checkpoint") return cmdCheckpoint(rest);
	if (cmd === "review") return cmdReview(rest);
	if (cmd === "run-batch") return cmdRunBatch(rest);
	if (cmd === "compare-ready") return cmdCompareReady(rest);
	if (cmd === "ledger") return cmdLedger(rest);
	if (cmd === "decide") return cmdDecide(rest);
	if (cmd === "replay") return cmdReplay(rest);
	if (cmd === "serve") return cmdServe(rest);
	return usageExit();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// `run-batch`, `decide`, `replay` and `serve` are the async commands, and `run-batch` is run
	// detached with nothing watching: an unhandled rejection there would be a stack trace into a
	// log file nobody reads. Said on stderr with a non-zero exit instead, so the batch log's last
	// line names the failure.
	Promise.resolve(main()).catch((err) => {
		console.error(`[manage] ${err?.stack ?? err}`);
		process.exit(1);
	});
}
