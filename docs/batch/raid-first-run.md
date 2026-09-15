# raid — first run (2026-09-15T03-11-27)

Can the harness, with the local 27B in both seats, build a small game from a hidden spec? Task `tasks/raid`: a seven-stage squad-RPG core (seeded RNG, champions and levelling, affinity damage, a speed-driven turn meter, buffs/cooldowns/AI, a deterministic auto-battle, summoning and campaign stages) plus a three.js scene builder and a replay page on vendored three.js r186. Hidden oracle: 47 node:test cases over two suites, including the exact 35-turn battle log for seed 1 and the structure, positions, colours and health bars of the scene graph (three.js builds headlessly in Node). Config `configs/orch-raid-27b.json` (orchestrator + one worker at a time, worker report contract on, caps 400 tool calls / 10 800 s / 6 done claims).

## Result

| | |
|---|---|
| outcome | SUCCESS: oracle passed (47/47 on the second done claim) |
| wall | 4033 s (67 min) |
| workers | 4 (stages 1–4 · stages 5–6 · scene + page · one fix) |
| probes | 44 (all the orchestrator's own; no auto-probes) |
| done claims | 2 (attempt 1: 46/47) |
| tool calls | 154 (orchestrator 95, workers 19 / 14 / 15 / 11) |
| tokens | 1 079 981 |
| guards | bash_timeout rewritten ×6, path denied ×1 (`%CD%` env indirection) |

Timeline: kickoff → 167 s reading the spec and workspace → worker 1 briefed on stages 1–4 in one 16 k-character brief (a near-verbatim relay of the spec with every worked number; it even corrected its own typo in the RNG line mid-brief) → worker 1 done at 12 min, **25/25 hidden tests for those stages already green** → ~10 min of probing stage 1–3 values, most of it wasted (see finding 1) → worker 2 briefed on stages 5–6 at 19.5 min, done at 30 min, **37/37 raid tests green including the exact battle log** → two pi compactions (34 and 39 min) with long thinking after each → worker 3 briefed on the scene and page at 48 min, done at 52 min (46/47) → done claim at 62 min, oracle 46/47 → a fix worker → second claim at 67 min, 47/47.

The page it produced (`runs/2026-09-15T03-11-27/ws-builder/src/index.html`, served statically) renders the arena, four affinity-coloured units with health bars, and replays the battle turn by turn with a caption; the replay ends on turn 35 with "Kael the Ember — Ignite: Grimjaw takes 265 (K.O.)", exactly the reference's last log entry.

## Findings

1. **Harness bug: probe verdicts were a raw JSON string compare.** `supervisor.mjs` judged a probe case by `JSON.stringify(actual) === JSON.stringify(expect)` — key-order sensitive, no tolerance, a partial expectation read as MISMATCH — and ignored the `match`/`diff` fields the task's probe.mjs had computed. Orbit never hit this (numeric arrays); here every champion-shaped result "mismatched" (probe #4 reported "1/6 matched" for six correct answers). The orchestrator read the mismatches correctly as key-order noise but then re-sent the same cases with reordered keys, which also evaded the repeat guard (same order-sensitive key): probes 10–18, ~10 minutes. Fixed on branch `probe-match` (`lib/probe-match.mjs`, 6 tests; suite 254/254): canonical-key repeat guard, the runner's verdict stands, the mismatch line carries the runner's diff. Not applied to this run.
2. **Oracle correction, applied mid-run.** Attempt 1 failed exactly one assertion: `updateScene(scene, [])` must throw. The spec never says that; the hidden test was stricter than the contract, so the assertion was removed (commit a97be07) before attempt 2. The orchestrator's own diagnosis of the failure ("relax updateScene's validation to accept units without side/affinity/id") was wrong but harmless; the fix worker's change did not affect the verdict.
3. **Probe protocol discoverability.** The orchestrator's first stage-7 probes called `makeCamera` etc. without the `scene.` prefix the runner documented and got "not an exported function" (probe #26). It recovered by adding a `module` hint of its own invention. The runner now accepts the bare names (commit e1b6b17).
4. **Checkpoint per probe.** After the first worker the orchestrator wrote a checkpoint after nearly every probe result (28 checkpoints by 60 min, ~4 s each). Cheap individually; a habit worth a prompt nudge ("checkpoint at phase boundaries").
5. **Raw stream size.** `raw-orchestrator.jsonl` reached 236 MB in 45 min (every streaming delta is logged with its full usage block). Disk only, but it will hurt long runs.
6. **Briefs are good.** All three build briefs were faithful spec relays with the exact numbers, the no-mutation rules and a test-then-clean-up checklist; the workers' scratch tests reproduced the worked examples before reporting. The one relay slip found (a dropped digit in a sample RNG value) was harmless.

Follow-ons (six tasks, same night): `docs/batch/raid-night.md`, `docs/batch/raid-night-2.md`.
