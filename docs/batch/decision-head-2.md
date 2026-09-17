# decision head, batch 1 continued — the pending-reply mask and the substantive question

2026-09-17. Same six pathnorm runs and the same 102 captured orchestrator states as `docs/batch/decision-head-1.md`. Two changes, applied one at a time so each effect is its own number. No new runs.

## 1. Pending-reply state in the mask (`tools/decision-points.mjs`, `44282b4`)

The extractor now records when a probe or done claim is unanswered at a decision point. `done` is invalid while a probe is pending (the done gate would refuse it anyway), and the routing question says a reply is outstanding. Mode A, re-asked on the same states:

| | before the mask | after |
|---|---|---|
| literal agreement | 65.7% | 66.7% |
| gather vs act | 79.4% | 82.4% |
| `answer` class agreement (the "wait" action) | 50% | 80% |
| false-confident at p ≥ 0.95 | 12 | 9 |
| agreement at p ≥ 0.95 | 77% | 80% |

31 of the 102 points are waiting states; the mask removed `done` from 30 of them. It caught one orchestrator doing what the invariant forbids (14-14-08 #18: a done claim sent while a probe was outstanding). The head's picks at waiting states are now `answer` 18 times (5 match) and `probe` 12 (8 match); the orchestrator there mostly checkpointed (9) or sent another probe batch (9). So the remaining waiting-state disagreements are the orchestrator killing time with `context_usage` while the head says "answer" — nothing that costs anything either way. The mask is a correctness fix that pays little on this batch because most waiting-state actions were never real decisions.

## 2. The substantive question (`--substantive`)

The same 102 states, but the head is asked "which state-changing action will you take next, ignoring any reads, memory lookups or checkpoints you might do first?", offered only spawn / resume / collect / probe / done, and scored against the next substantive action in the record. This is a different target, not a better literal head; 4 points have no substantive successor and are skipped.

| | literal question, literal target | substantive question, substantive target |
|---|---|---|
| agreement | 66.7% | **83.7%** |
| top-2 | 78.4% | 88.8% |
| points at p ≥ 0.95 | 46 (45%) | 68 (69%) |
| agreement at p ≥ 0.95 | 80% | **93%** |
| false-confident at p ≥ 0.95 | 9 | 5 |
| cost per point | 1.6 s, 1 token | 1.6 s, 1 token |

By the class of the point's literal action (what the orchestrator did at that very step): points that were an inspect agree 89% on where they were heading; spawn 100%, probe 96%, done 83%, resume 70%. By configuration: test-first 82% agreement with **100%** at p ≥ 0.95 on 68% coverage; control 89% and 93% on 71%; implementer-first 77% and 80% on 68%. By distance: when the substantive action is this very step, 90%; one gather step ahead, 77%; two ahead, 64%.

So the horizon hypothesis holds once the question asks for it. The earlier "next-substantive agreement" numbers (62% and 54%) were the literal head being scored against a question it was not asked. The head knows the control trajectory; the literal question made it answer about the next read.

### The five confident misses are all one shape

| point | config | orchestrator's next substantive action | head, at p |
|---|---|---|---|
| 14-27-08 #7 | implementer-first | resume (after one read) | probe 1.00 |
| 14-27-08 #8 | implementer-first | resume | probe 1.00 |
| 14-43-22 #8 | control | resume | probe 1.00 |
| 14-27-08 #19 | implementer-first | probe | done 0.99 |
| 14-43-22 #18 | control | done (after two checkpoints) | probe 0.97 |

Three are "verify versus re-delegate": the head wants to probe the deliverable, the orchestrator resumed the worker instead. Two are "declare versus verify once more". All five runs passed first try, so the record cannot say which side was right; every one of them is a state where the orchestrator's choice and the head's differ on whether the current evidence is enough. That is the epistemic frontier, and it is five states, not a percentage. Those are the fork candidates.

## What the two batches say together

- **Mechanically predictable from state**: spawn, probe and done, at p > 0.9 in every mode and every configuration.
- **Runtime-constrained, not decisions**: done while a probe is pending; `context_usage` after a supervisor notice; the waiting states in general. The mask removes the first; the others are harness housekeeping and should not be in the policy's problem.
- **The frontier**: resume versus probe, and done versus one more probe. Five of 98 confident calls, all of the same kind.
- **Reasoning at the decision point** (mode B, batch 1) raised confidence from 0.85 to 0.98 without moving literal agreement, kept 11 of 12 confident disagreements, and cost a third of the generative path's decode. Not a gate to build on for this model.
- **A gate on the substantive head** at p ≥ 0.95 would take 69% of decisions with 93% agreement on this task family, 100% on the test-first runs, at one token each. The 7% it gets wrong are the five states above, and those need forks, not more replay.

## Next

1. Fork the five frontier states plus the seven horizon-only misses from batch 1 (twelve forks, two branches each): branch G keeps the recorded gather step, branch A forces the head's immediate substantive action. Record for each: oracle score, subsequent probes, retries, decode tokens, wall, whether the eventual action or its parameters changed, and whether the gathered information was used later. Needs a supervisor mode that starts from a recorded session at call n with the workspace restored to that instant; the per-inference workspace snapshot is the missing piece.
2. Capture on raid-gear, where the orchestrator's horizons are longer and the probe loop is the cost.
