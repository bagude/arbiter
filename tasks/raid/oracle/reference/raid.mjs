// Reference implementation of the `raid` task: a turn-based squad RPG core
// (seeded RNG, champions and levelling, affinity damage, a speed-driven turn
// meter, buffs/debuffs and cooldowns, a deterministic battle, summoning and a
// campaign). Pure: nothing mutates its inputs; every result is freshly allocated.

export const AFFINITIES = ["magic", "force", "spirit", "void"];
export const RARITIES = ["common", "rare", "epic", "legendary"];
export const TARGETS = ["enemy", "allEnemies", "self", "allAllies"];
export const EFFECT_STATS = ["atk", "def", "spd"];
export const MAX_LEVEL = 60;

export const SAMPLE_CHAMPIONS = {
	kael: {
		id: "kael", name: "Kael the Ember", affinity: "force", rarity: "epic",
		base: { hp: 1500, atk: 130, def: 90, spd: 104, crit: 0.3, critDmg: 1.6 },
		skills: [
			{ name: "Cinder Cut", multiplier: 1.0, cooldown: 0, target: "enemy" },
			{ name: "Flame Wall", multiplier: 0.7, cooldown: 3, target: "allEnemies" },
			{ name: "Ignite", multiplier: 1.8, cooldown: 4, target: "enemy", effects: [{ stat: "def", pct: -30, turns: 2 }] },
		],
	},
	vell: {
		id: "vell", name: "Sister Vell", affinity: "spirit", rarity: "rare",
		base: { hp: 1250, atk: 95, def: 120, spd: 98, crit: 0.15, critDmg: 1.5 },
		skills: [
			{ name: "Censer Strike", multiplier: 1.0, cooldown: 0, target: "enemy" },
			{ name: "Litany", multiplier: 0, cooldown: 3, target: "allAllies", effects: [{ stat: "atk", pct: 25, turns: 2 }] },
		],
	},
	grim: {
		id: "grim", name: "Grimjaw", affinity: "magic", rarity: "rare",
		base: { hp: 1800, atk: 110, def: 100, spd: 91, crit: 0.2, critDmg: 1.5 },
		skills: [
			{ name: "Maul", multiplier: 1.1, cooldown: 0, target: "enemy" },
			{ name: "Bellow", multiplier: 0, cooldown: 4, target: "self", effects: [{ stat: "def", pct: 40, turns: 3 }] },
		],
	},
	nyx: {
		id: "nyx", name: "Nyx of the Hollow", affinity: "void", rarity: "legendary",
		base: { hp: 1400, atk: 150, def: 85, spd: 110, crit: 0.35, critDmg: 1.7 },
		skills: [
			{ name: "Shade Lash", multiplier: 1.0, cooldown: 0, target: "enemy" },
			{ name: "Hollow Step", multiplier: 0, cooldown: 4, target: "self", effects: [{ stat: "spd", pct: 30, turns: 2 }] },
			{ name: "Oblivion", multiplier: 2.2, cooldown: 5, target: "enemy" },
		],
	},
};

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------- stage 1: rng, champions, levelling ----------

export function mulberry32(seed) {
	if (!isInt(seed)) throw inv("seed must be an integer");
	let a = seed | 0;
	return function next() {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function validateEffect(e, at) {
	if (!isObj(e)) throw inv(`${at} must be an object`);
	if (!EFFECT_STATS.includes(e.stat)) throw inv(`${at}.stat must be one of ${EFFECT_STATS.join(", ")}`);
	if (!isInt(e.pct)) throw inv(`${at}.pct must be an integer percent`);
	if (!isInt(e.turns) || e.turns < 1) throw inv(`${at}.turns must be an integer >= 1`);
	return { stat: e.stat, pct: e.pct, turns: e.turns };
}

function validateSkill(s, i) {
	const at = `skills[${i}]`;
	if (!isObj(s)) throw inv(`${at} must be an object`);
	if (!isStr(s.name)) throw inv(`${at}.name must be a non-empty string`);
	if (!isNum(s.multiplier) || s.multiplier < 0) throw inv(`${at}.multiplier must be a finite number >= 0`);
	if (!isInt(s.cooldown) || s.cooldown < 0) throw inv(`${at}.cooldown must be an integer >= 0`);
	if (i === 0 && s.cooldown !== 0) throw inv("skills[0].cooldown must be 0");
	if (!TARGETS.includes(s.target)) throw inv(`${at}.target must be one of ${TARGETS.join(", ")}`);
	const effects = s.effects === undefined ? [] : s.effects;
	if (!Array.isArray(effects)) throw inv(`${at}.effects must be an array`);
	return { name: s.name, multiplier: s.multiplier, cooldown: s.cooldown, target: s.target, effects: effects.map((e, j) => validateEffect(e, `${at}.effects[${j}]`)) };
}

export function validateDef(def) {
	if (!isObj(def)) throw inv("champion def must be an object");
	if (!isStr(def.id)) throw inv("id must be a non-empty string");
	if (!isStr(def.name)) throw inv("name must be a non-empty string");
	if (!AFFINITIES.includes(def.affinity)) throw inv(`affinity must be one of ${AFFINITIES.join(", ")}`);
	if (!RARITIES.includes(def.rarity)) throw inv(`rarity must be one of ${RARITIES.join(", ")}`);
	const b = def.base;
	if (!isObj(b)) throw inv("base must be an object");
	for (const k of ["hp", "atk", "spd"]) if (!isInt(b[k]) || b[k] < 1) throw inv(`base.${k} must be an integer >= 1`);
	if (!isInt(b.def) || b.def < 0) throw inv("base.def must be an integer >= 0");
	if (!isNum(b.crit) || b.crit < 0 || b.crit > 1) throw inv("base.crit must be a number in [0, 1]");
	if (!isNum(b.critDmg) || b.critDmg < 1) throw inv("base.critDmg must be a number >= 1");
	if (!Array.isArray(def.skills) || def.skills.length === 0) throw inv("skills must be a non-empty array");
	return {
		id: def.id, name: def.name, affinity: def.affinity, rarity: def.rarity,
		base: { hp: b.hp, atk: b.atk, def: b.def, spd: b.spd, crit: b.crit, critDmg: b.critDmg },
		skills: def.skills.map(validateSkill),
	};
}

export function statsAt(base, level) {
	if (!isObj(base)) throw inv("base must be an object");
	for (const k of ["hp", "atk", "spd"]) if (!isInt(base[k]) || base[k] < 1) throw inv(`base.${k} must be an integer >= 1`);
	if (!isInt(base.def) || base.def < 0) throw inv("base.def must be an integer >= 0");
	if (!isNum(base.crit) || base.crit < 0 || base.crit > 1) throw inv("base.crit must be a number in [0, 1]");
	if (!isNum(base.critDmg) || base.critDmg < 1) throw inv("base.critDmg must be a number >= 1");
	if (!isInt(level) || level < 1 || level > MAX_LEVEL) throw inv(`level must be an integer in 1..${MAX_LEVEL}`);
	const g = 100 + 4 * (level - 1);
	return {
		hp: Math.floor((base.hp * g) / 100),
		atk: Math.floor((base.atk * g) / 100),
		def: Math.floor((base.def * g) / 100),
		spd: base.spd,
		crit: base.crit,
		critDmg: base.critDmg,
	};
}

export function makeChampion(def, level = 1) {
	const d = validateDef(def);
	const stats = statsAt(d.base, level);
	return { ...d, level, xp: 0, stats, hp: stats.hp };
}

export function xpForLevel(level) {
	if (!isInt(level) || level < 1 || level > MAX_LEVEL) throw inv(`level must be an integer in 1..${MAX_LEVEL}`);
	if (level === MAX_LEVEL) throw new RangeError("max level: no further level to reach");
	return 25 * level * level;
}

function validateChampion(c) {
	if (!isObj(c)) throw inv("champion must be an object");
	if (!isInt(c.level) || c.level < 1 || c.level > MAX_LEVEL) throw inv("champion.level must be an integer in 1..60");
	if (!isInt(c.xp) || c.xp < 0) throw inv("champion.xp must be an integer >= 0");
	if (!isObj(c.stats) || !isInt(c.stats.hp)) throw inv("champion.stats must be an object with integer hp");
	if (!isNum(c.hp) || c.hp < 0) throw inv("champion.hp must be a number >= 0");
	if (!isObj(c.base)) throw inv("champion.base must be an object");
	if (!Array.isArray(c.skills) || c.skills.length === 0) throw inv("champion.skills must be a non-empty array");
	if (!AFFINITIES.includes(c.affinity)) throw inv("champion.affinity is invalid");
}

export function addXp(champion, xp) {
	validateChampion(champion);
	if (!isInt(xp) || xp < 0) throw inv("xp must be an integer >= 0");
	let level = champion.level;
	let pool = champion.xp + xp;
	while (level < MAX_LEVEL && pool >= xpForLevel(level)) {
		pool -= xpForLevel(level);
		level++;
	}
	if (level === MAX_LEVEL) pool = 0;
	const stats = level === champion.level ? { ...champion.stats } : statsAt(champion.base, level);
	return { ...cloneChampion(champion), level, xp: pool, stats, hp: level === champion.level ? champion.hp : stats.hp };
}

function cloneChampion(c) {
	return {
		...c,
		base: { ...c.base },
		stats: { ...c.stats },
		skills: c.skills.map((s) => ({ ...s, effects: (s.effects ?? []).map((e) => ({ ...e })) })),
		...(c.effects ? { effects: c.effects.map((e) => ({ ...e })) } : {}),
		...(c.cooldowns ? { cooldowns: { ...c.cooldowns } } : {}),
	};
}

// ---------- stage 2: damage ----------

export function affinityMod(attacker, defender) {
	if (!AFFINITIES.includes(attacker)) throw inv("attacker affinity is invalid");
	if (!AFFINITIES.includes(defender)) throw inv("defender affinity is invalid");
	if (attacker === "void" || defender === "void" || attacker === defender) return 1;
	const beats = { magic: "spirit", spirit: "force", force: "magic" };
	if (beats[attacker] === defender) return 1.25;
	return 0.8;
}

export function mitigation(def) {
	if (!isInt(def) || def < 0) throw inv("def must be an integer >= 0");
	return 1000 / (1000 + def);
}

export function computeDamage({ atk, def, multiplier, mod = 1, crit = false, critDmg = 1.5 } = {}) {
	if (!isInt(atk) || atk < 1) throw inv("atk must be an integer >= 1");
	if (!isInt(def) || def < 0) throw inv("def must be an integer >= 0");
	if (!isNum(multiplier) || multiplier < 0) throw inv("multiplier must be a finite number >= 0");
	if (!isNum(mod) || mod <= 0) throw inv("mod must be a finite number > 0");
	if (typeof crit !== "boolean") throw inv("crit must be a boolean");
	if (!isNum(critDmg) || critDmg < 1) throw inv("critDmg must be a number >= 1");
	let x = atk * multiplier;
	x = x * mod;
	x = (x * 1000) / (1000 + def);
	if (crit) x = x * critDmg;
	return Math.max(1, Math.floor(x));
}

// ---------- stage 3: turn meter ----------

export function nextActor(units) {
	if (!Array.isArray(units) || units.length === 0) throw inv("units must be a non-empty array");
	units.forEach((u, i) => {
		if (!isObj(u)) throw inv(`units[${i}] must be an object`);
		if (!isNum(u.spd) || u.spd <= 0) throw inv(`units[${i}].spd must be a finite number > 0`);
		if (!isNum(u.tm) || u.tm < 0) throw inv(`units[${i}].tm must be a finite number >= 0`);
		if (!isNum(u.hp) || u.hp < 0) throw inv(`units[${i}].hp must be a finite number >= 0`);
	});
	let index = -1;
	let dt = Infinity;
	units.forEach((u, i) => {
		if (u.hp <= 0) return;
		const t = (100 - u.tm) / u.spd;
		if (t < dt) {
			dt = t;
			index = i;
		}
	});
	if (index < 0) throw new RangeError("no living units");
	const next = units.map((u, i) => {
		if (u.hp <= 0) return { ...u };
		return { ...u, tm: i === index ? 0 : u.tm + u.spd * dt };
	});
	return { index, elapsed: dt, units: next };
}

// ---------- stage 4: effects, cooldowns, AI ----------

export function effectiveStat(unit, stat) {
	if (!isObj(unit) || !isObj(unit.stats)) throw inv("unit must be an object with stats");
	if (!EFFECT_STATS.includes(stat)) throw inv(`stat must be one of ${EFFECT_STATS.join(", ")}`);
	const base = unit.stats[stat];
	if (!isInt(base)) throw inv(`unit.stats.${stat} must be an integer`);
	const effects = unit.effects ?? [];
	if (!Array.isArray(effects)) throw inv("unit.effects must be an array");
	let sum = 0;
	for (const e of effects) if (e.stat === stat) sum += e.pct;
	return Math.max(1, Math.floor((base * (100 + sum)) / 100));
}

export function tickEffects(unit) {
	if (!isObj(unit)) throw inv("unit must be an object");
	const effects = unit.effects ?? [];
	if (!Array.isArray(effects)) throw inv("unit.effects must be an array");
	return { ...unit, effects: effects.map((e) => ({ ...e, turns: e.turns - 1 })).filter((e) => e.turns > 0) };
}

export function availableSkills(unit) {
	if (!isObj(unit) || !Array.isArray(unit.skills) || unit.skills.length === 0) throw inv("unit must have a non-empty skills array");
	const cd = unit.cooldowns ?? {};
	return unit.skills.map((_, i) => i).filter((i) => (cd[i] ?? 0) === 0);
}

export function chooseSkill(unit) {
	const a = availableSkills(unit);
	return a[a.length - 1];
}

export function chooseTarget(units) {
	if (!Array.isArray(units)) throw inv("units must be an array");
	let best = -1;
	units.forEach((u, i) => {
		if (!isObj(u) || !isNum(u.hp)) throw inv(`units[${i}] must be an object with numeric hp`);
		if (u.hp <= 0) return;
		if (best < 0 || u.hp < units[best].hp) best = i;
	});
	return best;
}

export function rollHit(attacker, defender, skill, rng) {
	if (!isObj(attacker) || !isObj(attacker.stats)) throw inv("attacker must be a unit with stats");
	if (!isObj(defender) || !isObj(defender.stats)) throw inv("defender must be a unit with stats");
	if (!isObj(skill) || !isNum(skill.multiplier)) throw inv("skill must have a numeric multiplier");
	if (typeof rng !== "function") throw inv("rng must be a function");
	const roll = rng();
	const crit = roll < attacker.stats.crit;
	const damage = computeDamage({
		atk: effectiveStat(attacker, "atk"),
		def: effectiveStat(defender, "def"),
		multiplier: skill.multiplier,
		mod: affinityMod(attacker.affinity, defender.affinity),
		crit,
		critDmg: attacker.stats.critDmg,
	});
	return { damage, crit, roll };
}

// ---------- stage 5: battle ----------

function toUnit(c, side) {
	validateChampion(c);
	return { ...cloneChampion(c), side, hp: c.hp, tm: 0, effects: [], cooldowns: {} };
}

const sideAlive = (units, side) => units.some((u) => u.side === side && u.hp > 0);

export function runBattle(teamA, teamB, seed, maxTurns = 100) {
	if (!Array.isArray(teamA) || teamA.length === 0) throw inv("teamA must be a non-empty array");
	if (!Array.isArray(teamB) || teamB.length === 0) throw inv("teamB must be a non-empty array");
	if (!isInt(seed)) throw inv("seed must be an integer");
	if (!isInt(maxTurns) || maxTurns < 1) throw inv("maxTurns must be an integer >= 1");
	let units = [...teamA.map((c) => toUnit(c, 0)), ...teamB.map((c) => toUnit(c, 1))];
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
		const si = chooseSkill(actor);
		const skill = actor.skills[si];
		const enemies = units.map((u, i) => (u.side !== actor.side ? i : -1)).filter((i) => i >= 0);
		const allies = units.map((u, i) => (u.side === actor.side ? i : -1)).filter((i) => i >= 0);
		let targets;
		if (skill.target === "enemy") {
			const t = chooseTarget(enemies.map((i) => units[i]));
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

// ---------- stage 6: summoning and campaign ----------

export function summon(rng, pool) {
	if (typeof rng !== "function") throw inv("rng must be a function");
	if (!isObj(pool)) throw inv("pool must be an object");
	for (const r of RARITIES) if (!Array.isArray(pool[r])) throw inv(`pool.${r} must be an array`);
	const r1 = rng();
	const rarity = r1 < 0.005 ? "legendary" : r1 < 0.06 ? "epic" : r1 < 0.25 ? "rare" : "common";
	const list = pool[rarity];
	if (list.length === 0) throw new RangeError(`empty pool: ${rarity}`);
	const r2 = rng();
	return makeChampion(list[Math.floor(r2 * list.length)]);
}

export function stageEnemies(stage) {
	if (!isInt(stage) || stage < 1) throw inv("stage must be an integer >= 1");
	const level = Math.min(MAX_LEVEL, stage);
	return [0, 1, 2].map((i) =>
		makeChampion(
			{
				id: `stage${stage}-enemy${i}`,
				name: `Minion ${i + 1}`,
				affinity: AFFINITIES[(stage + i) % 4],
				rarity: "common",
				base: { hp: 300 + 40 * stage, atk: 40 + 6 * stage, def: 30 + 5 * stage, spd: 90 + 5 * i, crit: 0.1, critDmg: 1.5 },
				skills: [{ name: "Strike", multiplier: 1, cooldown: 0, target: "enemy" }],
			},
			level,
		),
	);
}

export function resolveStage(team, stage, seed) {
	if (!Array.isArray(team) || team.length === 0) throw inv("team must be a non-empty array");
	team.forEach(validateChampion);
	if (!isInt(stage) || stage < 1) throw inv("stage must be an integer >= 1");
	if (!isInt(seed)) throw inv("seed must be an integer");
	const fresh = team.map((c) => ({ ...cloneChampion(c), hp: c.stats.hp }));
	const battle = runBattle(fresh, stageEnemies(stage), seed, 100);
	const won = battle.winner === "A";
	const rewards = won ? { silver: 100 * stage, xp: 50 * stage } : { silver: 0, xp: 0 };
	return { won, battle, rewards, team: won ? team.map((c) => addXp(c, rewards.xp)) : team.map(cloneChampion) };
}
