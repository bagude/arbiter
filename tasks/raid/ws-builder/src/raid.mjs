// Turn-based squad RPG core. Stages 1-6; see README.md.
// The constants and SAMPLE_CHAMPIONS below are given data: keep them as they are.

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

// Stage 1: seeded RNG, champion creation, levelling.
export function mulberry32(seed) {
	throw new Error("not implemented");
}
export function statsAt(base, level) {
	throw new Error("not implemented");
}
export function makeChampion(def, level = 1) {
	throw new Error("not implemented");
}
export function xpForLevel(level) {
	throw new Error("not implemented");
}
export function addXp(champion, xp) {
	throw new Error("not implemented");
}

// Stage 2: damage.
export function affinityMod(attacker, defender) {
	throw new Error("not implemented");
}
export function mitigation(def) {
	throw new Error("not implemented");
}
export function computeDamage(args) {
	throw new Error("not implemented");
}

// Stage 3: turn meter.
export function nextActor(units) {
	throw new Error("not implemented");
}

// Stage 4: effects, cooldowns, AI.
export function effectiveStat(unit, stat) {
	throw new Error("not implemented");
}
export function tickEffects(unit) {
	throw new Error("not implemented");
}
export function availableSkills(unit) {
	throw new Error("not implemented");
}
export function chooseSkill(unit) {
	throw new Error("not implemented");
}
export function chooseTarget(units) {
	throw new Error("not implemented");
}
export function rollHit(attacker, defender, skill, rng) {
	throw new Error("not implemented");
}

// Stage 5: battle.
export function runBattle(teamA, teamB, seed, maxTurns = 100) {
	throw new Error("not implemented");
}

// Stage 6: summoning and campaign.
export function summon(rng, pool) {
	throw new Error("not implemented");
}
export function stageEnemies(stage) {
	throw new Error("not implemented");
}
export function resolveStage(team, stage, seed) {
	throw new Error("not implemented");
}
