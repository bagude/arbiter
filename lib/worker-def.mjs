import fs from "node:fs";
import path from "node:path";

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
