// Run configuration: a JSON file (arbiter.json by default) names the task, the
// pattern, and each role's provider/model; env vars override individual fields
// without editing the file. This replaces the old env-var-only configuration —
// the file is the source of truth, env is for one-off overrides (a different
// model on a single run, a different task, a tighter cap).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS } from "./patterns.mjs";
import { defaultModelStorePaths, loadModelStore, preflightRoles } from "./model-store.mjs";
import { loadRoster, selectSpecialists } from "./roster.mjs";

const norm = (p) => p.replace(/\\/g, "/");

const here = path.dirname(fileURLToPath(import.meta.url));
// compactAtTokens 0 = no supervisor-driven compaction; otherwise the orchestrator is
// compacted at a phase boundary once its context reaches that many tokens, at most
// maxCompactions times, never within minGapTurns of the last one, after waiting up to
// checkpointWaitSec for the orchestrator's checkpoint.
// tokens 0 = no token cap; otherwise fresh input + output across every agent ends the
// run the way usd does (tools/campaign.mjs passes a campaign's remainder here).
const CAP_DEFAULTS = { toolCalls: 200, wallSec: 1500, usd: 5, doneAttempts: 5, idleNudgeSec: 120, maxNudges: 3, bashTimeoutSec: 90, tokens: 0, compactAtTokens: 0, maxCompactions: 3, minGapTurns: 5, checkpointWaitSec: 120 };
const CAP_ENV = { toolCalls: "ARBITER_CAP_TOOLS", wallSec: "ARBITER_CAP_WALL", usd: "ARBITER_CAP_USD", doneAttempts: "ARBITER_CAP_DONE", idleNudgeSec: "ARBITER_IDLE_NUDGE", bashTimeoutSec: "ARBITER_BASH_TIMEOUT_SEC", tokens: "ARBITER_CAP_TOKENS" };
export { THINKING_LEVELS, WORKER_THINKING_LEVELS } from "./thinking-levels.mjs";
import { THINKING_LEVELS, WORKER_THINKING_LEVELS } from "./thinking-levels.mjs";

export function parseArgs(argv) {
	const i = argv.indexOf("--config");
	return { configPath: i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(here, "..", "arbiter.json") };
}

export function loadConfig({ configPath, env = process.env, rosterDir = path.join(here, "..", "roster") }) {
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const task = env.ARBITER_TASK || raw.task;
	const pattern = env.ARBITER_PATTERN || raw.pattern;
	const def = PATTERNS[pattern];
	if (!def) throw new Error(`unknown pattern "${pattern}" in ${configPath} (known: ${Object.keys(PATTERNS).join(", ")})`);
	const roles = {};
	// workersRaw is non-null only for the orchestrator pattern (the only pattern with a
	// "worker" role): either the config's own `workers` block, or a `roles.worker` legacy
	// config mapped onto the same shape, so downstream code has one path.
	let workersRaw = null;
	for (const name of def.roles) {
		if (name === "worker") {
			const r = raw.roles?.worker;
			if (raw.workers && r) throw new Error(`roles.worker and workers cannot both be set in ${configPath}`);
			workersRaw = raw.workers ?? (r
				? {
					default: { provider: r.provider, model: r.model, ...(r.thinking != null ? { thinking: r.thinking } : {}) },
					use: ["worker"],
					overrides: { worker: { ...(r.background != null ? { background: Boolean(r.background) } : {}) } },
					max: r.max ?? 1,
				}
				: null);
			if (!workersRaw) throw new Error(`pattern "${pattern}" requires role "worker" or a workers block (missing in ${configPath})`);
			const wd = workersRaw.default ?? {};
			const provider = env.ROLE_worker_PROVIDER || wd.provider;
			const model = env.ROLE_worker_MODEL || wd.model;
			if (!provider || !model) throw new Error(`pattern "${pattern}" requires role "worker" or a workers block (missing in ${configPath})`);
			roles.worker = { provider, model };
			const thinking = env.ROLE_worker_THINKING || wd.thinking;
			if (thinking != null) {
				if (!WORKER_THINKING_LEVELS.includes(thinking)) throw new Error(`roles.worker.thinking must be one of ${WORKER_THINKING_LEVELS.join(", ")} in ${configPath}, got ${JSON.stringify(thinking)}`);
				roles.worker.thinking = thinking;
			}
			roles.worker.max = Number(workersRaw.max ?? 1);
			roles.worker.background = Boolean(workersRaw.overrides?.worker?.background ?? false);
			continue;
		}
		const r = raw.roles?.[name];
		const provider = env[`ROLE_${name}_PROVIDER`] || r?.provider;
		const model = env[`ROLE_${name}_MODEL`] || r?.model;
		if (!provider || !model) throw new Error(`pattern "${pattern}" requires role "${name}" (missing in ${configPath})`);
		roles[name] = { provider, model };
		const thinking = env[`ROLE_${name}_THINKING`] || r?.thinking;
		if (thinking != null) {
			if (!THINKING_LEVELS.includes(thinking)) throw new Error(`roles.${name}.thinking must be one of ${THINKING_LEVELS.join(", ")} in ${configPath}, got ${JSON.stringify(thinking)}`);
			roles[name].thinking = thinking;
		}
	}
	// `workers`: the orchestrator pattern's roster selection (null for other patterns).
	// `roles.worker` above already carries the resolved default provider/model/thinking/
	// max/background so the supervisor keeps working unchanged until it switches to this
	// block directly. Built before preflight so overrides can contribute pseudo-roles to it.
	let workers = null;
	const pseudoRoles = {};
	if (pattern === "orchestrator") {
		const roster = loadRoster(rosterDir);
		const use = Array.isArray(workersRaw.use) && workersRaw.use.length ? workersRaw.use.map(String) : ["worker"];
		const specialists = selectSpecialists(roster, use);
		const overrides = {};
		for (const [n, o] of Object.entries(workersRaw.overrides ?? {})) {
			if (!use.includes(n)) throw new Error(`workers.overrides.${n} is not in workers.use in ${configPath}`);
			overrides[n] = {};
			if (o.provider) overrides[n].provider = String(o.provider);
			if (o.model) overrides[n].model = String(o.model);
			if (o.thinking != null) {
				if (!WORKER_THINKING_LEVELS.includes(o.thinking)) throw new Error(`workers.overrides.${n}.thinking must be one of ${WORKER_THINKING_LEVELS.join(", ")}`);
				overrides[n].thinking = o.thinking;
			}
			if (o.background != null) overrides[n].background = Boolean(o.background);
		}
		workers = { default: { ...roles.worker }, use, overrides, max: roles.worker.max, specialists, legacy: !raw.workers };
		delete workers.default.max;
		delete workers.default.background;
		delete workers.default.contextWindow;
		for (const [n, o] of Object.entries(overrides)) {
			if (o.provider || o.model) pseudoRoles[`workers.${n}`] = { provider: o.provider ?? workers.default.provider, model: o.model ?? workers.default.model };
		}
	}
	// Model preflight: fail before any pi process spawns when a role names a model pi
	// doesn't have, instead of only after the child boots (a model_error audit line on
	// the first turn). Also records each role's contextWindow from the store, for a
	// later context-usage tool (ARBITER_CONTEXT_WINDOW). Set ARBITER_SKIP_MODEL_PREFLIGHT
	// (truthy-checked, so any non-empty value works) to bypass this check entirely.
	// Overrides that set a provider/model are checked too, as pseudo-roles keyed
	// "workers.<name>" merged in for this check only — never persisted with a contextWindow.
	const modelStorePaths = defaultModelStorePaths(env);
	const looked = [modelStorePaths.store, modelStorePaths.overrides].map(norm);
	const preflightInput = { ...roles, ...pseudoRoles };
	let preflight;
	if (env.ARBITER_SKIP_MODEL_PREFLIGHT) {
		for (const role of Object.values(preflightInput)) role.contextWindow = null;
		preflight = { skipped: "ARBITER_SKIP_MODEL_PREFLIGHT", looked };
	} else {
		const store = loadModelStore({ storePath: modelStorePaths.store, overridesPath: modelStorePaths.overrides });
		if (store.source.length === 0) {
			for (const role of Object.values(preflightInput)) role.contextWindow = null;
			preflight = { skipped: "no model store found", looked };
		} else {
			const { missing } = preflightRoles(preflightInput, store);
			if (missing.length > 0) throw new Error(`model preflight: ${missing.join("\n")} (from ${store.source.join(", ")}) Set ARBITER_SKIP_MODEL_PREFLIGHT=1 to bypass this check.`);
			preflight = { checked: Object.keys(preflightInput).length, source: store.source };
		}
	}
	const caps = { ...CAP_DEFAULTS, ...(raw.caps ?? {}) };
	for (const [key, envName] of Object.entries(CAP_ENV)) if (env[envName]) caps[key] = Number(env[envName]);
	const oracle = { reportFailingInputs: Boolean(raw.oracle?.reportFailingInputs ?? false) };
	// Opt-in guards: `true` means the guard's defaults, an object is passed to it as
	// options, false/absent means the guard registers nothing. Always-on guards (path,
	// bash-timeout) are not configured here — see GUARDS in supervisor.mjs.
	const guards = { result_handles: null, call_args: null, pre_spawn_compact: null, topology: null };
	for (const [name, value] of Object.entries(raw.guards ?? {})) {
		if (!(name in guards)) throw new Error(`unknown guard "${name}" in ${configPath} (known: ${Object.keys(guards).join(", ")})`);
		if (value === true) guards[name] = {};
		else if (value === false || value == null) guards[name] = null;
		else if (typeof value === "object" && !Array.isArray(value)) guards[name] = value;
		// topology takes a bare mode string as shorthand for { mode }.
		else if (name === "topology" && typeof value === "string") guards[name] = { mode: value };
		else throw new Error(`guards.${name} must be true, false or an options object in ${configPath}`);
	}
	if (guards.topology) {
		const mode = guards.topology.mode ?? "nudge";
		if (mode !== "nudge" && mode !== "enforce") throw new Error(`guards.topology mode must be "nudge" or "enforce" in ${configPath}, got ${JSON.stringify(mode)}`);
		guards.topology = { mode };
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
		if (!Array.isArray(extra) || !extra.every((x) => x === "global" || /^(task|repo|agent):[\w.-]+$/.test(String(x)))) throw new Error(`memory.extraScopes must be a list of scopes (global, task:<name>, repo:<name>, agent:<name>) in ${configPath}`);
		if (extra.length) memory.extraScopes = extra.map(String);
		// readTask: a control knob. The run reads task:<readTask> instead of its own
		// task scope (seed, memory_search, memory_get); retention still writes to the
		// run's own task. A run that does as well with another task's memory as with
		// its own is not gaining from task memory (the shuffled-context control).
		if (rawMemory.readTask != null) {
			if (typeof rawMemory.readTask !== "string" || !/^[\w.-]+$/.test(rawMemory.readTask)) throw new Error(`memory.readTask must be a task name in ${configPath}`);
			if (rawMemory.readTask === raw.task) throw new Error(`memory.readTask names the run's own task (${raw.task}); leave it out in ${configPath}`);
			memory.readTask = rawMemory.readTask;
		}
	} else if (rawMemory != null && rawMemory !== false) throw new Error(`memory must be true, false or { budgetChars, mode?, retrievalChars?, workerReserveChars? } in ${configPath}`);
	// Optional: another directory holding memory/records.jsonl (the benchmark's fixture
	// store), relative to the arbiter checkout, so a run never touches the real ledger.
	const memoryDir = raw.memoryDir == null ? null : String(raw.memoryDir);
	// Optional: the external repository this run works on. Memory retained from the run
	// goes to scope `repo:<name>` and recall includes it — "the agent for that repo" is
	// a prompt plus this scope, nothing more.
	const repo = raw.repo == null ? null : String(raw.repo);
	if (repo !== null && !/^[\w.-]+$/.test(repo)) throw new Error(`repo must match [\\w.-]+ in ${configPath}, got ${JSON.stringify(raw.repo)}`);
	// Worker reports (ext/report-ext.ts). Off by default so paired runs stay comparable.
	// `true`: workers get the `report` tool and the approval gate refuses `done` while a
	// completed worker has no report. `{ autoProbe: true }`: additionally, each report's
	// verify cases are run as a supervisor probe the moment the report lands.
	let report = null;
	if (raw.report === true) report = { autoProbe: false };
	else if (raw.report && typeof raw.report === "object" && !Array.isArray(raw.report)) report = { autoProbe: Boolean(raw.report.autoProbe ?? false) };
	else if (raw.report != null && raw.report !== false) throw new Error(`report must be true, false or { autoProbe } in ${configPath}`);
	if (!task) throw new Error(`no task in ${configPath}`);
	return { task, pattern, roles, workers, caps, oracle, guards, memory, memoryDir, repo, report, configPath, preflight };
}
