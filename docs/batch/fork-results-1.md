# Paired forks — first read-out (2026-09-17)

Source run `2026-09-17T16-47-16` (pathnorm, test-first roster, 27B; five wrong done claims on `relative(".", "a")`). Null gate: `fork-null-gate.md` (6/6 state match, 5/6 class reproduced). Forks were chosen from the substantive decision head's confident disagreements with the record (`decisions-replay-substantive.jsonl`): every one of its nine disagreements said **probe** where the orchestrator declared done or resumed a worker. Branches: G (no intervention) and A-natural (`--action probe`: the first tool call is forced to the probe class, the model writes the probe). Three replicates per branch. Per-batch tables: `fork-2026-09-17T16-47-16-{21,14,30}-{G,A-natural}.md`. The chain was stopped by the operator during fork 30's A-natural batch; forks 23 and 37 were not run.

## Fork 21 — declare vs verify (recorded: done; head: probe p=0.93)

| branch | first oracle | final | wall s | decoded |
|---|---|---|---|---|
| G ×3 | 68/70, 68/70, 68/70 | 70/70 ×3 | 808 / 428 / 200 | 43k / 12.5k / 11.7k |
| A-natural ×3 | 68/70 ×3 | 70/70 ×3 | 386 / 634 / 368 | 21k / 22k / 23k |

Every replicate on both branches claimed at 68/70 first and fixed the dot case after the verdict. The forced probe never covered the missing case.

## Fork 14 — re-delegate vs verify (recorded: answer then resume; head: probe p=0.98)

| branch | first action | first oracle | final | wall s |
|---|---|---|---|---|
| G 1 | answer | 68/70 | tool-call cap (250) | 1127 |
| G 2 | probe | 70/70 | first try | 329 |
| G 3 | probe | 68/70 | 70/70 | 592 |
| A 1 | answer → probe | 68/70 | 70/70 | 658 |
| A 2 | checkpoint → probe (one denial) | 68/70 | 70/70 | 819 |
| A 3 | probe | 68/70 | 70/70 | 1060 |

Left alone the orchestrator probed first in two of three replicates anyway; the day's only first-try pass came from that branch. Forcing the probe added no first-try passes and cost time. G 1 died at the tool-call cap with its implementer fighting the path guard over the literal `/c/d` (the false positive the harness-text branch's case 5 removes).

## Fork 30 — second declare vs verify (recorded: done after oracle #2; head: probe p=0.91)

| branch | first action | oracles (inherits attempts 1–2) | outcome | wall s |
|---|---|---|---|---|
| G 1 | done | 68, 69, 69 /70 | attempts exhausted | 560 |
| G 2 | done | 68, 70 /70 | passed | 615 |
| G 3 | done | 68, 69, 69 /70 | attempts exhausted | 407 |
| A 1 | (forced probe) | 68, 68 /70 | tool-call cap | 726 |
| A 2 | — | killed mid-run | — | — |

## What the forks say

1. **At the frontier the head names, "verify first" has no value the orchestrator can collect.** In 12 of 12 A-natural replicates across forks 21 and 14 (and the one at 30), the forced probe did not cover the missing case, and the first claim still failed. The head and the orchestrator disagree on *when* to probe but neither knows *what* to probe; the information that resolved every run was the oracle verdict, or luck in what the replicate happened to include.
2. **The state is not the failure.** All twelve null replicates and every G replicate of forks 21 and 14 eventually passed from states the source run failed from, and fork 14 G passed first try once. The source run's five failures were a path, not a property of the state.
3. **The fixes that pay are legibility fixes**, not decision fixes: name the degenerate inputs in the tester's prompt and in the spec (audit case 7), deliver the final verdict, stop the nudge landing after a claim (audit case 2), and un-block the path guard on string data (case 5). All are in probe-match now (harness-text branch).
4. **The runner earned its keep.** Six harness bugs surfaced only because forks ran: post-finish EPIPE, inherited decisions counted as the fork's, the report overwritten per branch, a rejected continue read as non-reproduction, `lastStartedSeq` not re-seeded, and the fork's request index (which also invalidated a Jev result, `jev-3.md`).

Not done: forks 23 and 37, A-oracle (undefined for these points), and any fork on a class-C task. The chain script and the reports stay; the next experiment on this runner should be one where the head's action is *known to be right* (a recorded gather step whose result was never referenced later), which is the value-of-information question the spec asked and these forks could not reach.
