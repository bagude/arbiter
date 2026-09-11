// Caps text that is about to enter a model's context. Full values stay in the run's
// files; found live: two ~250KB untruncated probe echoes pushed a local model past
// what its own overflow recovery could summarise.
export const PROBE_VALUE_MAX = 1500;
export function truncateForMail(s, max = PROBE_VALUE_MAX) {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[truncated, ${s.length} chars total]`;
}
