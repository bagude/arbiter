# decision head, batch 1 — shadow replay over 102 orchestrator decisions

2026-09-17. Six pathnorm runs with provider-request capture (`ext/replay-capture.ts`): two single-worker controls, three test-first roster runs, one implementer-first roster run. All six passed 70/70 first try. Every orchestrator inference became a `DecisionPoint` (`tools/decision-points.mjs`), and each was replayed twice through `tools/decision-replay.mjs` against the same server the runs used:

- **Mode A**: the exact captured state, thinking off, one decoded token — P(action | state).
- **Mode B**: the same state, thinking on; the model's own reasoning is then placed inside the open think block and one token is scored — P(action | state, generated reasoning). Two calls, because with speculative decoding the server attaches probabilities only to tokens the target sampled itself.

Nine action classes with fixed one-token symbols: spawn, resume, collect, probe, done, inspect, memory, checkpoint, answer. Only the actions the harness would accept at that point are offered (`validMask`), and the distribution is renormalised over them.

## The matrix

| horizon | A: P(a \| s) | B: P(a \| s, reasoning) |
|---|---|---|
| literal next action | 66% | 66% |
| next substantive action | 62% | 54% |
| gather vs act | 79% | 85% |
| top-2 (literal) | 79% | 75% |
| mean confidence | 0.85 | 0.98 |
| cost per point | 1.4 s, 1 token | 8.2 s, 606 reasoning tokens |

Reasoning flipped the gather-vs-act call on 12 points, 9 of them toward what the orchestrator did; every one of those 9 is on a test-first run (69% → 85%); the controls (95%) and the implementer-first run (70%) did not move. Mode B's reasoning across the batch was 61.8k tokens against the generative path's 173k, so the "cheap" reasoning head is a third of the expensive one and buys no literal accuracy.

By actual class, both modes: spawn 100% (p̄ 0.98), done 100% (p̄ 1.00), probe 96% / 80%, resume 60% / 60%, inspect 54% / 61%, answer 50% / 40%, memory 0% (n=3), checkpoint 0% / 33%. The checkpoint points are `context_usage` calls the supervisor's time-and-context notices provoke; nothing in the state predicts them and they are housekeeping, not decisions.

## What reasoning did and did not do

It did not change the confident disagreements. Of the 12 points where mode A was at p ≥ 0.95 and disagreed with the orchestrator, 11 are still wrong in mode B at p ≈ 1.0, with the same pick, after 38 to 2 048 reasoning tokens. These are stable policy differences, not noise: the head, with or without reasoning, wants to spawn, probe or claim done now; the orchestrator in the recorded run read one more file first. The single flip toward the orchestrator (14-51-39 #15, done → inspect) came after 780 tokens.

It did raise confidence. 94 of 102 points sit above 0.95 in mode B, at 67% agreement, against 52 points at 77% in mode A. On this batch the price of cognition bought certainty, not correctness. Any gating threshold should be set on mode A's distribution; mode B's is not calibrated.

## The residual is mostly one state the alphabet cannot express

31 of the 102 points are states where the orchestrator has sent a probe or a done claim and the supervisor's reply has not arrived yet. What the orchestrator did there: checkpoint 9, another probe 9, a text answer 6, inspect 3, resume 2, memory 1, done 1. The head disagreed on 19 of those 31 in mode A and 16 in mode B, and said `done` while a probe was still outstanding 4 and 5 times. Those waiting states are **19 of mode A's 35 disagreements and 16 of mode B's 35**.

This is not a head failure; it is a mask failure. The harness knows a reply is outstanding. Two changes follow: `done` is invalid while a probe is unanswered (the done gate would refuse it anyway), and the state record carries `pendingReply` so the head's question can say so. The remaining waiting-state actions (checkpoint, a text answer, another probe batch) are the orchestrator killing time; a head that says "inspect" there is not wrong in any way that costs anything.

## The horizon question, answered against the question asked

Next-substantive agreement came out below literal, not above, and mode B lowered it further. The confusion table says why: at gather points that precede a spawn, the head says inspect 13 times and spawn 7, and reasoning makes it more literal, not less. The routing question asks what the model will do next, so the head is answering the immediate horizon and the "substantive" label measures a different question. The seven horizon-only false-confident cases in mode A (inspect → spawn/probe/done one step later) are the cases where the head skipped the read the orchestrator made. Whether that read was worth making is exactly the paired-fork question and cannot be read off this batch.

## Threshold curve, mode A

| τ | coverage | agreement | decoded tokens on covered points | inference s on covered points | false-confident |
|---|---|---|---|---|---|
| 0.80 | 68% | 71% | 85% | 1 349 | 20 |
| 0.90 | 60% | 75% | 79% | 1 256 | 15 |
| 0.95 | 51% | 77% | 70% | 1 092 | 12 |
| 0.98 | 38% | 79% | 48% | 745 | 8 |

With the waiting-state mask fix, 19 of the disagreements leave the pool before any threshold is applied; the curve after that fix is the one to read gating decisions from.

## What this settles, and what is next

- Spawn, probe and done are mechanically predictable from state in this task family, at p > 0.9, in both modes. Resume and inspect are not, and reasoning does not make them so.
- Reasoning at the decision point is not where the orchestrator's cognition pays: it raises confidence, moves gather-vs-act on the test-first runs only, and costs a third of the generative path.
- Next, in order: (1) `pendingReply` in the state and the mask, then rerun mode A on the same 102 points, which needs no new runs; (2) a routing-question variant that asks for the next substantive action, to score the horizon honestly; (3) paired forks on the five substantive disagreements (probe-vs-resume ×3, done-vs-probe ×2) to measure the value of the read the orchestrator made; (4) capture on raid-gear, where the orchestrator's decisions are longer-horizon.
