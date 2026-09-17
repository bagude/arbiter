// fork-force policy: in an A branch of a fork, the orchestrator's first tool call
// must be of the forced action class (A-natural) — or, for A-oracle, the forced
// tool with the recorded arguments. Wrong-class calls are denied with the class
// named until one of the right class passes; then the policy is spent.
const DESCRIBE = {
	spawn: "spawn a new worker (subagent)", resume: "resume an existing worker (subagent with resume)", collect: "collect a background worker's result (get_subagent_result)",
	probe: "send a probe to the supervisor (send_mail kind=probe)", done: "claim the task is done (send_mail kind=done)", inspect: "inspect the workspace (read, ls, grep)",
	memory: "consult memory (memory_search, memory_get)", checkpoint: "checkpoint or check context usage", answer: "answer without a tool",
};

export function classOfCall(toolName, input) {
	const a = input ?? {};
	switch (toolName) {
		case "subagent": return a.resume ? "resume" : "spawn";
		case "get_subagent_result": return "collect";
		case "send_mail": return a.kind === "probe" ? "probe" : a.kind === "done" ? "done" : "memory";
		case "read": case "ls": case "grep": case "find": case "bash": return "inspect";
		// `remember` is deliberately absent. tools/decision-points.mjs's classifyTurn has no
		// case for it either, so a recorded remember call reads as `inspect` there. Listed here
		// it would make an A-oracle force of such a call { cls: "inspect", tool: "remember" } —
		// a pair this function can never produce, so decideForce would deny every call for the
		// rest of the run. The two classifiers have to agree on every tool or the forcing is a
		// trap. (Unreachable today: ORCHESTRATOR_TOOLS has no remember, and this is
		// orchestrator-only.)
		case "memory_search": case "memory_get": return "memory";
		case "checkpoint": case "context_usage": return "checkpoint";
		default: return "inspect";
	}
}

export function decideForce({ toolName, input }, force, state) {
	if (!force || state.done) return { act: "pass" };
	const cls = classOfCall(toolName, input);
	if (cls !== force.cls || (force.tool && toolName !== force.tool)) {
		return { act: "deny", reason: `[FORK] Your next action must be: ${DESCRIBE[force.cls] ?? force.cls}${force.tool ? ` — call \`${force.tool}\` now` : ""}. Do that first; other calls are refused until you do.` };
	}
	state.done = true;
	if (force.args && typeof force.args === "object") return { act: "rewrite", input: { ...force.args } };
	return { act: "pass" };
}
