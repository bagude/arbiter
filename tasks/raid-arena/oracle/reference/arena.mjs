// Reference for `raid-arena`: star ratings, an energy-budgeted campaign runner, and
// a deterministic best-team search over a roster.
import { resolveStage } from "./raid.mjs";

export const ENERGY_PER_STAGE = 4;
export const MAX_STAGE = 12;

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validateChampion(c, at) {
	if (!isObj(c) || !isObj(c.stats) || !isInt(c.level) || !Array.isArray(c.skills)) throw inv(`${at} must be a champion`);
}
const cloneChampion = (c) => ({ ...c, base: { ...c.base }, stats: { ...c.stats }, skills: c.skills.map((s) => ({ ...s, effects: (s.effects ?? []).map((e) => ({ ...e })) })) });

/** 0 for a loss; otherwise 3 with no deaths on side 0, 2 with one death, 1 with more. */
export function stars(battle) {
	if (!isObj(battle) || !Array.isArray(battle.units) || typeof battle.winner !== "string") throw inv("battle must be a runBattle result");
	if (battle.winner !== "A") return 0;
	const dead = battle.units.filter((u) => u.side === 0 && u.hp <= 0).length;
	return dead === 0 ? 3 : dead === 1 ? 2 : 1;
}

/**
 * Clears stages in order from `startStage` while energy lasts; every stage uses the
 * seed `seed + stage`; a loss ends the run; winning carries the levelled team forward.
 */
export function runCampaign(team, seed, energy, startStage = 1) {
	if (!Array.isArray(team) || team.length === 0) throw inv("team must be a non-empty array");
	team.forEach((c, i) => validateChampion(c, `team[${i}]`));
	if (!isInt(seed)) throw inv("seed must be an integer");
	if (!isInt(energy) || energy < 0) throw inv("energy must be an integer >= 0");
	if (!isInt(startStage) || startStage < 1 || startStage > MAX_STAGE) throw inv(`startStage must be an integer in 1..${MAX_STAGE}`);
	let current = team.map(cloneChampion);
	let stage = startStage;
	let left = energy;
	let silver = 0;
	let xp = 0;
	const log = [];
	let stopped = null;
	while (true) {
		if (stage > MAX_STAGE) {
			stopped = "complete";
			break;
		}
		if (left < ENERGY_PER_STAGE) {
			stopped = "energy";
			break;
		}
		left -= ENERGY_PER_STAGE;
		const r = resolveStage(current, stage, seed + stage);
		const s = stars(r.battle);
		log.push({ stage, won: r.won, stars: s, turns: r.battle.turns, rewards: r.rewards });
		if (!r.won) {
			stopped = "loss";
			break;
		}
		silver += r.rewards.silver;
		xp += r.rewards.xp;
		current = r.team;
		stage++;
	}
	return { stagesCleared: log.filter((e) => e.won).length, nextStage: stage, log, team: current, silver, xp, energyLeft: left, stopped };
}

/** Every k-combination of indexes 0..n-1 in lexicographic order. */
export function combinations(n, k) {
	if (!isInt(n) || n < 0) throw inv("n must be an integer >= 0");
	if (!isInt(k) || k < 0) throw inv("k must be an integer >= 0");
	const out = [];
	const cur = [];
	const rec = (start) => {
		if (cur.length === k) {
			out.push([...cur]);
			return;
		}
		for (let i = start; i <= n - (k - cur.length); i++) {
			cur.push(i);
			rec(i + 1);
			cur.pop();
		}
	};
	rec(0);
	return out;
}

/**
 * The team of `size` champions from `roster` that clears `stage` with the fewest
 * turns (then most stars, then earliest combination). `null` when no team wins.
 */
export function bestTeam(roster, size, stage, seed) {
	if (!Array.isArray(roster) || roster.length === 0) throw inv("roster must be a non-empty array");
	roster.forEach((c, i) => validateChampion(c, `roster[${i}]`));
	if (!isInt(size) || size < 1 || size > roster.length) throw inv("size must be an integer in 1..roster.length");
	if (!isInt(stage) || stage < 1) throw inv("stage must be an integer >= 1");
	if (!isInt(seed)) throw inv("seed must be an integer");
	let best = null;
	const tried = [];
	for (const idx of combinations(roster.length, size)) {
		const r = resolveStage(idx.map((i) => roster[i]), stage, seed);
		const s = stars(r.battle);
		tried.push({ indexes: idx, won: r.won, stars: s, turns: r.battle.turns });
		if (!r.won) continue;
		if (best === null || r.battle.turns < best.turns || (r.battle.turns === best.turns && s > best.stars)) best = { indexes: idx, turns: r.battle.turns, stars: s };
	}
	return { best, tried };
}

