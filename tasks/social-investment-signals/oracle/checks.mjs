// The watchlist rules, shared by validate.mjs (the oracle) and probe.mjs. Every rule
// is mechanical and every expected value is recomputed from the task's PRISTINE
// exports (tasks/<task>/ws-builder/data), never from anything an agent wrote: the
// window, source coverage, duplicate groups, mention counts and baselines all come
// from those bytes. What the oracle can verify: quotes are verbatim, posts are in
// the window, tickers resolve, duplicates are clustered, verification cites primary
// text, structure is honest about baselines. What it cannot: whether a thesis is
// any good. Priority and stance are the author's judgement and are only checked for
// shape.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../../../lib/research/quotes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(here, "..", "ws-builder", "data");
export const MAX_CANDIDATES = 10;
export const MIN_QUOTE_CHARS = 30; // social posts are short; a paper quote needs 40
export const WINDOW_DAYS = 7;
export const CLAIMS = ["observed", "interpreted", "hypothesis"];
export const STANCES = ["bullish", "bearish", "neutral", "contested"];
export const HORIZONS = ["days", "weeks", "months", "years", "unspecified"];
export const VERIFICATION = ["verified", "contradicted", "unverified"];
export const QUALITY = ["primary-verified", "secondary", "discussion-only"];
export const RESOLUTION = ["resolved", "unresolved"];

function parseCsv(text) {
	const [head, ...rows] = text.trim().split(/\r?\n/);
	const cols = head.split(",");
	return rows.filter(Boolean).map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
}

/** Everything the oracle knows, loaded once from the pristine data directory. */
export function loadData(dir = DATA_DIR) {
	const sourcesFile = JSON.parse(fs.readFileSync(path.join(dir, "exports", "sources.json"), "utf8"));
	const posts = new Map();
	const bySource = new Map();
	for (const [source, rel] of Object.entries(sourcesFile.sources)) {
		const list = fs
			.readFileSync(path.join(dir, rel), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		bySource.set(source, list);
		for (const p of list) posts.set(p.id, p);
	}
	const tickers = new Map(parseCsv(fs.readFileSync(path.join(dir, "tickers.csv"), "utf8")).map((r) => [r.symbol, { ...r, aliases: r.aliases ? r.aliases.split(";") : [], ambiguous: r.ambiguous === "true" }]));
	const primary = new Map();
	const pdir = path.join(dir, "primary");
	for (const f of fs.existsSync(pdir) ? fs.readdirSync(pdir) : []) if (f.endsWith(".txt")) primary.set(f.slice(0, -4), fs.readFileSync(path.join(pdir, f), "utf8"));
	const baselines = new Map();
	const bdir = path.join(dir, "baseline");
	for (const f of fs.existsSync(bdir) ? fs.readdirSync(bdir) : []) {
		if (!f.endsWith(".json")) continue;
		const b = JSON.parse(fs.readFileSync(path.join(bdir, f), "utf8"));
		baselines.set(b.source, b);
	}
	const collected = [...posts.values()].map((p) => Date.parse(p.collected_at));
	const to = new Date(Math.max(...collected));
	const from = new Date(to.getTime() - WINDOW_DAYS * 86400_000);
	return { posts, bySource, tickers, primary, baselines, window: { from, to } };
}

export const textOf = (p) => `${p.title ?? ""}\n${p.body ?? ""}`;
export const inWindow = (data, p) => {
	const t = Date.parse(p.published);
	return t > data.window.from.getTime() && t <= data.window.to.getTime();
};

/** Recomputed coverage per source: what the deliverable's `coverage` must state. */
export function coverageOf(data) {
	return [...data.bySource.entries()].map(([source, list]) => {
		const pub = list.map((p) => Date.parse(p.published));
		return {
			source,
			posts: list.length,
			posts_in_window: list.filter((p) => inWindow(data, p)).length,
			earliest_published: new Date(Math.min(...pub)).toISOString(),
			latest_published: new Date(Math.max(...pub)).toISOString(),
			collected_at: new Date(Math.max(...list.map((p) => Date.parse(p.collected_at)))).toISOString(),
		};
	});
}

/** Groups of posts whose normalised BODY is identical (a repost usually changes the title). Only groups of 2+. */
export function duplicateGroups(data) {
	const by = new Map();
	for (const p of data.posts.values()) {
		const k = normalize(p.body);
		if (k.length < MIN_QUOTE_CHARS) continue;
		if (!by.has(k)) by.set(k, []);
		by.get(k).push(p.id);
	}
	return [...by.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a post mention a ticker, and how? `cashtag` ($SYM), `name` (company name or
 * alias), `bare` (the symbol as a whole word, which for an ambiguous symbol is not a
 * resolution). Case-insensitive.
 */
export function mentionKinds(post, symbol, entry) {
	const text = textOf(post);
	const kinds = new Set();
	if (new RegExp(`\\$${escapeRe(symbol)}\\b`, "i").test(text)) kinds.add("cashtag");
	for (const n of [entry?.name, ...(entry?.aliases ?? [])].filter(Boolean)) if (new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(text)) kinds.add("name");
	if (new RegExp(`(^|[^$\\w])${escapeRe(symbol)}\\b`, "i").test(text)) kinds.add("bare");
	return kinds;
}

/**
 * Post ids in the window that mention the ticker (the attention count). For an
 * ambiguous symbol a bare word is not a mention — "Arc" in "Arc Pharmaceuticals" is
 * not Arcline Robotics — only a cashtag, the name or an alias counts.
 */
export function mentionsOf(data, symbol, { sources = null } = {}) {
	const entry = data.tickers.get(symbol);
	const counts = (k) => (entry?.ambiguous ? k.has("cashtag") || k.has("name") : k.size > 0);
	return [...data.posts.values()]
		.filter((p) => inWindow(data, p) && (!sources || sources.has(p.source)) && counts(mentionKinds(p, symbol, entry)))
		.map((p) => p.id)
		.sort();
}

/**
 * Posts that mention an ambiguous symbol only as a bare word or as a name shared by
 * two entries, with nothing that picks one company: these must be reported as
 * unresolved and cited by no candidate. Bare "Arc" matches Arcline's symbol ARC as a
 * word and Arc Pharmaceuticals' name prefix; only a cashtag, the full name or an
 * alias resolves it.
 */
export function ambiguousPosts(data) {
	const amb = [...data.tickers.entries()].filter(([, e]) => e.ambiguous);
	const out = [];
	for (const p of data.posts.values()) {
		if (!inWindow(data, p)) continue;
		let bare = false;
		let resolved = false;
		for (const [sym, e] of amb) {
			const k = mentionKinds(p, sym, e);
			if (k.has("cashtag") || k.has("name")) resolved = true;
			if (k.has("bare")) bare = true;
		}
		if (bare && !resolved) out.push(p.id);
	}
	return out.sort();
}

export function verifyQuoteIn(text, quote, what) {
	const q = normalize(quote);
	if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: `quote too short (${q.length} chars, need ${MIN_QUOTE_CHARS})` };
	if (!normalize(text).includes(q)) return { ok: false, reason: `quote not found verbatim in ${what}` };
	return { ok: true };
}

export function checkPostQuote(data, ref) {
	if (!ref || typeof ref !== "object") return { ok: false, reason: "source is not an object" };
	const p = data.posts.get(ref.post);
	if (!p) return { ok: false, reason: `no such post ${ref.post}` };
	if (!inWindow(data, p)) return { ok: false, reason: `post ${ref.post} was published outside the seven-day window` };
	if (ref.url !== p.url) return { ok: false, reason: `url for ${ref.post} does not match the export` };
	return verifyQuoteIn(textOf(p), ref.quote, `post ${ref.post}`);
}

export function checkPrimaryQuote(data, ref) {
	if (!ref || typeof ref !== "object") return { ok: false, reason: "primary is not an object" };
	const doc = data.primary.get(ref.doc);
	if (!doc) return { ok: false, reason: `no such primary document ${ref.doc}` };
	return verifyQuoteIn(doc, ref.quote, `primary ${ref.doc}`);
}

/** Problems with one candidate (empty list = passes). `investigations` maps id → parsed file or null. */
export function checkCandidate(data, c, { investigation = null, duplicates = duplicateGroups(data), ambiguous = new Set(ambiguousPosts(data)) } = {}) {
	const bad = [];
	if (!c || typeof c !== "object") return ["candidate is not an object"];
	for (const f of ["company", "ticker", "thesis", "catalyst"]) if (!(typeof c[f] === "string" && c[f].trim())) bad.push(`${f} empty`);
	if (!CLAIMS.includes(c.claim)) bad.push("claim must be one of observed, interpreted, hypothesis");
	if (!STANCES.includes(c.stance)) bad.push(`stance must be one of ${STANCES.join(", ")}`);
	if (!HORIZONS.includes(c.horizon)) bad.push(`horizon must be one of ${HORIZONS.join(", ")}`);
	if (c.resolution !== "resolved") bad.push("a listed candidate must have resolution 'resolved' (unresolved mentions go in unresolved_mentions)");
	const entry = data.tickers.get(c.ticker);
	if (!entry) bad.push(`ticker ${c.ticker} is not in tickers.csv`);
	else if (normalize(c.company) !== normalize(entry.name)) bad.push(`company "${c.company}" is not the master name for ${c.ticker} (${entry.name})`);

	const supporting = Array.isArray(c.supporting_sources) ? c.supporting_sources : [];
	const opposing = Array.isArray(c.opposing) ? c.opposing : [];
	if (!supporting.length) bad.push("needs at least one supporting source");
	const citedPosts = [];
	for (const [label, list] of [["supporting", supporting], ["opposing", opposing]]) {
		list.forEach((s, i) => {
			const r = checkPostQuote(data, s);
			if (!r.ok) bad.push(`${label} ${i + 1}: ${r.reason}`);
			else citedPosts.push(s.post);
			if (s?.post && ambiguous.has(s.post)) bad.push(`${label} ${i + 1}: post ${s.post} is an ambiguous mention and cannot support a resolved candidate`);
		});
	}
	if (entry) {
		const grounded = supporting.some((s) => {
			const p = data.posts.get(s?.post);
			if (!p) return false;
			const k = mentionKinds(p, c.ticker, entry);
			return k.has("cashtag") || k.has("name");
		});
		if (!grounded) bad.push("no supporting post names the company ($TICKER, name or alias) — resolution is not grounded");
	}
	const groupOf = new Map();
	duplicates.forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
	const seen = new Map();
	for (const s of supporting) {
		const g = groupOf.get(s?.post);
		if (g === undefined) continue;
		if (seen.has(g)) bad.push(`supporting sources ${seen.get(g)} and ${s.post} are the same repost — not distinct`);
		else seen.set(g, s.post);
	}

	const ver = Array.isArray(c.verification) ? c.verification : [];
	if (!ver.length) bad.push("needs at least one verification entry (a factual claim checked against primary sources, or marked unverified)");
	let primaryOk = 0;
	ver.forEach((v, i) => {
		if (!(typeof v?.claim === "string" && v.claim.trim())) bad.push(`verification ${i + 1}: claim empty`);
		if (!VERIFICATION.includes(v?.status)) bad.push(`verification ${i + 1}: status must be one of ${VERIFICATION.join(", ")}`);
		if (v?.status === "verified" || v?.status === "contradicted") {
			const r = checkPrimaryQuote(data, v.primary);
			if (r.ok) primaryOk++;
			else bad.push(`verification ${i + 1} (${v.status}): ${r.reason}`);
		} else if (v?.status === "unverified" && !(typeof v.note === "string" && v.note.trim())) bad.push(`verification ${i + 1}: an unverified claim needs a note saying what primary source would settle it`);
	});
	if (!QUALITY.includes(c.evidence_quality)) bad.push(`evidence_quality must be one of ${QUALITY.join(", ")}`);
	else if ((c.evidence_quality === "primary-verified") !== primaryOk > 0) bad.push(`evidence_quality "${c.evidence_quality}" does not match the verification entries (${primaryOk} verified against primary text)`);
	if (c.claim === "observed" && primaryOk === 0) bad.push("an observed candidate needs at least one claim verified or contradicted against primary text");
	if (c.claim !== "observed" && !(typeof c.settlement_criterion === "string" && c.settlement_criterion.trim())) bad.push(`a ${c.claim} candidate needs a non-empty settlement_criterion`);

	const s = c.sentiment;
	const total = ["bullish", "bearish", "neutral"].reduce((n, k) => n + (Number.isInteger(s?.[k]) ? s[k] : NaN), 0);
	if (!(s && typeof s === "object") || Number.isNaN(total)) bad.push("sentiment needs integer bullish/bearish/neutral counts");
	else if (total !== citedPosts.length) bad.push(`sentiment counts sum to ${total} but ${citedPosts.length} posts are cited`);

	const a = c.attention;
	if (!(a && typeof a === "object")) bad.push("attention missing");
	else {
		const sources = new Set(citedPosts.map((id) => data.posts.get(id)?.source));
		const baselined = [...sources].filter((src) => data.baselines.has(src));
		const expectAvailable = baselined.length > 0;
		if (a.baseline_available !== expectAvailable) bad.push(`attention.baseline_available must be ${expectAvailable} (baseline data exists for: ${[...data.baselines.keys()].join(", ") || "none"}; this candidate's sources: ${[...sources].join(", ")})`);
		else if (expectAvailable) {
			const win = mentionsOf(data, c.ticker, { sources: new Set(baselined) }).length;
			const base = baselined.reduce((n, src) => n + (Number(data.baselines.get(src).mentions?.[c.ticker]) || 0), 0);
			if (a.posts_window !== win) bad.push(`attention.posts_window is ${a.posts_window}, recount over ${baselined.join(", ")} in the window gives ${win}`);
			if (a.posts_baseline !== base) bad.push(`attention.posts_baseline is ${a.posts_baseline}, baseline files give ${base}`);
		} else if (!(typeof a.note === "string" && /baseline/i.test(a.note))) bad.push("attention.note must state explicitly that no baseline exists for these sources");
	}
	if (!Number.isInteger(c.priority) || c.priority < 1) bad.push("priority must be a positive integer rank");
	if (!(Array.isArray(c.limitations) && c.limitations.length && c.limitations.every((x) => typeof x === "string" && x.trim()))) bad.push("limitations must be a non-empty list of strings");

	if (!investigation) bad.push(`src/investigations/${c.id}.json missing or invalid`);
	else {
		for (const f of ["supporting_evidence", "counterevidence", "unresolved_questions"]) if (!Array.isArray(investigation[f])) bad.push(`investigation ${f} must be an array`);
		if (!VERIFICATION.includes(investigation.verification_status)) bad.push(`investigation verification_status must be one of ${VERIFICATION.join(", ")}`);
		const evPosts = new Set((Array.isArray(investigation.supporting_evidence) ? investigation.supporting_evidence : []).map((e) => e?.post));
		const missing = supporting.map((x) => x?.post).filter((id) => id && !evPosts.has(id));
		if (missing.length) bad.push(`investigation supporting_evidence lacks cited posts ${missing.join(", ")}`);
	}
	return bad;
}

export function checkWatchlist(data, doc, investigations) {
	const checks = [];
	const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) });
	const details = [];
	const cands = Array.isArray(doc?.candidates) ? doc.candidates : [];

	add("candidates_count", cands.length <= MAX_CANDIDATES, `${cands.length} candidate(s) (at most ${MAX_CANDIDATES}; zero is allowed)`);
	const ids = cands.map((c) => c?.id);
	add("ids_unique", ids.every((i) => typeof i === "string" && /^W\d+$/.test(i)) && new Set(ids).size === ids.length, ids.join(",") || "none");
	const pr = cands.map((c) => c?.priority);
	add("priority_ranking", pr.every((p) => Number.isInteger(p)) && new Set(pr).size === pr.length && pr.every((p) => p >= 1 && p <= Math.max(cands.length, 1)), `priorities ${pr.join(",") || "none"}`);

	const w = doc?.window;
	const from = Date.parse(w?.from);
	const to = Date.parse(w?.to);
	add("window", from === data.window.from.getTime() && to === data.window.to.getTime(), `stated ${w?.from} → ${w?.to}; exports give ${data.window.from.toISOString()} → ${data.window.to.toISOString()} (to = latest collection time, from = to − ${WINDOW_DAYS} days)`);

	const cov = coverageOf(data);
	const stated = Array.isArray(doc?.coverage) ? doc.coverage : [];
	const covBad = [];
	for (const c of cov) {
		const s = stated.find((x) => x?.source === c.source);
		if (!s) {
			covBad.push(`${c.source} missing`);
			continue;
		}
		for (const f of ["posts", "posts_in_window"]) if (s[f] !== c[f]) covBad.push(`${c.source}.${f} ${s[f]} ≠ ${c[f]}`);
		for (const f of ["earliest_published", "latest_published", "collected_at"]) if (Date.parse(s[f]) !== Date.parse(c[f])) covBad.push(`${c.source}.${f} ${s[f]} ≠ ${c[f]}`);
	}
	for (const s of stated) if (!cov.some((c) => c.source === s?.source)) covBad.push(`${s?.source} is not an export source`);
	add("coverage", covBad.length === 0, covBad.join("; ") || `${cov.length} sources match the exports`);

	const dups = duplicateGroups(data);
	const clusters = Array.isArray(doc?.clusters) ? doc.clusters : [];
	const uncl = dups.filter((g) => !clusters.some((cl) => Array.isArray(cl?.posts) && g.every((id) => cl.posts.includes(id))));
	add("reposts_clustered", uncl.length === 0, uncl.length ? `duplicate groups not clustered together: ${uncl.map((g) => g.join("=")).join("; ")}` : `${dups.length} repost group(s) clustered`);

	const amb = ambiguousPosts(data);
	const unresolved = Array.isArray(doc?.unresolved_mentions) ? doc.unresolved_mentions : [];
	const listed = new Set(unresolved.flatMap((u) => (Array.isArray(u?.posts) ? u.posts : [])));
	const notListed = amb.filter((id) => !listed.has(id));
	add("ambiguous_unresolved", notListed.length === 0 && unresolved.every((u) => typeof u?.mention === "string" && u.mention.trim() && typeof u?.reason === "string" && u.reason.trim()), notListed.length ? `ambiguous mentions not in unresolved_mentions: ${notListed.join(", ")}` : `${amb.length} ambiguous post(s) reported unresolved with mention and reason`);

	const unknown = cands.filter((c) => !data.tickers.has(c?.ticker)).map((c) => c?.ticker);
	add("no_unknown_tickers", unknown.length === 0, unknown.length ? `tickers outside the master: ${unknown.join(", ")}` : "every candidate ticker is in tickers.csv");

	const ambSet = new Set(amb);
	for (const c of cands) {
		const bad = checkCandidate(data, c, { investigation: investigations.get(c?.id) ?? null, duplicates: dups, ambiguous: ambSet });
		add(`candidate ${c?.id ?? "?"}`, bad.length === 0, bad.join("; ") || "verified");
		details.push({ id: c?.id, reproduced: bad.length === 0, claim: c?.claim, ticker: c?.ticker, supporting: (c?.supporting_sources ?? []).length, opposing: (c?.opposing ?? []).length });
	}
	add("limitations", Array.isArray(doc?.limitations) && doc.limitations.length > 0 && doc.limitations.every((x) => typeof x === "string" && x.trim()), Array.isArray(doc?.limitations) ? `${doc.limitations.length} limitation(s)` : "missing");
	return { checks, details };
}

export function loadInvestigations(ws, doc) {
	const out = new Map();
	for (const c of Array.isArray(doc?.candidates) ? doc.candidates : []) {
		if (typeof c?.id !== "string") continue;
		try {
			out.set(c.id, JSON.parse(fs.readFileSync(path.join(ws, "src", "investigations", `${c.id}.json`), "utf8")));
		} catch {
			out.set(c.id, null);
		}
	}
	return out;
}
