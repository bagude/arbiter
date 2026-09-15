# Task: `raid-arena`

A campaign runner for the `raid` squad-RPG core.

- `src/raid.mjs` is given and complete (`makeChampion`, `addXp`, `runBattle`, `stageEnemies`, `resolveStage`). Do not modify it; import what you need from it.
- `src/arena.mjs` is the deliverable: plain ESM JavaScript for Node.js, no dependencies. Implement the exports stubbed there and keep their names; the constants in the stub are given.
  1. `stars(battle)`
  2. `runCampaign(team, seed, energy, startStage)`
  3. `combinations(n, k)`, `bestTeam(roster, size, stage, seed)`

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order. Your counterpart holds the full specification: the star rule, the campaign loop's exact order of checks, how seeds are derived per stage, the output shapes, tie-breaking rules, and worked examples with exact numbers. You do not have it. Ask for what you need and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify `src/arena.mjs`. No packages, config files or build step.
- Do not mutate inputs; return fresh objects.
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at rules or shapes when a question would settle it.
