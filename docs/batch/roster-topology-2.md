# batch roster-topology-2

Started 2026-09-17T12:27:59.269Z, finished 2026-09-17T12:50:09.477Z (0.37 h). 3 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| pathnorm | 2026-09-17T12-27-59 | SUCCESS: oracle passed | 70/70 | 190.6 | 36 | 2 | 1 | 1 | path:4 bash_timeout:3 |
| pathnorm | 2026-09-17T12-31-13 | SUCCESS: oracle passed | 70/70 | 648.6 | 149 | 4 | 2 | 1 | path:6 bash_timeout:15 topology:1 |
| pathnorm | 2026-09-17T12-42-04 | SUCCESS: oracle passed | 70/70 | 481.4 | 105 | 2 | 2 | 1 | path:7 bash_timeout:15 |

Successes: 3/3.

## Analysis (2026-09-17): after the prompt changes (af73c73)

Same config as `docs/batch/roster-topology.md` (tester → implementer, memory search, `topology: nudge`). Changed between the batches: the tester's degenerate-input rule is per function with the `relative` dot/empty cases spelled out per argument, the tester must re-derive every expectation from the brief's stated rule and import nothing but the module and the runner; the implementer runs the suite once, reads the failure list, fixes, re-runs, never probes per case, and its turn cap is 90 (was 60).

| run | first oracle | wall s | turns | tester suite | dot/empty `relative` operand in the suite | tester errors | implementer first stint | pre-implementer review resume | topology events |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17T12-27-59 | **70/70** | **191** | 35 | 101 assertions | none | none | 15 tool uses, completed | no | none |
| 2026-09-17T12-31-13 | **70/70** | 649 | 142 | 115 assertions | `relative(".", "b")`, `(".", ".")`, `(".", "../a")` | 1 (`normalize("a/..b/../c")`) | 94 tool uses, `steered` at the 90-turn soft limit, partial 101/115 | no | denied 1 (`tests:unread`) |
| 2026-09-17T12-42-04 | **70/70** | 481 | 102 | 76 tests (+7) | `relative(".", "a")`, `relative("", "a")` | 1 (`relative("a", "b/..")`) | 49 tool uses, completed, 76/76 | no | none |

| batch | first-try oracle | wall s | suites with a dot/empty `relative` operand | suites with a wrong expectation | implementers at the turn cap |
|---|---|---|---|---|---|
| topology 1 (before) | 2/3 | 510–588 | 1/3 | 3/3 | 2/3 (hard-aborted at 60) |
| **topology 2 (after)** | **3/3** | **191–649** | **2/3** | 2/3 | 1/3 (steered at 90, finished) |
| control, single worker | 4/4 all-time | 176–317 | — | — | — |

### What the three changes bought

- **First-try oracle 3/3**, and the first run is the fastest pathnorm run in the ledger at 191 s with 35 turns, under every control. Its orchestrator wrote 20k output tokens; the control's writes 29k. That run is what the design looks like when nothing goes wrong: tester in 8 calls, orchestrator reads the suite, implementer in 15 calls, done.
- **The per-function degenerate rule reached the suite in 2 of 3 runs** (1 of 3 before), and run 3's tester wrote the exact oracle case, `relative(".", "a")`, unprompted. Run 1's tester did not, and its implementer got `relative` right anyway, as run 3's did in the batch before. The marker is now usually present; it is still not what decides the pass on this task.
- **Per-case probing stopped.** Zero `node -e` calls in run 2's 94-call stint (58 in the equivalent stint before), four in each of the others. Run 2's implementer spent its turns on 32 `edit` calls against 14 failures, one of which was a wrong test, reached the 90-turn soft limit, was steered to wrap up, and reported an honest partial (101/115) that named every failure. The orchestrator then spawned a fresh tester to fix the one wrong expectation and a fresh implementer with four directed fixes, which landed in 6 calls. No hard abort, no resume chain.
- **Tester errors dropped from three suites to two**, one wrong expectation each, both on rules the brief stated (`..` cancelling a `..b` segment; `relative("a", "b/..")`). The self-check paragraph did not eliminate them; the 27B derives a wrong value from a rule it has read as readily as it does from memory. Each error still costs one tester round.

### What the nudge did this time

One denial in three runs, again `tests:unread`, again correct: in run 2 the fix-tester rewrote the suite at 475 s and the implementer spawn at 575 s was denied until the orchestrator re-read it. No waives, no skips. In runs 1 and 3 the orchestrator read the suite once and briefed the implementer without a resume; nothing to nudge.

Nobody was nudged for missing tests in either batch: six of six orchestrators spawned the tester first from the Roster paragraph alone. The nudge has only ever fired on the read-after-rewrite rule, which is the one that guards the review.

### Reading across the six test-first runs

- First-try oracle 5/6, against 0/2 for implementer-first roster runs today and 4/4 for the single worker.
- Wall 191–649 s, median 535; the single worker's four runs are 176–317. The roster still costs about twice the worker on this task when anything goes wrong, and matches it when nothing does.
- Every miss and every slow run traces to the same two causes: a wrong test expectation (5 of 6 suites had one) and an implementer stint long enough to hit a turn cap (3 of 6). Neither is the orchestrator's fault and neither is fixed by the guard; both are tester and implementer prompt quality on a 27B, and both are visible in the run before the oracle runs.
- Memory: every orchestrator fetched seeded records (0.9–2.9k chars) without refusal; run 1's and run 2's orchestrators also searched. Workers called `memory_get` in two runs. `remember` was never called across all six runs.

### Next

- Pathnorm has now answered the topology question: the mechanism works, the order holds without enforcement, and the review resume is where the trap gets caught. Further pathnorm runs measure prompt polish, not the design.
- The measurement that is still missing is the one the ladder asked for: a class-C or class-B task (`raid-gear`, `orbit`, `dw-bronze`) where exploration is the cost and a tester's suite is worth more than the oracle's.
- The tester's wrong-expectation rate is the next lever if the test-first roster is kept on small tasks: one candidate is to have the tester run its suite against the spec examples the brief lists verbatim (it cannot run the implementation, but it can assert the brief's own examples are among its expectations).
