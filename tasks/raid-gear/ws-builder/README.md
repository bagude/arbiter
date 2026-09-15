# Task: `raid-gear`

Add artifacts and equipment to the `raid` squad-RPG core.

- `src/raid.mjs` is given and complete (seeded RNG, champions via `makeChampion`, stats via `statsAt`, battles). Do not modify it; import what you need from it.
- `src/gear.mjs` is the deliverable: plain ESM JavaScript for Node.js, no dependencies. Implement the exports stubbed there and keep their names; the constants already in the stub are given data.
  1. `validateArtifact(a)`, `equip(champion, artifact)`, `unequip(champion, slot)`
  2. `gearStats(champion)`
  3. `gearedStats(champion)`, `applyGear(champion)`
  Plus `sampleArtifacts()` returning the six sample artifacts described in the stub comment.

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order. Your counterpart holds the full specification: validation rules, error types and message prefixes, how set bonuses count, the exact stat formula and evaluation order, output shapes, and worked numeric examples. You do not have it. Ask for what you need and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify `src/gear.mjs`. Do not add packages, config files or a build step.
- Do not mutate inputs; return fresh objects (deep copies of gear and skills).
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at formulas or error behaviour when a question would settle it.
