// Context-diet policy: what to leave out of the message list before each LLM call.
//
// Two deterministic edits, both pure functions of the list (no stored state, so
// applying the diet to its own output changes nothing):
//   1. Drop `thinking` blocks from every assistant message except the last one. A
//      model never needs its old reasoning, it needs its old conclusions — but every
//      prior step's reasoning is re-sent on every call. The last assistant message is
//      left intact: a provider may require the thinking that led to its in-flight
//      tool call. (The boundary is the assistant message, not the user message: in an
//      rpc run an agent sees few user messages — the kickoff, then supervisor mail —
//      and a tool loop is many assistant steps under one of them; a "before the last
//      user message" rule dropped nothing in a live solo run.)
//   2. Age large tool results: a read/bash/... result older than `ageAfterTurns`
//      assistant turns is replaced by a short stub that keeps the message's identity
//      (toolCallId, toolName, isError, details) so toolCall↔toolResult pairing never
//      breaks. The model can always call the tool again.
// Evidence: the dyad builder on orbit spent 1.1M fresh input tokens, most of it
// re-reading its own history. pi's native compaction only summarises on overflow.

export const DEFAULTS = {
	ageAfterTurns: 6,
	ageTools: ["read", "bash", "grep", "find", "ls", "powershell"],
	ageMinChars: 1500,
};

const ELIDED = { type: "text", text: "(reasoning elided)" };

function stubFor(toolName, chars) {
	return `[${toolName} result elided by the supervisor: ${chars} chars. Call the tool again if you need it.]`;
}

/**
 * dietMessages(messages, opts) → { messages, stats }
 * Never mutates the input; unchanged messages are returned by reference.
 */
export function dietMessages(messages, opts = {}) {
	const { ageAfterTurns, ageTools, ageMinChars } = { ...DEFAULTS, ...opts };
	const aged = new Set(ageTools);
	const stats = { thinkingDropped: 0, resultsAged: 0, charsSaved: 0 };

	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	// assistantsAfter[i] = number of assistant messages strictly after index i.
	const assistantsAfter = new Array(messages.length).fill(0);
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		assistantsAfter[i] = count;
		if (messages[i]?.role === "assistant") count++;
	}

	const out = messages.map((m, i) => {
		if (m?.role === "assistant" && i !== lastAssistant && Array.isArray(m.content)) {
			const kept = m.content.filter((c) => c?.type !== "thinking");
			const dropped = m.content.length - kept.length;
			if (dropped === 0) return m;
			stats.thinkingDropped += dropped;
			return { ...m, content: kept.length ? kept : [ELIDED] };
		}
		if (m?.role === "toolResult" && aged.has(m.toolName) && !m.isError && assistantsAfter[i] >= ageAfterTurns && Array.isArray(m.content)) {
			if (!m.content.every((c) => c?.type === "text")) return m;
			const chars = m.content.reduce((n, c) => n + (c.text?.length ?? 0), 0);
			if (chars < ageMinChars) return m;
			const stub = stubFor(m.toolName, chars);
			stats.resultsAged++;
			stats.charsSaved += chars - stub.length;
			return { ...m, content: [{ type: "text", text: stub }] };
		}
		return m;
	});
	return { messages: out, stats };
}
