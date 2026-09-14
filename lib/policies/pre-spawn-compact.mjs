// Pre-spawn compaction policy: should a fresh, foreground `subagent` call be denied
// so the orchestrator checkpoints and the supervisor compacts before the worker's
// blocking child run starts?
//
// Evidence (docs/backlog.md, runs/2026-09-13T14-05-03): a foreground spawn's tool
// call does not return until the child finishes — pi-subagents' own docs call this
// "a carrier that holds this run's outcome, blocked awaiting the child" — so the
// only compaction boundary the supervisor had (the worker's report) could not fire
// until up to the worker's entire runtime had already elapsed against a fat
// context. That run's worker held the tool call for 338 of 658 total seconds; the
// only compaction landed at 635s. A background spawn's tool call returns at once
// (no carrier), so it is never the problem this policy addresses.
//
// One-shot, to guarantee the run can never deadlock on this: denying an attempt
// sets `state.deniedPending`. The very next `subagent` attempt through this policy
// is let through unconditionally, whatever the context size and whether a
// compaction actually happened (it may not: maxCompactions reached, the model never
// checkpoints, the deadline lapses with a live worker from elsewhere). The flag
// then clears, so a later attempt — once context has grown past the threshold
// again — can be denied afresh.
export function decideSpawnDeny({ toolName, resume, runInBackground, contextChars, thresholdChars }, state) {
	if (toolName !== "subagent" || resume || runInBackground === true || !thresholdChars) {
		return { deny: false, reason: "not_applicable" };
	}
	if (state.deniedPending) {
		state.deniedPending = false;
		return { deny: false, reason: "retry_after_deny" };
	}
	if (contextChars < thresholdChars) return { deny: false, reason: "below_threshold" };
	state.deniedPending = true;
	return { deny: true, reason: "over_threshold", contextChars, thresholdChars };
}

/** Rough, cheap proxy for context size: the serialized message list, in characters. */
export function estimateContextChars(messages) {
	try {
		return JSON.stringify(messages ?? []).length;
	} catch {
		return 0;
	}
}
