# batch roster-pathnorm-memory-2

Started 2026-09-17T01:41:50.893Z, finished 2026-09-17T01:46:45.932Z (0.08 h). 1 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| pathnorm | 2026-09-17T01-41-50 | SUCCESS: oracle passed | 70/70 | 292.3 | 57 | 2 | 3 | 1 | path:3 bash_timeout:1 |

Successes: 1/1.

## Analysis (2026-09-17): curated memory vs the same config the day before

Same config (`orch-pathnorm-27b-roster-memory.json`), same model, same task. One variable: between the runs the promotion queue for `task:pathnorm` was worked once (8 promoted, 3 tombstoned, 7 left) and the per-specialist procedural records were dropped (57a4b3b).

| run | outcome | wall | seeded records | orch calls | orch output | orch hit | first probe well-formed | specialist `remember` |
|---|---|---|---|---|---|---|---|---|
| 2026-09-16T16-46-24 (before) | pass 70/70 | 395 s | 2 generic "delegation passed" | 12 | 23.3k | 0.893 | **no** — 69 cases without `fn`, wasted | none |
| 2026-09-17T01-41-50 (after) | pass 70/70 | 292 s | 5, three of them the promoted lessons | 17 | 18.5k | 0.949 | **yes** | 1 |

**A promoted lesson changed behaviour.** `m_d5382ef4bffa` ("probe entries must include an `fn` field") was in the seed. The day-before run's first probe lacked `fn` on all 69 cases and was wasted; the rerun's first probe had `fn` on all 74. That is the clearest cause-and-effect the memory system has shown so far, and it is exactly the kind of lesson worth promoting: a protocol fact the orchestrator otherwise rediscovers every run.

**A specialist wrote a real lesson, unprompted.** The implementer called `remember` once: the path guard rejects bash commands whose text contains workspace-escaping strings like `../x` even as data, and the workaround is to write test values to a file and run `node <file>`. It landed as a candidate in `agent:implementer`. First time a specialist has used the tool on a normal task.

**Budget wrinkle, worth a config change.** The orchestrator tried to `memory_get` the three seeded lessons and was refused: `workerReserveChars: 3000` of `retrievalChars: 6000` leaves the orchestrator 3000, and the seed already spent 1692 of it, so a ~1.3k get tipped over. It succeeded later with a smaller get. With five real rows in the seed, the orchestrator needs room to read them; raise `retrievalChars` or lower the reserve for roster runs.

**Caveats.** N=1 per arm. The rerun spawned two implementers and no tester, the day-before run one implementer and one tester, so the roster choice differed and the worker-lane numbers are not comparable. The orchestrator numbers (output 23.3k → 18.5k, hit 0.893 → 0.949, wall 395 → 292 s) point the right way but need a second pair before they are claims.
