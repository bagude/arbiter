// The gate used to require BUILDER's own kind="done" before CRITIC's approval
// could trigger the oracle. Evidence from six straight local-model runs (see
// arbiter/runs/2026-09-10T1[4-7]-*) showed BUILDER simply never sends it — not once,
// across any of them — no matter how directly CRITIC or the supervisor asked.
// The precondition was standing in for a real invariant: the code CRITIC is
// approving must be the code that gets tested, and it must not be mid-edit.
// That invariant is checkable directly, so it replaces the mail-based one.
export const QUIESCENCE_MS = 15_000; // BUILDER must be edit-quiet this long before an approval lands

export function decideApproval({ lastProbeHash, currentHash, srcExists, lastEditTs, now, quiescenceMs = QUIESCENCE_MS, unreported = [] }) {
	const sinceEditMs = now - (lastEditTs || 0);
	if (lastProbeHash === null || lastProbeHash === undefined) return { ok: false, reason: "no_probe", sinceEditMs };
	if (!srcExists) return { ok: false, reason: "no_src", sinceEditMs };
	// Orchestrator pattern with worker reports on: a completed worker that never called
	// `report` blocks approval. The worker can skip the tool; the run cannot finish
	// until it has not. Failed workers are never in this list (lib/workers.mjs).
	if (unreported.length) return { ok: false, reason: "unreported", sinceEditMs, unreported };
	if (currentHash !== lastProbeHash) return { ok: false, reason: "stale", sinceEditMs };
	if (sinceEditMs < quiescenceMs) return { ok: false, reason: "too_soon", sinceEditMs };
	return { ok: true, reason: null, sinceEditMs };
}
