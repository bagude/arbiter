// A campaign is data: phases run in order, each a run config repeated for up to
// `rounds` rounds, with a novelty brake and an optional token budget. Validated the
// way lib/config.mjs validates a run config — unknown keys are errors and every config
// path must exist — so a hand-edited or model-authored campaign fails at load, not two
// hours in. Every decision the driver makes lives here so it can be tested without
// spawning a supervisor.
import fs from "node:fs";
import path from "node:path";
import { findingsOf } from "./memory.mjs";

// The deliverable names supervisor.mjs retention looks for, in the same order.
export const DELIVERABLES = ["exploration.json", "study.json", "report.json", "watchlist.json"];
const NAME = /^[\w.-]+$/;
const BRAKE_DEFAULTS = { minNovelty: 0.5, sameTitle: 0.4 };

export function loadCampaign(file, { root }) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`campaign ${file}: ${err.message}`);
	}
	return validateCampaign(raw, { root, file });
}

export function validateCampaign(raw, { root, file = "(inline)" }) {
	const where = `campaign ${file}`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
	for (const k of Object.keys(raw)) if (!["name", "phases", "brake", "budget", "_note"].includes(k)) throw new Error(`${where}: unknown key "${k}"`);
	if (typeof raw.name !== "string" || !NAME.test(raw.name)) throw new Error(`${where}: name must match ${NAME}`);
	if (!Array.isArray(raw.phases) || !raw.phases.length) throw new Error(`${where}: phases must be a non-empty list`);
	const phases = raw.phases.map((p, i) => {
		const at = `${where}: phases[${i}]`;
		if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at}: not an object`);
		for (const k of Object.keys(p)) if (!["phase", "config", "rounds", "file"].includes(k)) throw new Error(`${at}: unknown key "${k}"`);
		if (typeof p.phase !== "string" || !NAME.test(p.phase)) throw new Error(`${at}: phase must match ${NAME}`);
		if (typeof p.config !== "string" || !fs.existsSync(path.resolve(root, p.config))) throw new Error(`${at}: config "${p.config}" not found under ${root}`);
		if (!Number.isInteger(p.rounds) || p.rounds < 1) throw new Error(`${at}: rounds must be an integer >= 1`);
		if (p.file != null && !DELIVERABLES.includes(p.file)) throw new Error(`${at}: file must be one of ${DELIVERABLES.join(", ")}`);
		return { phase: p.phase, config: p.config, rounds: p.rounds, file: p.file ?? null };
	});
	const dup = phases.map((p) => p.phase).find((n, i, a) => a.indexOf(n) !== i);
	if (dup) throw new Error(`${where}: phase "${dup}" appears twice`);
	const brake = { ...BRAKE_DEFAULTS };
	if (raw.brake != null) {
		if (typeof raw.brake !== "object" || Array.isArray(raw.brake)) throw new Error(`${where}: brake must be an object`);
		for (const k of Object.keys(raw.brake)) {
			if (!(k in BRAKE_DEFAULTS)) throw new Error(`${where}: unknown brake key "${k}"`);
			const v = Number(raw.brake[k]);
			if (!(v >= 0 && v <= 1)) throw new Error(`${where}: brake.${k} must be between 0 and 1`);
			brake[k] = v;
		}
	}
	let budget = null;
	if (raw.budget != null) {
		if (typeof raw.budget !== "object" || Array.isArray(raw.budget)) throw new Error(`${where}: budget must be an object`);
		for (const k of Object.keys(raw.budget)) if (k !== "tokens") throw new Error(`${where}: unknown budget key "${k}" (only tokens)`);
		if (!Number.isInteger(raw.budget.tokens) || raw.budget.tokens < 1) throw new Error(`${where}: budget.tokens must be an integer >= 1`);
		budget = { tokens: raw.budget.tokens };
	}
	return { name: raw.name, phases, brake, budget };
}

/**
 * `node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]`
 * — the form every campaign report before 2026-09-14 was produced with. Returns null
 * when the first argument is a campaign file (the new form) or is missing.
 */
export function legacyCampaign(argv, { root }) {
	const [name, config] = argv;
	if (!name || !config || name.endsWith(".json")) return null;
	const opt = (flag, dflt) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? Number(argv[i + 1]) : dflt;
	};
	return validateCampaign(
		{ name, phases: [{ phase: "explore", config, rounds: opt("--rounds", 3), file: "exploration.json" }], brake: { minNovelty: opt("--min-novelty", 0.5), sameTitle: opt("--same-title", 0.4) } },
		{ root, file: "(legacy args)" },
	);
}

export function median(nums) {
	const s = [...nums].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!s.length) return null;
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Whether the next round runs. No budget: always. Otherwise skip when nothing is left,
 * or when what is left is below the median cost of the rounds already run — a round
 * that would be starved fails its oracle and leaves a partial episode in memory; a
 * round that is skipped leaves nothing, and the report says why. `remaining` is what
 * the round that does run gets as its own caps.tokens.
 */
export function decideRound({ budgetTokens = null, spentTokens = 0, roundTokens = [] } = {}) {
	if (budgetTokens == null) return { run: true, remaining: null, reason: null };
	const remaining = Math.max(0, budgetTokens - spentTokens);
	if (remaining <= 0) return { run: false, remaining, reason: `budget exhausted (${spentTokens} of ${budgetTokens} tokens spent)` };
	const med = median(roundTokens);
	if (med !== null && remaining < med) return { run: false, remaining, reason: `remaining ${remaining} tokens below the median round (${med})` };
	return { run: true, remaining, reason: null };
}

// Novelty is judged on three signals, any of which marks a finding as already found:
// the same normalised query was run before; the result rows are identical to an
// earlier finding's (the same fact in other words — titles paraphrase, rows do not);
// or the title is similar (Jaccard on content words; 0.4 not 0.5 — at 0.5 paraphrases
// passed as novel in campaign explore-2).
const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be", "are", "than", "no", "not", "only"]);
const tokens = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9_.%-]+/).filter((t) => t.length > 1 && !STOP.has(t)));
export function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}
const normSql = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
const fingerprint = (rows) => JSON.stringify(rows ?? []);

/** findingsOf() plus each observation's query and result rows, which the tally needs and the retention shape drops. */
export function findingsWithRows(doc) {
	return findingsOf(doc).map((o, i) => ({ ...o, title: String(o.title ?? ""), query: doc?.observations?.[i]?.query, result: doc?.observations?.[i]?.result }));
}

export function noveltyTally({ sameTitle = 0.4 } = {}) {
	const seen = { queries: new Set(), results: new Set(), titles: [] };
	return {
		absorb(findings) {
			let n = 0;
			for (const o of Array.isArray(findings) ? findings : []) {
				if (!o || typeof o !== "object") continue;
				if (o.query) seen.queries.add(normSql(o.query));
				if (Array.isArray(o.result) && o.result.length) seen.results.add(fingerprint(o.result));
				seen.titles.push(tokens(o.title));
				n++;
			}
			return n;
		},
		absorbTitles(titles) {
			for (const t of titles) seen.titles.push(tokens(t));
			return titles.length;
		},
		isKnown(o) {
			if (o?.query && seen.queries.has(normSql(o.query))) return "same query";
			if (Array.isArray(o?.result) && o.result.length && seen.results.has(fingerprint(o.result))) return "same result";
			if (seen.titles.some((prev) => jaccard(tokens(o?.title), prev) >= sameTitle)) return "similar title";
			return null;
		},
		size() {
			return seen.titles.length;
		},
	};
}

/**
 * Seed the tally from every earlier run's deliverable for the campaign's tasks (a
 * seed-data exploration must not brake a real-data one, so tasks are matched exactly)
 * and from the semantic record titles in its memory scopes (runs whose directories
 * are gone). The legacy "Findings digest" blobs are not parsed: migrateDigests()
 * already turned them into semantic records.
 */
export function seedTally(tally, { runsDir, memoryLog, tasks, scopes }) {
	let runs = 0;
	let findings = 0;
	let fromMemory = 0;
	const readJson = (p) => {
		try {
			return JSON.parse(fs.readFileSync(p, "utf8"));
		} catch {
			return null;
		}
	};
	for (const d of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
		if (!/^\d{4}-/.test(d)) continue;
		const s = readJson(path.join(runsDir, d, "summary.json"));
		if (!s || !tasks.includes(s.task)) continue;
		for (const name of DELIVERABLES) {
			const doc = readJson(path.join(runsDir, d, "ws-builder", "src", name));
			if (!doc) continue;
			runs++;
			findings += tally.absorb(findingsWithRows(doc));
			break;
		}
	}
	if (fs.existsSync(memoryLog)) {
		for (const line of fs.readFileSync(memoryLog, "utf8").split("\n")) {
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (!r || r.op || !scopes.includes(r.scope) || r.kind !== "semantic" || !r.summary) continue;
			fromMemory += tally.absorbTitles([r.summary]);
		}
	}
	return { runs, findings, fromMemory };
}
