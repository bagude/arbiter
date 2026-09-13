// Page quotes as evidence: a claim about a paper cites a page and a verbatim span;
// the checker confirms the span appears on that page after whitespace removal and
// punctuation normalisation (pdf text carries soft hyphens, odd dashes and
// broken spacing). A quote that cannot be found is not evidence.
import fs from "node:fs";
import path from "node:path";

export const MIN_QUOTE_CHARS = 40;

export function normalize(text) {
	return String(text ?? "")
		.replace(/­/g, "")
		.replace(/[‐-―−]/g, "-")
		.replace(/[‘’‚]/g, "'")
		.replace(/[“”„]/g, '"')
		.replace(/�/g, "")
		// pdf text splits words at random ("eng ineering", "result s"): compare with no
		// whitespace at all, so a quote is verbatim modulo spacing.
		.replace(/\s+/g, "")
		.toLowerCase();
}

/** Map page number (1-based) → raw text, from a pages/ directory of pNN.txt files. */
export function loadPages(dir) {
	const pages = new Map();
	if (!fs.existsSync(dir)) return pages;
	for (const f of fs.readdirSync(dir)) {
		const m = /^p(\d+)\.txt$/.exec(f);
		if (m) pages.set(Number(m[1]), fs.readFileSync(path.join(dir, f), "utf8"));
	}
	return pages;
}

export function verifyQuote(pages, page, quote) {
	const n = Number(page);
	if (!Number.isInteger(n) || !pages.has(n)) return { ok: false, reason: `no such page ${page}` };
	const q = normalize(quote);
	if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: `quote too short (${q.length} chars, need ${MIN_QUOTE_CHARS})` };
	if (!normalize(pages.get(n)).includes(q)) return { ok: false, reason: `quote not found verbatim on page ${n}` };
	return { ok: true };
}
