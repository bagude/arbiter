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
