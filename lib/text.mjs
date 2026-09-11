// mail-ext.ts caps what an AGENT can put in a mail body (MAX_BODY = 8000 chars),
// but probe results are supervisor-generated and go straight through deliver(),
// bypassing that cap entirely. A task whose return values can be large (e.g. a
// simulation result with thousands of samples) can produce a single probe-result
// message of hundreds of KB — found live: two ~250KB untruncated echoes back to
// back were enough to push a local model's context past what its own overflow
// recovery could then summarize, an unrecoverable stall rather than a slowdown.
// This caps only the DISPLAY string; comparisons for expect/match always use the
// full untruncated value.
export const PROBE_VALUE_MAX = 1500;
export function truncateForMail(s, max = PROBE_VALUE_MAX) {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[truncated, ${s.length} chars total — ask for a smaller case, e.g. a shorter n, if you need to see all of it]`;
}
