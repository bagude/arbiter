// Run configuration: a JSON file (arbiter.json by default) names the task, the
// pattern, and each role's provider/model; env vars override individual fields
// without editing the file. This replaces the old env-var-only configuration —
// the file is the source of truth, env is for one-off overrides (a different
// model on a single run, a different task, a tighter cap).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS } from "./patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// compactAtTokens 0 = no supervisor-driven compaction; otherwise the orchestrator is
// compacted at a phase boundary once its context reaches that many tokens, at most
// maxCompactions times, never within minGapTurns of the last one, after waiting up to
// checkpointWaitSec for the orchestrator's checkpoint.
const CAP_DEFAULTS = { toolCalls: 200, wallSec: 1500, usd: 5, doneAttempts: 5, idleNudgeSec: 120, maxNudges: 3, bashTimeoutSec: 90, compactAtTokens: 0, maxCompactions: 3, minGapTurns: 5, checkpointWaitSec: 120 };
const CAP_ENV = { toolCalls: "ARBITER_CAP_TOOLS", wallSec: "ARBITER_CAP_WALL", usd: "ARBITER_CAP_USD", doneAttempts: "ARBITER_CAP_DONE", idleNudgeSec: "ARBITER_IDLE_NUDGE", bashTimeoutSec: "ARBITER_BASH_TIMEOUT_SEC" };
// pi's thinking levels (cli/args.js VALID_THINKING_LEVELS). pi-subagents reads the same
// list minus "max" from a worker definition's `thinking:` line (src/config/thinking-level.ts)
// and silently drops an unknown value — so the worker's is checked here, loudly.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WORKER_THINKING_LEVELS = THINKING_LEVELS.filter((l) => l !== "max");

export function parseArgs(argv) {
	const i = argv.indexOf("--config");
	return { configPath: i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(here, "..", "arbiter.json") };
}

export function loadConfig({ configPath, env = process.env }) {
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const task = env.ARBITER_TASK || raw.task;
	const pattern = env.ARBITER_PATTERN || raw.pattern;
	const def = PATTERNS[pattern];
	if (!def) throw new Error(`unknown pattern "${pattern}" in ${configPath} (known: ${Object.keys(PATTERNS).join(", ")})`);
	const roles = {};
	for (const name of def.roles) {
		const r = raw.roles?.[name];
		const provider = env[`ROLE_${name}_PROVIDER`] || r?.provider;
		const model = env[`ROLE_${name}_MODEL`] || r?.model;
		if (!provider || !model) throw new Error(`pattern "${pattern}" requires role "${name}" (missing in ${configPath})`);
		roles[name] = { provider, model };
		const thinking = env[`ROLE_${name}_THINKING`] || r?.thinking;
		if (thinking != null) {
			const allowed = name === "worker" ? WORKER_THINKING_LEVELS : THINKING_LEVELS;
			if (!allowed.includes(thinking)) throw new Error(`roles.${name}.thinking must be one of ${allowed.join(", ")} in ${configPath}, got ${JSON.stringify(thinking)}`);
			roles[name].thinking = thinking;
		}
		if (name === "worker") {
			roles[name].max = Number(r?.max ?? 1);
			roles[name].background = Boolean(r?.background ?? false);
		}
	}
	const caps = { ...CAP_DEFAULTS, ...(raw.caps ?? {}) };
	for (const [key, envName] of Object.entries(CAP_ENV)) if (env[envName]) caps[key] = Number(env[envName]);
	const oracle = { reportFailingInputs: Boolean(raw.oracle?.reportFailingInputs ?? false) };
	// Opt-in guards: `true` means the guard's defaults, an object is passed to it as
	// options, false/absent means the guard registers nothing. Always-on guards (path,
	// bash-timeout) are not configured here — see GUARDS in supervisor.mjs.
	const guards = { context_diet: null, result_handles: null, call_args: null, pre_spawn_compact: null };
	for (const [name, value] of Object.entries(raw.guards ?? {})) {
		if (!(name in guards)) throw new Error(`unknown guard "${name}" in ${configPath} (known: ${Object.keys(guards).join(", ")})`);
		if (value === true) guards[name] = {};
		else if (value === false || value == null) guards[name] = null;
		else if (typeof value === "object" && !Array.isArray(value)) guards[name] = value;
		else throw new Error(`guards.${name} must be true, false or an options object in ${configPath}`);
	}
	// Memory recall is opt-in so paired runs stay comparable: `true` injects promoted
	// records within the default budget, an object sets the budget, false/absent
	// injects nothing. Retention at finish happens regardless — the harness learns
	// from every run; only what an agent is told is the variable.
	let memory = null;
	const rawMemory = raw.memory;
	// mode "inject" (default) appends a wiki slice within budgetChars; mode "search"
	// seeds a small brief within budgetChars and gives agents memory_search/memory_get
	// under a per-run retrievalChars budget.
	if (rawMemory === true) memory = { budgetChars: 2000, mode: "inject" };
	else if (rawMemory && typeof rawMemory === "object" && !Array.isArray(rawMemory)) {
		const mode = rawMemory.mode ?? "inject";
		if (mode !== "inject" && mode !== "search") throw new Error(`memory.mode must be "inject" or "search" in ${configPath}, got ${JSON.stringify(rawMemory.mode)}`);
		memory = { budgetChars: Number(rawMemory.budgetChars ?? 2000), mode };
		if (mode === "search") {
			// workerReserveChars: the part of retrievalChars only workers may spend.
			memory.retrievalChars = Number(rawMemory.retrievalChars ?? 6000);
			memory.workerReserveChars = Number(rawMemory.workerReserveChars ?? 2000);
			if (!(memory.workerReserveChars >= 0 && memory.workerReserveChars < memory.retrievalChars)) throw new Error(`memory.workerReserveChars must be at least 0 and below retrievalChars (${memory.retrievalChars}) in ${configPath}`);
		}
		// extraScopes: scopes the run may read (seed, memory_search, memory_get) but never
		// writes to — e.g. a research campaign reading the warehouse's findings.
		const extra = rawMemory.extraScopes ?? [];
		if (!Array.isArray(extra) || !extra.every((x) => x === "global" || /^(task|repo):[\w.-]+$/.test(String(x)))) throw new Error(`memory.extraScopes must be a list of scopes (global, task:<name>, repo:<name>) in ${configPath}`);
		if (extra.length) memory.extraScopes = extra.map(String);
	} else if (rawMemory != null && rawMemory !== false) throw new Error(`memory must be true, false or { budgetChars, mode?, retrievalChars?, workerReserveChars? } in ${configPath}`);
	// Optional: another directory holding memory/records.jsonl (the benchmark's fixture
	// store), relative to the arbiter checkout, so a run never touches the real ledger.
	const memoryDir = raw.memoryDir == null ? null : String(raw.memoryDir);
	// Optional: the external repository this run works on. Memory retained from the run
	// goes to scope `repo:<name>` and recall includes it — "the agent for that repo" is
	// a prompt plus this scope, nothing more.
	const repo = raw.repo == null ? null : String(raw.repo);
	if (repo !== null && !/^[\w.-]+$/.test(repo)) throw new Error(`repo must match [\\w.-]+ in ${configPath}, got ${JSON.stringify(raw.repo)}`);
	if (!task) throw new Error(`no task in ${configPath}`);
	return { task, pattern, roles, caps, oracle, guards, memory, memoryDir, repo, configPath };
}
