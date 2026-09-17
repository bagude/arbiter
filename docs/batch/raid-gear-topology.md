# batch raid-gear-topology

Started 2026-09-17T13:10:33.978Z, finished 2026-09-17T13:59:47.016Z (0.82 h). 3 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| raid-gear | 2026-09-17T13-10-34 | SUCCESS: oracle passed | 10/10 | 1317.7 | 85 | 2 | 27 | 1 |  |
| raid-gear | 2026-09-17T13-32-35 | SUCCESS: oracle passed | 10/10 | 700.6 | 76 | 2 | 4 | 1 | bash_timeout:17 topology:1 |
| raid-gear | 2026-09-17T13-44-19 | SUCCESS: oracle passed | 10/10 | 924 | 174 | 2 | 2 | 1 | bash_timeout:32 path:4 topology:1 |

Successes: 3/3.

## Analysis (2026-09-17): the class-C measurement

The ladder (`docs/batch/roster-pathnorm-pair-2.md`) predicted the roster would pay where exploration and verification are the cost, not on pathnorm. raid-gear is that cell: a 396-line given core (`src/raid.mjs`) to read, a 49-line stub to fill, three dependent stages, and a 10-check oracle. One run per arm, same server, same afternoon.

| arm | oracle | wall s | orch calls | orch decoded tok | orch inference s | probes sent | worker fresh tokens before first edit |
|---|---|---|---|---|---|---|---|
| control, single worker (`orch-raid-gear-27b.json`) | 10/10 first try | 1318 (prior run 1283) | 40 | 80 031 | 839 | **27** | 15.5k, 9.6k (two stage workers) |
| **test-first + memory** (`-topology.json`) | 10/10 first try | **701** | 21 | 46 582 | 493 | 4 | tester 17.7k, implementer 10.7k |
| test-first + shuffled memory (`-topology-shuffled.json`) | 10/10 first try | 924 | 16 | 49 559 | 488 | 2 | tester 20.6k, implementer 17.2k |

### Where the 617 seconds went

Not where the design said. The roster was built to cut worker exploration; it did not: the implementers read 10.7k–17.2k fresh tokens before their first edit, the same band as the control's stage workers (9.6k–15.5k). What changed is the **orchestrator's verification loop**. The single-worker orchestrator verified the deliverable itself: 27 of its 40 decisions were probes, and it decoded 80k tokens reasoning about probe results over 839 s of inference. With a tester's suite in the workspace, the orchestrators sent 4 and 2 probes, decoded 47–50k tokens, and inferred for 490 s. The tester's suite substituted for the orchestrator's probing, and on a 27B where decode is the cost, that is the whole gain: 42% less orchestrator output, 47% less wall, identical oracle result.

That is the mechanism the pathnorm runs could not show, because on pathnorm the control orchestrator sends a handful of probes and passes first try anyway.

### The topology nudge

Both roster arms: tester spawned first from the Roster paragraph alone; the orchestrator read the suite; the tester was resumed once before the implementer (a `withSets` helper fix; an `applyGear` assertion fix); the implementer spawn after that resume was denied `tests:unread`, the orchestrator re-read the file, the retry went through. One denial per run, none waived, none skipped. Same behaviour as on pathnorm, on a task four times the size.

### Right memory versus shuffled: not separable at n=1

The right-memory arm was 223 s faster than the shuffled arm, but the difference has a specific cause that is not memory: the shuffled run's implementer took a 102-call stint on a Node 26 `assert.throws` quirk in the tester's helper (9 of 52 tests failing on the helper, not the code), and the orchestrator spent two resumes untangling it. The right-memory orchestrator fetched one record (`memory_get`, 1 call); the shuffled one fetched none. One run each cannot attribute 223 s to that. What the pair does say is that the roster's gain over the control (617 s) does not depend on task memory: the shuffled arm, with the wrong task's records, still beat the control by 394 s.

### Tester error rate, again

Both tester suites shipped with one wrong helper, as on pathnorm: 2 of 2 here, 5 of 6 there. Each cost an implementer partial and a tester resume. On raid-gear the implementer's partial report named the failing helper precisely both times, so the fix round was short (7 and 6 worker calls). This is now the most consistent cost in the test-first design and the next thing to measure a fix against.

### What this settles

- The class×level prediction holds in both directions: on A1 the roster loses to the single worker on wall; on C3 the test-first roster halves wall at the same oracle result.
- The gain is orchestrator decode, specifically the probe loop, not worker exploration. Any future roster change should be judged by orchestrator output tokens first.
- Next for this cell: a second run of each roster arm to bound the variance, and the same three arms on `orbit` (class B) to see whether the probe-substitution effect needs a stub-and-core layout or only a tester.
