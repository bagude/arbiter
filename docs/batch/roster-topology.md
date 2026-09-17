# batch roster-topology

Started 2026-09-17T04:37:51.112Z, finished 2026-09-17T05:06:02.858Z (0.47 h). 3 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| pathnorm | 2026-09-17T04-37-51 | SUCCESS: oracle passed | 70/70 | 588.5 | 129 | 2 | 3 | 1 | bash_timeout:68 topology:1 path:6 |
| pathnorm | 2026-09-17T04-47-42 | SUCCESS: oracle passed | 68/70, 70/70 | 510.2 | 138 | 2 | 3 | 2 | path:6 bash_timeout:31 |
| pathnorm | 2026-09-17T04-56-15 | SUCCESS: oracle passed | 70/70 | 584.2 | 143 | 2 | 2 | 1 | bash_timeout:15 path:20 topology:1 |

Successes: 3/3.

## Analysis (2026-09-17): test-first roster with the topology nudge, three runs

Config `configs/orch-pathnorm-27b-topology.json`: `use: ["tester", "implementer"]`, memory search (9000/4000), `guards.topology: "nudge"`. Spec `docs/superpowers/specs/2026-09-17-roster-topology-design.md`. Compared with today's other pathnorm runs (`docs/batch/roster-pathnorm-pair-2.md`).

| run | first oracle | wall s | tool calls | tester suite | tester resumed before the implementer | implementer aborted at the 60-turn cap | topology events | relative with a `.`/`""` operand in the suite |
|---|---|---|---|---|---|---|---|---|
| 2026-09-17T04-37-51 | **70/70** | 588 | 129 | 76 tests | yes (missing `basename` empty-ext case) | yes, 66 tool uses at 131 s | denied 1 (`tests:unread`) | `relative("", "a")` |
| 2026-09-17T04-47-42 | 68/70 → 70/70 | 510 | 138 | 82 tests | **no** | no | none | none until added after the miss |
| 2026-09-17T04-56-15 | **70/70** | 584 | 143 | 105 tests | yes (a `node:path` import in the test file) | yes, 66 tool uses at 110 s | denied 1 (`tests:unread`) | none |

| arm (today) | runs | first-try oracle | wall s | turns | orch output tok |
|---|---|---|---|---|---|
| control, single worker | 1 (4 all-time) | 1/1 (4/4) | 271 | 31 | 29k |
| roster, implementer-first (+memory, +shuffled) | 2 | 0/2 | 682, 933 | 100, 99 | 68k, 92k |
| **test-first roster + nudge** | 3 | **2/3** | 510–588 | 125–146 | 52k–65k |

### The mechanism fired as designed, every time it applied

- All three orchestrators spawned the **tester first**, with an API brief, without being nudged. The Roster section's order paragraph was enough for that.
- All three **read the test file** before briefing the implementer (102–110 s in). Two of them resumed the tester with a missed obligation before any code existed; that review step had never happened in any previous run.
- The nudge fired **exactly when the design says**: in runs 1 and 3 the tester's resume rewrote the file after the orchestrator's read, the next implementer spawn was denied `tests:unread`, the orchestrator re-read the file, and the retry went through. Two denials in three runs, zero waived, zero skipped. The per-check keying fix from the final review was load-bearing: under the original rule the run-1 denial would have been the only nudge and run 3's would still have fired, but an implementer-first orchestrator would have had its review nudge waived.
- The one miss is the one run **without** a pre-implementer review resume, and it missed on the same two assertions as every other pathnorm miss (`relative(".", "a")`, `relative("a", ".")`). Its tester suite had no dot operand until the orchestrator, after the oracle verdict, resumed the tester to add seven `relative` regression tests and the implementer to fix it — the recovery took 240 s and worked first time.

### Honest reading of the marker

The design's marker was "the test file contains a `relative` case with a `.` operand." It held in **one** of three suites (run 1's `relative("", "a")`, which exercises the same zero-segment path), and that run passed. Run 3 passed with **no** dot case in its suite: its implementer got `relative` right on its own. So of the two first-try passes, one is attributable to the tests and one is not. Three runs cannot separate "test-first made the implementer careful" from "this implementer would have passed anyway"; what they do show is that the tester's degenerate-input rule ("empty string, a lone `.`, root, trailing separator, non-string" per stated rule) produced the `relative` empty/dot case in one suite out of three. That rule needs to be per function, not global, before the marker is a fair test.

### Where the time went (2× the control)

1. **Every tester suite had at least one error**, and each error cost an implementer partial report plus a tester resume: run 1 wrapped two throw tests wrongly; run 2 expected `basename("a.txt", "txt")` → `"a"` (spec says `"a."`); run 3 imported `node:path` in the test file (a spec violation the orchestrator caught on review) and expected `join("/a", "..", "b")` → `"b"`. Tests written from a paraphrase inherit the paraphrase's mistakes, and now they cost a round each.
2. **Implementers hit the 60-turn cap in two of three runs** (`status: aborted`, 66 tool uses, at 110–131 s, about 2 s per turn) and were resumed three to four times. The turn budget went on `bash`: 58 of run 1's implementer's 71 calls were `node -e` probes and repeated test-file runs against a 76-assertion suite. Handing an implementer a large suite changes its loop from "write, run once, report" to "probe every failure", and `maxTurns: 60` was sized for the former.
3. **The review round before any code**: tester spawn, orchestrator read, resume, re-read — about 60–100 s that the single worker never spends.

Memory: every orchestrator fetched four seeded records (1.7–2.9k chars) with no refusal, confirming the seed-accounting fix; the implementers in runs 1 and 3 also called `memory_get`. Nobody called `remember`.

### What this settles, and what to change before the next three

- On pathnorm the test-first roster beats the implementer-first roster on first-try pass (2/3 vs 0/2 today) and on wall (510–588 vs 682–933 s), and still loses to the single worker on wall (271 s, 4/4 first try all-time). The ladder's prediction holds: class-A level-1 is not where a roster pays.
- Three changes, each aimed at a measured cost: (1) the tester's degenerate-input rule becomes per-function (for `relative` and `join`: both operands `""`, `"."`, `"/"`), and the tester must check every expectation it writes against the brief's stated rule before reporting; (2) the implementer's prompt says to run the suite once, read the failure list, fix, and re-run, never to probe with `node -e` per case, with `maxTurns` raised to 90 so a real suite fits; (3) the review resume is what correlated with passing, so the Roster section's rule stays as is and the nudge stays at `nudge`.
- Read-outs for any rerun: `summary.guards.topology` (the batch table collapses kinds), the tester's suite for a dot operand per function, and the implementer's first-stint status.
