// Reference for `raid-ai`: smarter targeting and skill choice for side A, a battle
// runner that uses them, and a seeded win-rate estimator.
import { affinityMod, availableSkills, chooseSkill, chooseTarget, effectiveStat, mulberry32, nextActor, rollHit, tickEffects } from "./raid.mjs";

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Prefer an enemy the actor is strong against (mod 1.25), then the lowest hp, then the lowest index; -1 if none alive. */
export function chooseTargetSmart(actor, enemies) {
	if (!isObj(actor) || typeof actor.affinity !== "string") throw inv("actor must be a unit with an affinity");
	if (!Array.isArray(enemies)) throw inv("enemies must be an array");
	let best = -1;
	let bestKey = null;
	enemies.forEach((e, i) => {
		if (!isObj(e) || typeof e.hp !== "number" || typeof e.affinity !== "string") throw inv(`enemies[${i}] must be a unit with hp and affinity`);
		if (e.hp <= 0) return;
		const key = [affinityMod(actor.affinity, e.affinity) >= 1.25 ? 0 : 1, e.hp];
		if (best < 0 || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
			best = i;
			bestKey = key;
		}
	});
	return best;
}

/**
 * Score each available skill: damaging skills score multiplier × (targets it would hit);
 * a pure-effect skill scores 1.5 when the actor has no active effect on that skill's
 * first effect stat, else -1. Highest score wins; ties go to the higher index.
 */
export function chooseSkillSmart(actor, aliveEnemies) {
	if (!isObj(actor) || !Array.isArray(actor.skills)) throw inv("actor must be a unit with skills");
	if (!isInt(aliveEnemies) || aliveEnemies < 0) throw inv("aliveEnemies must be an integer >= 0");
	const avail = availableSkills(actor);
	let best = -1;
	let bestScore = -Infinity;
	for (const i of avail) {
		const s = actor.skills[i];
		let score;
		if (s.multiplier > 0) score = s.multiplier * (s.target === "allEnemies" ? aliveEnemies : 1);
		else {
			const stat = s.effects?.[0]?.stat;
			const active = (actor.effects ?? []).some((e) => e.stat === stat);
			score = active ? -1 : 1.5;
		}
		if (score >= bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return best;
}

export function scoreSkills(actor, aliveEnemies) {
	if (!isObj(actor) || !Array.isArray(actor.skills)) throw inv("actor must be a unit with skills");
	if (!isInt(aliveEnemies) || aliveEnemies < 0) throw inv("aliveEnemies must be an integer >= 0");
	return availableSkills(actor).map((i) => {
		const s = actor.skills[i];
		if (s.multiplier > 0) return { skill: i, score: s.multiplier * (s.target === "allEnemies" ? aliveEnemies : 1) };
		const stat = s.effects?.[0]?.stat;
		return { skill: i, score: (actor.effects ?? []).some((e) => e.stat === stat) ? -1 : 1.5 };
	});
}

const cloneChampion = (c) => ({ ...c, base: { ...c.base }, stats: { ...c.stats }, skills: c.skills.map((s) => ({ ...s, effects: (s.effects ?? []).map((e) => ({ ...e })) })) });
function toUnit(c, side, at) {
	if (!isObj(c) || !isObj(c.stats) || !Array.isArray(c.skills) || typeof c.hp !== "number") throw inv(`${at} must be a champion`);
	return { ...cloneChampion(c), side, hp: c.hp, tm: 0, effects: [], cooldowns: {} };
}
const sideAlive = (units, side) => units.some((u) => u.side === side && u.hp > 0);

/** runBattle with side 0 using the smart choosers and side 1 the basic ones. Same log shape, same rng discipline. */
export function runBattleSmart(teamA, teamB, seed, maxTurns = 100) {
	if (!Array.isArray(teamA) || teamA.length === 0) throw inv("teamA must be a non-empty array");
	if (!Array.isArray(teamB) || teamB.length === 0) throw inv("teamB must be a non-empty array");
	if (!isInt(seed)) throw inv("seed must be an integer");
	if (!isInt(maxTurns) || maxTurns < 1) throw inv("maxTurns must be an integer >= 1");
	let units = [...teamA.map((c, i) => toUnit(c, 0, `teamA[${i}]`)), ...teamB.map((c, i) => toUnit(c, 1, `teamB[${i}]`))];
	const rng = mulberry32(seed);
	const log = [];
	const winner = () => (!sideAlive(units, 0) ? "B" : !sideAlive(units, 1) ? "A" : null);
	for (let turn = 1; turn <= maxTurns; turn++) {
		if (winner()) break;
		const na = nextActor(units.map((u) => ({ spd: effectiveStat(u, "spd"), tm: u.tm, hp: u.hp })));
		units = units.map((u, i) => ({ ...u, tm: na.units[i].tm }));
		const ai = na.index;
		let actor = units[ai];
		const cooldowns = {};
		for (const k of Object.keys(actor.cooldowns)) cooldowns[k] = Math.max(0, actor.cooldowns[k] - 1);
		actor = { ...actor, cooldowns };
		units[ai] = actor;
		const enemies = units.map((u, i) => (u.side !== actor.side ? i : -1)).filter((i) => i >= 0);
		const allies = units.map((u, i) => (u.side === actor.side ? i : -1)).filter((i) => i >= 0);
		const aliveEnemies = enemies.filter((i) => units[i].hp > 0).length;
		const smart = actor.side === 0;
		const si = smart ? chooseSkillSmart(actor, aliveEnemies) : chooseSkill(actor);
		const skill = actor.skills[si];
		let targets;
		if (skill.target === "enemy") {
			const list = enemies.map((i) => units[i]);
			const t = smart ? chooseTargetSmart(actor, list) : chooseTarget(list);
			targets = t < 0 ? [] : [enemies[t]];
		} else if (skill.target === "allEnemies") targets = enemies.filter((i) => units[i].hp > 0);
		else if (skill.target === "self") targets = [ai];
		else targets = allies.filter((i) => units[i].hp > 0);
		const hits = [];
		for (const t of targets) {
			let target = units[t];
			if (skill.multiplier > 0) {
				const { damage, crit } = rollHit(actor, target, skill, rng);
				const hp = Math.max(0, target.hp - damage);
				hits.push({ target: t, damage, crit, killed: target.hp > 0 && hp === 0 });
				target = { ...target, hp };
			}
			if (target.hp > 0 && skill.effects.length) target = { ...target, effects: [...target.effects, ...skill.effects.map((e) => ({ ...e }))] };
			units[t] = target;
			if (t === ai) actor = target;
		}
		actor = { ...actor, cooldowns: { ...actor.cooldowns, ...(skill.cooldown > 0 ? { [si]: skill.cooldown } : {}) } };
		actor = tickEffects(actor);
		units[ai] = actor;
		log.push({ turn, actor: ai, skill: si, hits });
	}
	return { winner: winner() ?? "draw", turns: log.length, log, units };
}

/** Wins for side A over the given seeds, with `runner` (default runBattleSmart). */
export function winRate(teamA, teamB, seeds, runner = runBattleSmart) {
	if (!Array.isArray(seeds) || seeds.length === 0 || !seeds.every(isInt)) throw inv("seeds must be a non-empty array of integers");
	if (typeof runner !== "function") throw inv("runner must be a function");
	let wins = 0;
	let draws = 0;
	let turns = 0;
	for (const s of seeds) {
		const b = runner(teamA, teamB, s);
		if (b.winner === "A") wins++;
		else if (b.winner === "draw") draws++;
		turns += b.turns;
	}
	return { wins, draws, total: seeds.length, rate: wins / seeds.length, avgTurns: turns / seeds.length };
}
