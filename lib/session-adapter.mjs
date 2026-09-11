// pi-subagents children are not on the parent's RPC stream, but pi persists each
// child's transcript in its session JSONL format. This turns those entries into the
// same event shapes the supervisor already handles for RPC-driven agents, so a child
// gets tool counts, edit timestamps, bash watchdog and cost accounting for free.
export function sessionEntryToEvents(entry) {
	if (entry?.type !== "message" || !entry.message) return [];
	const m = entry.message;
	if (m.role === "toolResult") return [{ type: "tool_execution_end", toolCallId: m.toolCallId }];
	if (m.role !== "assistant") return [];
	const out = [];
	for (const part of m.content ?? []) {
		if (part.type === "toolCall") out.push({ type: "tool_execution_start", toolName: part.name, args: part.arguments ?? {}, toolCallId: part.id });
	}
	out.push({ type: "message_end", message: m });
	return out;
}
