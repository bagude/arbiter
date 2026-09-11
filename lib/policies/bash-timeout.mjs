// Bash-timeout policy for the in-band guard. pi's bash tool takes `timeout` in
// seconds as an OPTIONAL argument with no default (core/tools/bash.ts: "no default
// timeout"), which is exactly what let a `find /` hang a whole run. The supervisor's
// checkBashTimeout() is an abort 90 s after the fact and cannot reach a background
// worker at all; rewriting the argument before the call runs makes pi enforce the
// limit itself, for every role.
//
// Pure: no pi, no fs. The extension (ext/guards/bash-timeout.ts) applies `rewrite`
// by mutating the tool_call event's input in place.

function validSeconds(t) {
	return typeof t === "number" && Number.isFinite(t) && t > 0;
}

/**
 * decideBashTimeout({ input, defaultSec, maxSec })
 *   → { ok: true }                                   nothing to change
 *   → { ok: false, rewrite: { timeout }, reason }    apply `rewrite` to the input
 */
export function decideBashTimeout({ input, defaultSec, maxSec }) {
	const cap = Math.min(defaultSec, maxSec);
	const t = input?.timeout;
	if (!validSeconds(t)) {
		return { ok: false, rewrite: { timeout: cap }, reason: `bash call had no timeout (or an invalid one: ${String(t)}); set to ${cap}s` };
	}
	if (t > maxSec) {
		return { ok: false, rewrite: { timeout: maxSec }, reason: `bash timeout ${t}s exceeds the ${maxSec}s maximum; clamped` };
	}
	return { ok: true };
}
