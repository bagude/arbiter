# Jev on the done claim (2026-09-17) — RETRACTED result, corrected below

Question: from the state the orchestrator sent its done claim from, can Jev predict what the hidden acceptance test will say? Tool: `tools/jev-done.mjs`.

## What was first published, and why it was wrong

The first measurement (17 claims, AUC 0.86, six of eleven failing claims caught with zero false alarms, the `edge` verdict right every time) was an artifact. For a fork run, `decisions.jsonl` carries the inherited history while `requests/` numbers from the fork's own first inference, so mapping decision `i` to request `i+1` read a state from well AFTER the claim — every one of the six fork rows contained the oracle's own `68/70` verdict and the "not done" message. Found by the branch review; fixed by `requestSeqFor(i, forkCall)` in `lib/jev.mjs`, used by both `jev-done` and `jev-replay`. The eleven non-fork rows were leak-free and gave AUC 0.80, but that is five failures against six passes.

## Corrected measurement

Leak-free states, every done claim with a verdict across the captured runs (source runs and forks, claims from the fork's own points only): **48 claims, 25 failed, 23 passed.** Same questions as before (pass truth value, pass/edge/other verdict, coverage truth value), ~400 ms each.

| sample | n | fail / pass | AUC (pass value) | `edge` verdicts that were failures | mean p(pass): failing vs passing |
|---|---|---|---|---|---|
| all | 48 | 25 / 23 | **0.45** | 7 of 12 | 0.58 vs 0.54 |
| non-fork runs | 11 | 5 / 6 | 0.80 | 3 of 3 | 0.48 vs 0.69 |
| fork runs, first claim | 19 | 15 / 4 | 0.31 | 1 of 1 | 0.67 vs 0.54 |
| fork runs, later claims | 18 | 5 / 13 | 0.59 | 3 of 8 | 0.39 vs 0.47 |

Split once more by whether a PRIOR oracle verdict is visible in the state (a second or later claim): the 21 rows that can see one score 0.69, the 27 that cannot score 0.41 — so on clean first-claim states Jev is below chance and the pooled figure is flattered by the verdict-bearing rows.

There is no usable signal. On the largest homogeneous group, the forks' first claims, Jev is confidently wrong: fifteen of nineteen failed and it rated them more likely to pass than the ones that passed. The `edge` verdict is right 7 of 12 times overall, which at a 52% base rate is chance. The non-fork AUC of 0.80 rests on five failures and is inside the noise of a sample that small.

## What this means for the guard

The done-claim guard was wired on the strength of the retracted number. It stays wired, because it is cheap and reversible and every step is recorded, but the live config ships it in **shadow** mode: the same questions are asked at every claim, the same events are logged, and nothing is held. Flipping `doneGuard` to `nudge` should wait for the shadow rows to show a signal on the runs that matter (the forks' first claims are the failure mode the whole day turned on, and that is where Jev is worst).

Why it fails is consistent with jev-1's finding on resume: the answer depends on what the transcript does not make legible. Whether `relative(".", "a")` was verified is a fact about which probe cases were sent, buried in a 66-case JSON body inside a tool result; a reader judging from prose cues ("all tests pass", "25/25 matched") has no purchase. The deterministic version of this check, "does the probe history cover the spec's stated examples and the degenerate inputs per function", needs no model and is the fix the audit already named (case 7).
