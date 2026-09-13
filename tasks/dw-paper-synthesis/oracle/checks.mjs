// The synthesis rules: citations resolve and obey the claim rules, quotes verify,
// the report has enough claims and names what is unresolved.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPages, verifyQuote } from "../../../lib/research/quotes.mjs";
import { resolveCitations, citationRules } from "../../../lib/research/citations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGES_DIR = path.join(here, "..", "..", "research-162910", "paper", "pages");
export const MIN_CLAIMS = 6;
export const MIN_OBSERVED = 2;
const CLAIMS = ["observed", "interpreted", "hypothesis"];

export function env() {
	let scopes = [];
	try {
		scopes = JSON.parse(process.env.ARBITER_MEMORY_SCOPES || "[]");
	} catch {
		scopes = [];
	}
	return { indexFile: process.env.ARBITER_MEMORY_INDEX || "", scopes };
}

export function checkClaim(c, pages, resolved) {
	const bad = [];
	if (!c || typeof c !== "object") return ["claim is not an object"];
	if (!(typeof c.text === "string" && c.text.trim())) bad.push("text empty");
	if (!CLAIMS.includes(c.claim)) bad.push("claim must be one of observed, interpreted, hypothesis");
	const cites = Array.isArray(c.cites) ? c.cites.map(String) : [];
	const quotes = Array.isArray(c.quotes) ? c.quotes : [];
	if (!cites.length && !quotes.length) bad.push("a claim cites at least one memory record or one quote");
	bad.push(...citationRules(c.claim, cites, resolved));
	quotes.forEach((q, i) => {
		const r = verifyQuote(pages, q?.page, q?.text);
		if (!r.ok) bad.push(`quote ${i + 1}: ${r.reason}`);
	});
	if ((c.claim === "interpreted" || c.claim === "hypothesis") && !(typeof c.settlement_criterion === "string" && c.settlement_criterion.trim())) bad.push(`a ${c.claim} claim needs a non-empty settlement_criterion`);
	return bad;
}

export function checkReport(doc, pages, { indexFile, scopes }) {
	const checks = [];
	const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
	const claims = Array.isArray(doc?.claims) ? doc.claims : [];
	add("claims_count", claims.length >= MIN_CLAIMS, `${claims.length} claims (need ${MIN_CLAIMS})`);
	add("observed_count", claims.filter((c) => c?.claim === "observed").length >= MIN_OBSERVED, `${claims.filter((c) => c?.claim === "observed").length} observed (need ${MIN_OBSERVED})`);
	const ids = claims.map((c) => c?.id);
	add("ids_unique", ids.every((i) => typeof i === "string" && i) && new Set(ids).size === ids.length, ids.join(","));
	add("question", typeof doc?.question === "string" && doc.question.trim().length > 0, "");
	const un = doc?.unresolved;
	add("unresolved", Array.isArray(un) && un.length > 0 && un.every((q) => typeof q === "string" && q.trim()), Array.isArray(un) ? `${un.length} listed` : "missing");
	const allIds = [...new Set(claims.flatMap((c) => (Array.isArray(c?.cites) ? c.cites.map(String) : [])))];
	const resolved = indexFile ? resolveCitations(indexFile, scopes, allIds) : new Map(allIds.map((id) => [id, { found: false, reason: "no memory index in this run" }]));
	const details = [];
	for (const c of claims) {
		const bad = checkClaim(c, pages, resolved);
		add(`claim ${c?.id ?? "?"}`, bad.length === 0, bad.join("; ") || "verified");
		details.push({ id: c?.id, reproduced: bad.length === 0, claim: c?.claim, cites: (c?.cites ?? []).length, quotes: (c?.quotes ?? []).length });
	}
	return { checks, details, resolved };
}

export function loadReportPages() {
	return loadPages(PAGES_DIR);
}
