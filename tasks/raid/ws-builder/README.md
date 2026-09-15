# Task: `raid`

Build the core of a turn-based squad RPG (seeded RNG, champions that level up, affinity-based damage, a speed-driven turn meter, buffs/debuffs with cooldowns, a deterministic auto-battle, summoning and a campaign) and a three.js scene that shows a battle.

Files under `src/`:

- `src/raid.mjs` — stages 1–6, plain ESM JavaScript for Node.js, no dependencies. The exports stubbed there must keep their names; the constants and `SAMPLE_CHAMPIONS` already in the stub are given data and stay as they are.
  1. `mulberry32(seed)`, `statsAt(base, level)`, `makeChampion(def, level)`, `xpForLevel(level)`, `addXp(champion, xp)`
  2. `affinityMod(attacker, defender)`, `mitigation(def)`, `computeDamage({...})`
  3. `nextActor(units)`
  4. `effectiveStat(unit, stat)`, `tickEffects(unit)`, `availableSkills(unit)`, `chooseSkill(unit)`, `chooseTarget(units)`, `rollHit(attacker, defender, skill, rng)`
  5. `runBattle(teamA, teamB, seed, maxTurns)`
  6. `summon(rng, pool)`, `stageEnemies(stage)`, `resolveStage(team, stage, seed)`
- `src/scene.mjs` — stage 7: `AFFINITY_COLORS`, `unitPosition`, `makeCamera`, `buildScene`, `updateScene`. It imports three.js from `./vendor/three.module.js` (r186, already vendored; `three.core.js` sits beside it). This module must build and be inspectable in Node without a browser: `node -e "import('./src/scene.mjs').then(m => ...)"` works, a renderer is only created in the page.
- `src/index.html` — a page that runs a sample battle and replays it in a three.js scene, turn by turn.

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order rather than all at once. Your counterpart holds the full specification: exact validation rules, error types and message prefixes, the exact RNG algorithm, formulas and evaluation order, turn-meter and battle rules, output shapes, and worked numeric examples. You do not have it. Ask for anything you need — signatures, edge cases, expected values for specific inputs — and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify files under `src/`. Never edit, and never read, anything under `src/vendor/` (the two files are 0.6 MB and 1.4 MB of minified library; importing them is all you need). Do not add packages, config files or a build step.
- Do not mutate inputs; return fresh arrays/objects. Every function is pure except `updateScene`, which updates the scene it is given.
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at numeric conventions or error behaviour when a question would settle it.
