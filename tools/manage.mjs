// tools/manage.mjs — CLI over lib/manage/*: create a task, assemble+write an observation
// packet from an existing run's records, execute one manager instruction, and print the
// ledger. No network. `execute` is the only command with an effect outside the task
// directory, and even that reaches a live run through one appended file
// (runs/<id>/control.jsonl) which the supervisor tails — this process never touches an
// agent, a workspace or the oracle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTask } from "../lib/manage/task-state.mjs";
import { assemblePacket, writePacket } from "../lib/manage/packet.mjs";
import { readLedger, readFindings } from "../lib/manage/ledger.mjs";
import { executeInstruction } from "../lib/manage/instructions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `usage:
  node tools/manage.mjs init <taskDir> --task <id> --goal "<text>" --criteria <json> --milestones <json> [--budget <json>]
  node tools/manage.mjs packet <taskDir> <runId> --trigger <kind> [--detail <json>] [--runs <dir>]
  node tools/manage.mjs execute <taskDir> <instruction.json> [--packet <n|file>] [--runs <dir>]
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
	if (cmd === "ledger") return cmdLedger(rest);
	return usageExit();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
