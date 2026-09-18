// tools/manage.mjs — CLI over lib/manage/*: create a task, assemble+write an observation
// packet from an existing run's records, execute one manager instruction, and print the
// ledger. No network. `execute` is the only command with an effect outside the task
// directory, and even that reaches a live run through one appended file
// (runs/<id>/control.jsonl) which the supervisor tails — this process never touches an
// agent, a workspace or the oracle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
import { assemblePacket, writePacket } from "../lib/manage/packet.mjs";
import { readLedger, readFindings, appendFinding, settleFinding, recordOutcome } from "../lib/manage/ledger.mjs";
import { executeInstruction } from "../lib/manage/instructions.mjs";
import { compareTable, findingsFromCompare, settleOrAppend } from "../lib/manage/compare.mjs";
import { runBatch } from "./fork.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");

const USAGE = `usage:
  node tools/manage.mjs init <taskDir> --task <id> --goal "<text>" --criteria <json> --milestones <json> [--budget <json>]
  node tools/manage.mjs packet <taskDir> <runId> --trigger <kind> [--detail <json>] [--runs <dir>]
  node tools/manage.mjs execute <taskDir> <instruction.json> [--packet <n|file>] [--runs <dir>]
  node tools/manage.mjs run-batch <taskDir> <compares/<n>/spec.json>
  node tools/manage.mjs compare-ready <taskDir> <compares/<n>>
  node tools/manage.mjs ledger <taskDir>`;

/** Splits argv into --flag value pairs and the remaining positionals, in order. */
export function splitArgs(argv) {
	const flags = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			flags[a.slice(2)] = argv[i + 1];
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
	const result = executeInstruction({ taskDir, instr, packet, runsDir });
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
 * outcome row and added to `current.activeRuns` so the next `continue` can name it.
 */
export async function runBatchSpec({ taskDir, specFile, runner = runBatch }) {
	const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
	const dir = path.dirname(path.resolve(specFile));
	const rows = [];
	try {
		for (const b of spec.branches) {
			console.log(`[batch ${spec.compareId}] branch ${b.label} (${b.forkBranch}${b.firstAction ? ` ${b.firstAction}` : ""}) × ${spec.replicates}`);
			const out = await runner({
				runId: spec.runId, call: spec.call, branch: b.forkBranch, action: b.firstAction ?? null,
				replicates: spec.replicates, config: spec.config, control: b.controlFile ?? null, runsDir: spec.runsDir,
			});
			fs.writeFileSync(path.join(dir, `report-${b.label}.md`), out.report);
			for (const row of out.rows) rows.push({ ...row, label: b.label });
			// Written after every branch, not once at the end: a batch that dies on its third
			// branch must still leave the two that finished readable.
			fs.writeFileSync(path.join(dir, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
		}

		if (spec.kind === "restore") {
			const runId = rows.find((r) => r.runId)?.runId ?? null;
			recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, runId, crashed: rows.every((r) => r.crashed) });
			if (runId) {
				// Loaded here, not at the start: a batch is tens of minutes long and the task has
				// almost certainly moved since the instruction that launched this was executed.
				const task = loadTask(taskDir);
				saveTask(taskDir, setCurrent(task, { activeRuns: [...new Set([...(task.current.activeRuns ?? []), runId])] }));
			}
			console.log(`[batch ${spec.compareId}] restore → ${runId ?? "no run"}`);
			return { rows, runId };
		}
		const out = compareReady({ taskDir, batchDir: dir });
		// §5's outcome slot, for the success case too: the packet says a comparison happened, but
		// the ledger is what the next manager reads about the instruction it answered.
		recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, packetId: out.packetId, findings: out.findings.map((f) => f.id), runs: rows.map((r) => r.runId).filter(Boolean) });
		return { rows, ...out };
	} catch (err) {
		// The ledger's last word on this instruction must not be "launched". Nothing is watching
		// this child: anything that throws in here would otherwise leave a charged fork budget,
		// no packet, and a manager waiting on a comparison_ready that can never arrive. The
		// outcome row is the only place that failure becomes visible to the next packet.
		recordOutcome(taskDir, spec.idempotencyKey, { batchId: spec.compareId, failed: String(err?.message ?? err), branchesDone: new Set(rows.map((r) => r.label)).size });
		throw err;
	}
}

async function cmdRunBatch(argv) {
	const { positionals } = splitArgs(argv);
	const [taskDir, specFile] = positionals;
	if (!taskDir || !specFile) return usageExit();
	await runBatchSpec({ taskDir, specFile });
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
	const candidates = findingsFromCompare({
		compareId: spec.compareId, branches: spec.branches, rows,
		recordedTool: spec.recordedTool ?? null, checkpoint: spec.checkpoint ?? null, evidence, scope: spec.scope ?? "harness:fork",
	});

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
		// Findings are already written, so this must not look like nothing happened — but no
		// packet means nothing will ask the manager about this comparison, and that silence is
		// the failure to report. Recorded as run, so a retry cannot double-write the findings.
		fs.writeFileSync(readyFile, JSON.stringify({ compareId: spec.compareId, packetId: null, findings: candidates.map((f) => f.id), reason: "no replicate wrote a summary.json — no run to assemble a packet over", ts: Date.now() }, null, 2));
		throw new Error(`compare ${spec.compareId}: every replicate crashed before writing a summary; findings written, no comparison_ready packet assembled`);
	}
	const packet = assemblePacket({
		taskDir, runDir: path.join(spec.runsDir, withSummary.runId),
		trigger: { kind: "comparison_ready", runId: withSummary.runId, detail: { compareId: spec.compareId, table } },
	});
	const packetFile = writePacket(taskDir, packet);
	fs.writeFileSync(readyFile, JSON.stringify({ compareId: spec.compareId, packetId: packet.packetId, findings: candidates.map((f) => f.id), ts: Date.now() }, null, 2));
	console.log(`[compare ${spec.compareId}] ${packetFile}`);
	return { packetId: packet.packetId, packetFile, table, findings: candidates };
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
	if (cmd === "run-batch") return cmdRunBatch(rest);
	if (cmd === "compare-ready") return cmdCompareReady(rest);
	if (cmd === "ledger") return cmdLedger(rest);
	return usageExit();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// `run-batch` is the one async command, and it is run detached with nothing watching: an
	// unhandled rejection there would be a stack trace into a log file nobody reads. Said on
	// stderr with a non-zero exit instead, so the batch log's last line names the failure.
	Promise.resolve(main()).catch((err) => {
		console.error(`[manage] ${err?.stack ?? err}`);
		process.exit(1);
	});
}
