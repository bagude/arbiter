// An alternative battle AI for the raid core. See README.md.
import { affinityMod, availableSkills, chooseSkill, chooseTarget, effectiveStat, mulberry32, nextActor, rollHit, tickEffects } from "./raid.mjs";

// Stage 1: targeting and skill choice.
export function chooseTargetSmart(actor, enemies) {
	throw new Error("not implemented");
}
export function scoreSkills(actor, aliveEnemies) {
	throw new Error("not implemented");
}
export function chooseSkillSmart(actor, aliveEnemies) {
	throw new Error("not implemented");
}

// Stage 2: the battle loop with side A on the smart AI.
export function runBattleSmart(teamA, teamB, seed, maxTurns = 100) {
	throw new Error("not implemented");
}

// Stage 3: seeded win-rate estimate.
export function winRate(teamA, teamB, seeds, runner = runBattleSmart) {
	throw new Error("not implemented");
}
