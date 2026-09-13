// Memory citations as evidence: a synthesis claim cites record ids; the checker
// resolves them in the run's pinned index within the allowed scopes and applies the
// claim rules — an observed claim rests only on observed records the oracle
// reproduced; interpretations and hypotheses say what would settle them.
import { get } from "../memory-index.mjs";
import { claimOf } from "../claims.mjs";

const ID_RE = /^m_[0-9a-f]{12}$/;

export function resolveCitations(indexFile, scopes, ids) {
	const out = new Map();
	const valid = ids.filter((id) => ID_RE.test(id));
	for (const id of ids) if (!ID_RE.test(id)) out.set(id, { found: false, reason: "not a memory id" });
	for (let i = 0; i < valid.length; i += 5) {
		const chunk = valid.slice(i, i + 5);
		const recs = get(indexFile, { ids: chunk, scopes });
		const byId = new Map(recs.map((r) => [r.id, r]));
		for (const id of chunk) {
			const r = byId.get(id);
			out.set(id, r ? { found: true, claim: claimOf(r), status: r.status, verified: Boolean(r.verification?.reproduced), snapshot: r.snapshot ?? null, superseded: Boolean(r.superseded_by), summary: r.summary } : { found: false, reason: "not in the index within the allowed scopes" });
		}
	}
	return out;
}

/** Problems with one claim's citations, given the resolved records. */
export function citationRules(claim, cites, resolved) {
	const problems = [];
	for (const id of cites) {
		const r = resolved.get(id);
		if (!r?.found) {
			problems.push(`${id}: ${r?.reason ?? "unresolved"}`);
			continue;
		}
		if (r.status === "tombstoned" || r.superseded) problems.push(`${id} is ${r.superseded ? "superseded" : "tombstoned"}`);
		if (claim === "observed" && !(r.claim === "observed" && r.verified)) problems.push(`${id} is ${r.claim}${r.verified ? "" : ", unverified"}; an observed claim rests only on verified observed records`);
	}
	return problems;
}
