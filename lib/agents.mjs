// Per-agent bookkeeping. One entry per pi process (dyad, solo) or per pi-subagents
// child (orchestrator pattern). Nothing here decides anything; it is the state the
// supervisor's decisions read.
export const EDITING_TOOLS = new Set(["write", "edit", "bash"]);

export function createAgentState({ id, role, child = null, raw = null }) {
	return { id, role, child, raw, busy: false, ready: false, status: "starting", toolCalls: 0, cost: 0, buf: "", pendingBash: new Map(), lastEditTs: 0 };
}

export function lastEditAcross(states) {
	let max = 0;
	for (const s of states) if (s.lastEditTs > max) max = s.lastEditTs;
	return max;
}

export function liveWorkers(states) {
	return [...states].filter((s) => s.role === "worker" && s.status === "running");
}
