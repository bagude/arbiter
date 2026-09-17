# batch roster-pathnorm-pair-2

Started 2026-09-17T02:07:56.335Z, finished 2026-09-17T02:23:53.845Z (0.27 h). 2 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| pathnorm | 2026-09-17T02-07-56 | SUCCESS: oracle passed | 70/70 | 270.7 | 32 | 1 | 5 | 1 | path:4 |
| pathnorm | 2026-09-17T02-12-29 | SUCCESS: oracle passed | 68/70, 70/70 | 681.9 | 100 | 2 | 7 | 2 | bash_timeout:10 path:5 |

Successes: 2/2.

## Analysis (2026-09-17): second pair, plus the shuffled-memory control

Three runs today after the seed-accounting fix (`c11f147`): the pair above, then `configs/orch-pathnorm-27b-roster-memory-shuffled.json` (`docs/batch/roster-pathnorm-shuffled.md`), which is the roster+memory config reading `task:lru`'s records in place of `task:pathnorm`'s (`memory.readTask`, `47a6eb8`). All seven roster-era pathnorm runs, oldest first:

| run | arm | wall s | tool calls | first oracle | turns | fresh tok | output tok | in+out by role |
|---|---|---|---|---|---|---|---|---|
| 2026-09-16T16-30-04 | control | 602 | 61 | 70/70 | 60 | 91 241 | 57 728 | orch 31 548 / worker 59 693 |
| 2026-09-16T16-40-11 | roster | 369 | 48 | 70/70 | 46 | 85 790 | 37 143 | orch 50 656 / worker 35 134 |
| 2026-09-16T16-46-24 | roster+memory | 395 | 55 | 70/70 | 54 | 92 453 | 42 405 | orch 49 774 / worker 42 679 |
| 2026-09-17T01-41-50 | roster+memory, curated | 292 | 57 | 70/70 | 56 | 68 558 | 31 023 | orch 33 781 / worker 34 777 |
| 2026-09-17T02-07-56 | control | 271 | 32 | 70/70 | 31 | 55 175 | 29 017 | orch 36 380 / worker 18 795 |
| 2026-09-17T02-12-29 | roster+memory | 682 | 100 | 68/70 → 70/70 | 100 | 126 969 | 67 938 | orch 65 590 / worker 61 379 |
| 2026-09-17T02-24-17 | roster+memory, **shuffled** | 933 | 98 | 68/70 → 70/70 | 99 | 184 311 | 92 408 | orch 108 125 / worker 76 186 |

### The pair reversed

Yesterday the roster beat the control by four minutes; today the control beat the roster by seven. Two pairs, opposite signs. The arm effect on pathnorm is smaller than run-to-run variance, and the variance has one source: whether the first implementation passes the oracle. Every run whose first oracle was 70/70 finished in 271–602 s; both that missed took 682 and 933 s. The roster does not change that coin, it only adds turns on both sides of it.

### The shuffled control: memory content is not where the time goes

The shuffled arm read `task:lru` instead of `task:pathnorm`. Its seed matched nothing (726 chars, 0 rows), and no agent called `memory_search`, `memory_get` or `remember`, so it was in effect "roster, no task memory". It was the slowest of the three. Its oracle miss was the same two assertions as the right-memory run's (`relative(".", "a")` and `relative("a", ".")`). So on this task the memory content, right or wrong, does not move wall time; the roster's own loop does. That is the null result the control exists to give, and it is unambiguous.

### One trap explains all the misses

The oracle asserts `relative(".", "a") === "a"` and `relative("a", ".") === ".."`. The spec never lists a dot operand for `relative`; it follows from "purely lexical on the normalised segment lists" plus `normalize(".") → "."`, which has zero segments. Implementers that split the normalised string get one segment `"."` and emit a spurious `..`.

| who wrote `relative` first | hit the trap |
|---|---|
| generic worker (4 control runs) | 0 of 4 |
| roster implementer (5 roster runs) | 3 of 5: 16-46-24 (the tester caught it before the oracle), 02-12-29, 02-24-17 |

Only one roster brief named the case: 01-41-50, the curated-memory rerun, and that run passed first try. Today's right-memory orchestrator held the same seed and fetched two more records but wrote a brief without it. The store does contain the lesson (`m_4315627a5374`, promoted), but phrased as a fix-verification report ("passes all 100 checks … '/' and '.' now map to empty segment lists"), and the seed query (spec title plus open questions) ranks five other records above it. This is the concrete case for the "tried and failed, keep X" wiki shape: one line, *"relative(): a normalised `.` is zero segments, not one — the oracle checks `relative(".", "a")`"*, at the top of the `task:pathnorm` page, is worth more to the next implementer than the eight promoted reports beneath it.

Why the generic worker avoids it is not measured; the four controls are two prompts (legacy `worker.md` vs `implementer.md`) and n=4, so it is noted, not claimed.

### The tester did not earn its keep today

Twice the tester reported a clean independent suite (125 and 165 assertions) that did not include a dot operand, and the oracle failed on exactly that. On 16-46-24 it did catch the same bug. One catch in three is not a safety net, and each tester run costs a spawn, a brief and a report round. In the shuffled run the tester also ended `failed` after 3 min (bash timeouts, 28 `bash_timeout` rewrites in the run).

### Incident: the model garbled a literal for 400 s

In 02-12-29, from the oracle verdict onward, the orchestrator emitted the token ` Cant` wherever a quoted `.` (and `" cant"` for a quoted empty string) belonged: 678 occurrences in its raw stream, 35 in the implementer's. The first fix brief carried the garble; the implementer wrote `if (s === ". Cant") return [];` into the source; a second resume was needed. The orchestrator then diagnosed it as "the transport layer garbles certain one-character string literals", switched to `\u002e` escapes and `String.fromCharCode(46)`, and the fix landed. About 400 of the run's 682 s.

Checks: it does not reproduce on a short prompt at temperature 0 against the same server (three tries, exact output); the shuffled run on the same server minutes later has zero occurrences; one run from 2026-09-12 on a different server instance shows the identical substitution (`[""]` written as `[" cant"]`) in its reasoning. Two of 108 runs, both while reasoning about arrays of empty or dot strings. Filed as a rare fault of this model/quant, not of the cache-ram change or the seed fix. Worth a retry rule only if it recurs.

### Two harness fixes that came out of these runs

- **Seed no longer charged** (`c11f147`): 02-12-29's orchestrator fetched two records (1 354 chars) with no refusal. The refusal seen in 01-41-50 would not recur.
- **Trace join** (`lib/context-trace.mjs`): a fresh worker whose 120 s join window also contained an earlier worker's `subagents:resuming` event claimed the resume, because the FIFO picked the earliest unclaimed event of either kind. On 02-24-17 the tester lane wore the implementer's description and type. Spawn candidates are now tried first and a resume is only a fallback; test added.

### What this settles

- On a class-A level-1 task (complete spec, stub workspace, sub-6-minute control) the roster has no repeatable win, the scout has never been spawned in six runs, and the tester catches the oracle's case one time in three.
- Task memory has one demonstrated effect on pathnorm: a brief that names the trap passes first try. Getting that line into the brief reliably is a ranking and phrasing problem in the store, not a budget problem any more.
- The next roster measurement should be on a task where exploration is the cost (brownfield or staged: `raid-gear`, `orbit`, `dw-bronze`), per the class/level ladder in the session notes. Pathnorm has said what it can.
