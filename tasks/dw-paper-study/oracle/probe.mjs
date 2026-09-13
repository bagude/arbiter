#!/usr/bin/env node
/**
 * Probe for dw-paper-study.
 *   {id, args: ["quote", <page>, "<text>"]}   -> does the span verify on that page?
 *   {id, args: ["check", "<code>", <expect>]} -> does the code print that value?
 *   {id, args: ["claim", "C1"]}              -> every rule against that claim of src/study.json
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import path from "node:path";
import { checkQuote, checkCheck, checkClaim, loadStudyPages } from "./checks.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const pages = loadStudyPages();
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, a, b] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "quote") {
		const r = checkQuote(pages, { page: a, text: b });
		return { id, ok: true, value: { page: a, verifies: r.ok, reason: r.reason ?? "found" } };
	}
	if (kind === "check") {
		const r = checkCheck({ code: a, expect: b });
		return { id, ok: true, value: { reproduces: r.ok, printed: r.printed ?? null, reason: r.reason ?? "matches" } };
	}
	if (kind === "claim") {
		let doc;
		try {
			doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "study.json"), "utf8"));
		} catch (e) {
			return { id, ok: true, value: { valid: false, error: `src/study.json missing or invalid: ${e.message}` } };
		}
		const c = (doc.claims ?? []).find((x) => x?.id === a);
		if (!c) return { id, ok: false, error: `no claim ${a}` };
		const bad = checkClaim(c, pages);
		return { id, ok: true, value: { claim: a, passes: bad.length === 0, problems: bad } };
	}
	return { id, ok: false, error: 'args must be ["quote", page, text], ["check", code, expect] or ["claim", id]' };
});
console.log(JSON.stringify(results));
