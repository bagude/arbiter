# Task: `raid-save`

Save files for the `raid` squad-RPG core.

- `src/raid.mjs` is given and complete (`makeChampion`, `addXp`, `MAX_LEVEL`, battles). Do not modify it; import what you need from it.
- `src/save.mjs` is the deliverable: plain ESM JavaScript for Node.js, no dependencies. Implement the exports stubbed there and keep their names; the constants in the stub are given.
  1. `canonical(value)`, `fnv1a(str)`
  2. `saveGame(state)`, `loadGame(text)`
  3. `diffSaves(a, b)`

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order. Your counterpart holds the full specification: the canonical JSON rules, the exact hash algorithm and output format, the save string layout, what is validated on save and load and which error type and message prefix each failure uses, the exact shapes returned, and worked examples with exact strings and checksums. You do not have it. Ask for what you need and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify `src/save.mjs`. No packages, config files or build step.
- Do not mutate inputs; return fresh objects.
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at formats or error behaviour when a question would settle it.
