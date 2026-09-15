// Planted bugs for `raid-tests`: each is one exact substring replacement applied to
// the pristine src/raid.mjs. A submitted suite "kills" a mutant when at least one of
// its tests fails against the mutated module. Every mutant is killed by the reference
// suite (tools/verify-task.mjs proves it), and every `from` occurs exactly once.
export const MUTANTS = [
	{ id: "m01-rng-constant", stage: 1, from: "Math.imul(t ^ (t >>> 7), 61 | t)", to: "Math.imul(t ^ (t >>> 7), 60 | t)" },
	{ id: "m02-growth-off-by-one", stage: 1, from: "const g = 100 + 4 * (level - 1);", to: "const g = 100 + 4 * level;" },
	{ id: "m03-xp-threshold", stage: 1, from: "while (level < MAX_LEVEL && pool >= xpForLevel(level)) {", to: "while (level < MAX_LEVEL && pool > xpForLevel(level)) {" },
	{ id: "m04-affinity-strong", stage: 2, from: "if (beats[attacker] === defender) return 1.25;", to: "if (beats[attacker] === defender) return 1.2;" },
	{ id: "m05-damage-floor", stage: 2, from: "return Math.max(1, Math.floor(x));", to: "return Math.max(0, Math.floor(x));" },
	{ id: "m06-turn-tie", stage: 3, from: "\t\tif (t < dt) {", to: "\t\tif (t <= dt) {" },
	{ id: "m07-effective-floor", stage: 4, from: "return Math.max(1, Math.floor((base * (100 + sum)) / 100));", to: "return Math.max(0, Math.floor((base * (100 + sum)) / 100));" },
	{ id: "m08-tick-keeps-zero", stage: 4, from: ".filter((e) => e.turns > 0) };", to: ".filter((e) => e.turns >= 0) };" },
	{ id: "m09-skill-lowest", stage: 4, from: "\treturn a[a.length - 1];", to: "\treturn a[0];" },
	{ id: "m10-target-tie", stage: 4, from: "if (best < 0 || u.hp < units[best].hp) best = i;", to: "if (best < 0 || u.hp <= units[best].hp) best = i;" },
	{ id: "m11-cooldown-negative", stage: 5, from: "cooldowns[k] = Math.max(0, actor.cooldowns[k] - 1);", to: "cooldowns[k] = actor.cooldowns[k] - 1;" },
	{ id: "m12-summon-legendary-rate", stage: 6, from: 'r1 < 0.005 ? "legendary"', to: 'r1 < 0.001 ? "legendary"' },
	{ id: "m13-enemy-affinity", stage: 6, from: "affinity: AFFINITIES[(stage + i) % 4],", to: "affinity: AFFINITIES[(stage + i + 1) % 4]," },
	{ id: "m14-silver-reward", stage: 6, from: "{ silver: 100 * stage, xp: 50 * stage }", to: "{ silver: 100 + stage, xp: 50 * stage }" },
];

export function applyMutant(source, m) {
	const n = source.split(m.from).length - 1;
	if (n !== 1) throw new Error(`mutant ${m.id}: pattern occurs ${n} times, expected exactly once`);
	return source.replace(m.from, m.to);
}
