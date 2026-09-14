#!/usr/bin/env node
/**
 * Probe for social-investment-signals. Each case is {id, args}:
 *   ["quote", "<post id>", "<text>"]      -> is the span verbatim in that post, and is the post in the window?
 *   ["primary", "<doc id>", "<text>"]     -> is the span verbatim in that primary document?
 *   ["mentions", "<TICKER>"]              -> post ids in the window that mention the ticker, and how each does
 *   ["coverage"]                          -> the recomputed window and per-source coverage
 *   ["duplicates"]                        -> repost groups and the ambiguous mentions that must stay unresolved
 *   ["candidate", "W1"]                   -> every rule against that candidate of the current src/watchlist.json
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import path from "node:path";
import { ambiguousPosts, checkCandidate, coverageOf, duplicateGroups, loadData, loadInvestigations, mentionKinds, mentionsOf, verifyQuoteIn, inWindow, textOf } from "./checks.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const data = loadData();
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, a, b] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "quote") {
		const post = data.posts.get(a);
		if (!post) return { id, ok: true, value: { post: a, verifies: false, reason: "no such post" } };
		const r = verifyQuoteIn(textOf(post), b, `post ${a}`);
		return { id, ok: true, value: { post: a, verifies: r.ok && inWindow(data, post), in_window: inWindow(data, post), url: post.url, reason: r.reason ?? (inWindow(data, post) ? "found" : "found, but published outside the window") } };
	}
	if (kind === "primary") {
		const doc = data.primary.get(a);
		if (!doc) return { id, ok: true, value: { doc: a, verifies: false, reason: `no such primary document; available: ${[...data.primary.keys()].join(", ")}` } };
		const r = verifyQuoteIn(doc, b, `primary ${a}`);
		return { id, ok: true, value: { doc: a, verifies: r.ok, reason: r.reason ?? "found" } };
	}
	if (kind === "mentions") {
		const entry = data.tickers.get(a);
		if (!entry) return { id, ok: false, error: `ticker ${a} is not in tickers.csv` };
		const posts = mentionsOf(data, a).map((pid) => ({ post: pid, source: data.posts.get(pid).source, how: [...mentionKinds(data.posts.get(pid), a, entry)] }));
		return { id, ok: true, value: { ticker: a, ambiguous: entry.ambiguous, posts } };
	}
	if (kind === "coverage") return { id, ok: true, value: { window: { from: data.window.from.toISOString(), to: data.window.to.toISOString() }, coverage: coverageOf(data), baselines: [...data.baselines.keys()] } };
	if (kind === "duplicates") return { id, ok: true, value: { repost_groups: duplicateGroups(data), ambiguous_posts: ambiguousPosts(data) } };
	if (kind === "candidate") {
		let doc;
		try {
			doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "watchlist.json"), "utf8"));
		} catch (e) {
			return { id, ok: true, value: { valid: false, error: `src/watchlist.json missing or invalid: ${e.message}` } };
		}
		const c = (doc.candidates ?? []).find((x) => x?.id === a);
		if (!c) return { id, ok: false, error: `no candidate ${a}` };
		const bad = checkCandidate(data, c, { investigation: loadInvestigations(ws, doc).get(a) ?? null });
		return { id, ok: true, value: { candidate: a, passes: bad.length === 0, problems: bad } };
	}
	return { id, ok: false, error: 'args must be ["quote", post, text], ["primary", doc, text], ["mentions", ticker], ["coverage"], ["duplicates"] or ["candidate", id]' };
});
console.log(JSON.stringify(results));
