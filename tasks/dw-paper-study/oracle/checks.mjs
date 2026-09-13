// The study rules, shared by validate.mjs (the oracle) and probe.mjs. Quotes verify
// against the paper's page files (lib/research/quotes.mjs); checks re-run
// (lib/research/snippets.mjs); memory ids resolve in the run's pinned index.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPages, verifyQuote } from "../../../lib/research/quotes.mjs";
import { runSnippet, valuesMatch, checkSnippet } from "../../../lib/research/snippets.mjs";
import { resolveCitations } from "../../../lib/research/citations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGES_DIR = path.join(here, "..", "..", "research-162910", "paper", "pages");
export const MIN_CLAIMS = 4;
export const MAX_CLAIMS = 8;
export const MIN_PAGES = 3;
const CLAIMS = ["observed", "interpreted", "hypothesis"];
const ID_RE = /^m_[0-9a-f]{12}$/;

export function checkQuote(pages, q) {
	if (!q || typeof q !== "object") return { ok: false, reason: "quote is not an object" };
	return verifyQuote(pages, q.page, q.text);
}

export function checkCheck(k) {
	if (!k || typeof k !== "object" || typeof k.code !== "string") return { ok: false, reason: "check needs code" };
	if (!("expect" in k)) return { ok: false, reason: "check needs expect" };
	const c = checkSnippet(k.code);
	if (!c.ok) return { ok: false, reason: c.reason };
	const r = runSnippet(k.code, { rows: null });
	if (!r.ok) return { ok: false, reason: `check failed: ${r.error}` };
	const m = valuesMatch(r.stdout, k.expect);
	return m.ok ? { ok: true, printed: m.got } : { ok: false, reason: m.reason, printed: m.got };
}

/** Problems with one claim (empty list = passes). */
export function checkClaim(c, pages, { indexFile = process.env.ARBITER_MEMORY_INDEX, scopes = null } = {}) {
	const bad = [];
	if (!c || typeof c !== "object") return ["claim is not an object"];
	if (!(typeof c.text === "string" && c.text.trim())) bad.push("text empty");
	if (!CLAIMS.includes(c.claim)) bad.push("claim must be one of observed, interpreted, hypothesis");
	const quotes = Array.isArray(c.quotes) ? c.quotes : [];
	const checks = Array.isArray(c.checks) ? c.checks : [];
	let evidence = 0;
	quotes.forEach((q, i) => {
		const r = checkQuote(pages, q);
		if (r.ok) evidence++;
		else bad.push(`quote ${i + 1}: ${r.reason}`);
	});
	checks.forEach((k, i) => {
		const r = checkCheck(k);
		if (r.ok) evidence++;
		else bad.push(`check ${k?.id ?? i + 1}: ${r.reason}`);
	});
	if (c.claim === "observed" && evidence === 0) bad.push("an observed claim needs at least one verified quote or check");
	if ((c.claim === "interpreted" || c.claim === "hypothesis") && !(typeof c.settlement_criterion === "string" && c.settlement_criterion.trim())) bad.push(`a ${c.claim} claim needs a non-empty settlement_criterion`);
	const refs = Array.isArray(c.evidence_refs) ? c.evidence_refs : [];
	if (refs.length) {
		if (!refs.every((r) => typeof r === "string" && ID_RE.test(r))) bad.push("evidence_refs must be memory ids like m_0123456789ab");
		else if (indexFile) {
			const sc = scopes ?? JSON.parse(process.env.ARBITER_MEMORY_SCOPES || "[]");
			const resolved = resolveCitations(indexFile, sc, refs);
			const missing = refs.filter((r) => !resolved.get(r)?.found);
			if (missing.length) bad.push(`evidence_refs not in this run's memory index: ${missing.join(", ")}`);
		}
	}
	return bad;
}

export function checkStudy(doc, pages) {
	const checks = [];
	const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
	const claims = Array.isArray(doc?.claims) ? doc.claims : [];
	add("claims_count", claims.length >= MIN_CLAIMS && claims.length <= MAX_CLAIMS, `${claims.length} claims (need ${MIN_CLAIMS}–${MAX_CLAIMS})`);
	const ids = claims.map((c) => c?.id);
	add("ids_unique", ids.every((i) => typeof i === "string" && i) && new Set(ids).size === ids.length, ids.join(","));
	const nq = doc?.next_questions;
	add("next_questions", Array.isArray(nq) && nq.length > 0 && nq.every((q) => typeof q === "string" && q.trim()), Array.isArray(nq) ? `${nq.length} question(s)` : "missing");
	const pagesCited = new Set();
	const details = [];
	for (const c of claims) {
		const bad = checkClaim(c, pages);
		for (const q of Array.isArray(c?.quotes) ? c.quotes : []) if (checkQuote(pages, q).ok) pagesCited.add(Number(q.page));
		add(`claim ${c?.id ?? "?"}`, bad.length === 0, bad.join("; ") || "verified");
		details.push({ id: c?.id, reproduced: bad.length === 0, claim: c?.claim, quotes: (c?.quotes ?? []).length, checks: (c?.checks ?? []).length });
	}
	add("pages_cited", pagesCited.size >= MIN_PAGES, `${pagesCited.size} distinct page(s) with verified quotes (need ${MIN_PAGES})`);
	return { checks, details };
}

export function loadStudyPages() {
	return loadPages(PAGES_DIR);
}
