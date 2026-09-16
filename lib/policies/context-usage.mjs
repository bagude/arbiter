// context_usage policy: a read-only estimate of how much of the current context
// window has been used, from the same char-count proxy as
// lib/policies/pre-spawn-compact.mjs (estimateContextChars), against the role's
// context window (from lib/config.mjs's model preflight, ARBITER_CONTEXT_WINDOW).
export const CHARS_PER_TOKEN = 3.3;

const fmt = (n) => n.toLocaleString("en-US");

export function describeContextUsage({ chars, contextWindow }) {
	const estTokens = Math.round(chars / CHARS_PER_TOKEN);
	const window = contextWindow == null ? null : contextWindow;
	let percent = null;
	let text;
	if (window != null) {
		percent = Number(((estTokens / window) * 100).toFixed(1));
		text = `Context: ~${fmt(chars)} chars (~${fmt(estTokens)} tokens est.) of ${fmt(window)} (${percent.toFixed(1)}% used).`;
	} else {
		text = `Context: ~${fmt(chars)} chars (~${fmt(estTokens)} tokens est.); context window unknown.`;
	}
	return { chars, estTokens, contextWindow: window, percent, text };
}
