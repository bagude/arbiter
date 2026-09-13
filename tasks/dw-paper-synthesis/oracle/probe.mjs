#!/usr/bin/env node
/**
 * Probe for dw-paper-synthesis.
 *   {id, args: ["cite", "m_…"]}             -> how the record resolves (claim, verified, status, snapshot)
 *   {id, args: ["quote", <page>, "<text>"]} -> does the span verify on that page?
 *   {id, args: ["claim", "R1"]}             -> every rule against that claim of src/report.json
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import path from "node:path";
import { verifyQuote } from "../../../lib/research/quotes.mjs";
import { resolveCitations } from "../../../lib/research/citations.mjs";
import { checkClaim, loadReportPages, env } from "./checks.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const pages = loadReportPages();
const { indexFile, scopes } = env();
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, a, b] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "cite") {
		if (!indexFile) return { id, ok: false, error: "no memory index in this run" };
		const r = resolveCitations(indexFile, scopes, [String(a)]).get(String(a));
		return { id, ok: true, value: { id: a, ...r } };
	}
	if (kind === "quote") {
		const r = verifyQuote(pages, a, b);
		return { id, ok: true, value: { page: a, verifies: r.ok, reason: r.reason ?? "found" } };
	}
	if (kind === "claim") {
		let doc;
		try {
			doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "report.json"), "utf8"));
		} catch (e) {
			return { id, ok: true, value: { valid: false, error: `src/report.json missing or invalid: ${e.message}` } };
		}
		const c = (doc.claims ?? []).find((x) => x?.id === a);
		if (!c) return { id, ok: false, error: `no claim ${a}` };
		const cites = Array.isArray(c.cites) ? c.cites.map(String) : [];
		const resolved = indexFile ? resolveCitations(indexFile, scopes, cites) : new Map(cites.map((x) => [x, { found: false, reason: "no memory index in this run" }]));
		const bad = checkClaim(c, pages, resolved);
		return { id, ok: true, value: { claim: a, passes: bad.length === 0, problems: bad } };
	}
	return { id, ok: false, error: 'args must be ["cite", id], ["quote", page, text] or ["claim", id]' };
});
console.log(JSON.stringify(results));
