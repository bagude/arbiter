import fs from "node:fs";
import path from "node:path";
import { renderDefinition } from "./roster.mjs";

// pi-subagents loads agent definitions from <cwd>/.pi/agents/*.md and its settings
// from <cwd>/.pi/subagents.json (src/config/custom-agents.ts, src/settings.ts). The
// workspace is the orchestrator's cwd, so both live there. Only src/ is ever copied
// to the oracle, so .pi/ never reaches a test.
export function workerDefinition({ provider, model, tools, prompt, maxTurns = 60, background = false, thinking = null }) {
	return [
		"---",
		"name: worker",
		"description: Builds one piece of the task from the orchestrator's brief.",
		`tools: ${tools.join(",")}`,
		`model: ${provider}/${model}`,
		...(thinking ? [`thinking: ${thinking}`] : []),
		`max_turns: ${maxTurns}`,
		`run_in_background: ${background}`,
		"---",
		prompt.trimEnd(),
		"",
	].join("\n");
}

// A worker's resource loader does not inherit the parent's `-e` extension paths,
// but it does resolve project-local <cwd>/.pi/extensions/*.ts (pi-subagents
// create-subagent-session.ts builds a DefaultResourceLoader with project trust on).
// Copying an extension here is how host-side guards reach the workers.
export function installWorkspaceExtension(workspaceDir, srcFile) {
	const dir = path.join(workspaceDir, ".pi", "extensions");
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, path.basename(srcFile));
	fs.copyFileSync(srcFile, dest);
	return dest;
}

export function writeWorkerDefinition(workspaceDir, opts) {
	const dir = path.join(workspaceDir, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "worker.md");
	fs.writeFileSync(file, workerDefinition(opts));
	fs.writeFileSync(path.join(workspaceDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: opts.max ?? 1 }));
	return file;
}

// Appended by resolveWorkerPrompt when the run has worker reports on, so every task's
// own worker.md gets it without edits. The tool's schema is the contract; this only
// says when to call it and what happens if a worker does not.
export const REPORT_INSTRUCTION =
	"Before your final message, call the `report` tool once: status (done, partial or blocked), a short summary, the files you changed, findings each labelled observed (you ran it and saw it), interpreted (your reading of what you saw) or hypothesis (not tested) — an interpreted or hypothesis finding also gives its settlement_criterion, the observation that would settle it — verify cases as [{ id, args, expect? }] that the supervisor can execute against the real code, and open questions. The orchestrator cannot complete the run while a finished worker has no report.";

/**
 * The worker's system prompt: a task may ship its own `worker.md` (a Python data
 * task is not "a small JavaScript project"); otherwise the generic prompts/worker.md.
 * The run's memory excerpt, when there is one, is appended so workers on research
 * tasks know what earlier runs found without the orchestrator having to relay it.
 */
export function resolveWorkerPrompt({ taskDir, home, memoryText = "", report = false }) {
	const own = path.join(taskDir, "worker.md");
	const file = fs.existsSync(own) ? own : path.join(home, "prompts", "worker.md");
	const base = fs.readFileSync(file, "utf8").trimEnd();
	return { prompt: [base, report ? REPORT_INSTRUCTION : "", memoryText].filter(Boolean).join("\n\n"), file };
}

// The part of resolveWorkerPrompt's output that isn't a specialist's own body: the
// report instruction and the run's memory excerpt, appended to every roster
// definition the same way (see writeRosterDefinitions). Kept separate from a
// specialist's body so a roster file's prompt stays the stable, reviewable prefix
// the design calls for — nothing per-run is baked into roster/<name>.md itself.
export function workerPromptSuffix({ memoryText = "", report = false }) {
	return [report ? REPORT_INSTRUCTION : "", memoryText].filter(Boolean).join("\n\n");
}

/**
 * Installs one pi-subagents definition per selected specialist into
 * <workspaceDir>/.pi/agents/<name>.md, plus <workspaceDir>/.pi/subagents.json
 * (maxConcurrent). Provider/model/thinking/background come from the run's
 * `workers` config (per-name overrides over `workers.default`), never from the
 * roster file. The generic `worker` specialist keeps today's behaviour: when the
 * task ships its own `worker.md`, that text replaces the roster body; every other
 * specialist's body is its roster file, unmodified, plus `promptSuffixFor`'s text.
 */
export function writeRosterDefinitions(workspaceDir, { specialists, workers, extraTools = [], promptSuffixFor = () => "", taskDir = null }) {
	const dir = path.join(workspaceDir, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const files = [];
	for (const spec of specialists) {
		const o = workers.overrides?.[spec.name] ?? {};
		let body = spec.body;
		const own = taskDir ? path.join(taskDir, "worker.md") : null;
		if (spec.name === "worker" && own && fs.existsSync(own)) body = fs.readFileSync(own, "utf8").trimEnd();
		const md = renderDefinition(
			{ ...spec, body },
			{
				provider: o.provider ?? workers.default.provider,
				model: o.model ?? workers.default.model,
				thinking: o.thinking ?? workers.default.thinking ?? null,
				background: o.background,
				extraTools,
				promptSuffix: promptSuffixFor(spec),
			},
		);
		const file = path.join(dir, `${spec.name}.md`);
		fs.writeFileSync(file, md);
		files.push(file);
	}
	fs.writeFileSync(path.join(workspaceDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: workers.max ?? 1 }));
	return { files };
}
