# Task: `raid-timeline`

Animation keyframes for battles of the `raid` squad-RPG core, as pure data a page can replay.

- `src/raid.mjs` is given and complete (`makeChampion`, `runBattle`, `SAMPLE_CHAMPIONS`). Do not modify it; use it to produce battles when testing.
- `src/timeline.mjs` is the deliverable: plain ESM JavaScript for Node.js, no dependencies. Implement the exports stubbed there and keep their names; the constants in the stub are given.
  1. `turnTimeline(entry, units)` — keyframes for one log entry
  2. `battleTimeline(battle, initialUnits)` — the whole battle, absolute times
  3. `stateAt(timeline, initialUnits, t)` and `turnAt(timeline, t)` — the animated state at a time

Stages are ordered by dependency and each is verified on its own, so finish and hand off stages in order. Your counterpart holds the full specification: the exact frame order and timings, how hp carries between hits and turns, output shapes, error rules, and worked examples with exact frame lists. You do not have it. Ask for what you need and say when a stage is ready so it can be probed against your live code.

Constraints:
- Only modify `src/timeline.mjs`. No packages, config files or build step.
- Do not mutate inputs; return fresh objects.
- Test with `node --test` or `node -e` from the workspace root, always with an explicit timeout.
- Do not guess at timings or shapes when a question would settle it.
