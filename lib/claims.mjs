// The author's classification of a memory record. Kept apart from lib/memory.mjs so
// lib/wiki.mjs (which memory.mjs imports) can use it without an import cycle.
// Orthogonal to `status` (human acceptance) and to `verification` (what deterministic
// code established).
export const CLAIMS = ["observed", "interpreted", "hypothesis", "unreviewed", "procedure", "episode"];
export const DEFAULT_CLAIM = { episodic: "episode", procedural: "procedure", semantic: "unreviewed", question: "hypothesis" };
export const NEEDS_CRITERION = new Set(["interpreted", "hypothesis"]);
// Weaker claims rank lower; a merge keeps the weaker one.
export const CLAIM_RANK = { observed: 3, interpreted: 2, hypothesis: 1, unreviewed: 0, procedure: 0, episode: 0 };

/** Claim of a record that may predate the field. */
export function claimOf(r) {
	return CLAIMS.includes(r?.claim) ? r.claim : (DEFAULT_CLAIM[r?.kind] ?? "unreviewed");
}
