# Fork runner — null gate (2026-09-17)

Source run: `2026-09-17T16-47-16` (pathnorm, test-first roster, 27B; failed five done attempts on `relative(".", "a")`, see `docs/batch/harness-text-audit-2026-09-17.md`). Three recorded states restored with no intervention, two replicates each, code as merged to probe-match at d02524e (+ the two runner reading fixes 8dcf35a). Per-batch tables: `fork-2026-09-17T16-47-16-{7,10,13}.md` (the call-7 file was rendered before the crash-rule and own-decisions fixes; the numbers below are read from the runs).

## Does a restored state equal the recorded one?

Yes, in every replicate. The fork's first captured provider request equals the source's (`payload.messages` deep-equal, tool set, model, `chat_template_kwargs`) at calls 7, 10 and 13: **6/6 state match**. Counters, the source's tester (restored live-at-fork at call 7, where its completion event landed 6 ms after the request; completed at 10 and 13), its report and the recorded system prompt were restored; the whole workspace came from the per-request snapshot; every recorded absolute path resolved because the fork reuses the source run's out-of-tree paths.

## Does the restored orchestrator do what the record did?

| call | recorded | next substantive (record) | rep 1 | rep 2 | class reproduced |
|---|---|---|---|---|---|
| 7 | inspect (read the tests) | resume after 1 read | inspect (ls) → spawn → resume | inspect (ls) → resume | 2/2 |
| 10 | inspect | spawn after 1 read | inspect → spawn | inspect → spawn | 2/2 |
| 13 | probe (66 cases) | probe | probe (66 cases) | resume the tester: "Add relative(…" | 1/2 |

**5/6 class reproduced, 0 crashed.** The one miss is at the point the substantive head calls with p=0.99 (probe): the model at its default temperature chose to send the tester after the missing test instead. That is the sampler's rate, and it is why the forks run with three replicates.

## Outcomes of the null branches

All six forks passed the oracle (70/70) where the source run never did: 620 s / 361 s (call 7), 293 s / 505 s (call 10), 394 s / 622 s (call 13). Four of six needed a second done attempt (68/70 first). Same state, same model, same harness text — the difference is sampling. This is the strongest evidence yet that the source run's failure was a path, not a property of the state: five of six replicates that diverged from the record found the dot case.

## Harness findings from the live batches

- The supervisor could exit 1 after a complete summary: an `agent_end` still in flight after `finish()` delivered the silent-turn nudge into pi's closed stdin (EPIPE). `send` now returns when finished or the pipe is gone; the runner reads the summary, not the exit code, as the crash signal (`1 (post-finish)` in the exit column).
- The runner's rows read the run's first decision, which for a fork is the inherited opening `ls`; rows now read from index call−1 (`ownDecisions`).
- A fork whose orchestrator exits unexpectedly, or whose decision extraction fails, wears an ordinary summary; both are now excluded from the reproduction fractions rather than counted as non-reproductions.

## Replay of the source run (substantive head, mode A)

38 points: agreement 71%, top-2 82%; p≥0.95 covers 58% at 86%. All nine disagreements are the head saying **probe** where the orchestrator (a) sent `done` — calls 20/21, 29/30, 36/37, i.e. the three wrong claims and their answer-turn predecessors (the head agreed with the byte-identical re-sends at 22/31/38, which suggests it reads the nudge the same way the orchestrator did), or (b) resumed a worker after an answer (14) or after memory searches (23, 24). The head was right about the claims: each was 68/70.

## The forks

Candidates: 21, 30, 37 (declare vs verify) and 14, 23 (re-delegate vs verify). Branches G and A-natural (`--action probe`); A-oracle is undefined here because the head's class differs from the recorded substantive class, so no recorded parameters of the forced class exist. Three replicates each, run as one chain in the order 21, 14, 30, 23, 37. The spec's twelve candidates came from the six earlier replay runs, which predate the whole-workspace snapshot and cannot be forked.
