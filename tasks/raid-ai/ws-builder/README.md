# Task: `raid-ai`

An alternative battle AI for the `raid` squad-RPG core, a battle runner that pits it against the basic AI, and a seeded win-rate estimator.

- `src/raid.mjs` is given and complete (`makeChampion`, `runBattle`, `stageEnemies`, and the building blocks `affinityMod`, `availableSkills`, `chooseSkill`, `chooseTarget`, `effectiveStat`, `mulberry32`, `nextActor`, `rollHit`, `tickEffects`). Do not modify it; import what you need from it. `runBattle`'s source is your reference for the battle loop.
- `src/ai.mjs` is the deliverable: plain ESM JavaScript for Node.js, no dependencies. Implement the exports stubbed there and keep their names.
  1. `chooseTargetSmart(actor, enemies)`, `scoreSkills(actor, aliveEnemies)`, `chooseSkillSmart(actor, aliveEnemies)`
  2. `runBattleSmart(teamA, teamB, seed, maxTurns)`
  3. `winRate(teamA, teamB, seeds, runner)`

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order. Your counterpart holds the full specification: the targeting key, the scoring rule and tie-break, exactly where the smart runner differs from `runBattle`, output shapes, and worked examples with exact logs and rates. You do not have it. Ask for what you need and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify `src/ai.mjs`. No packages, config files or build step.
- Do not mutate inputs; return fresh objects.
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at rules when a question would settle it.
