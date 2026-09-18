# The outer loop, cycle 1 (2026-09-18)

The inner loop is the agent's: *what should I do next to complete the task?* The outer loop is ours: *which alternative should we test to learn how this agent could perform better?* This document records one full turn of the outer loop as it was actually run, so the next turn can be automated against it.

## The cycle

| step | what | tool | who judged |
|---|---|---|---|
| 1 | Observe one live run with every inference captured and shadowed | `supervisor.mjs --config configs/orch-pathnorm-27b-jev.json` | nobody |
| 2 | Extract its decision points: action class, valid mask, next substantive action, gather steps | `tools/decision-points.mjs` | nobody |
| 3 | Ask two cheap heads what they would have done at every point | `tools/decision-replay.mjs --substantive` (27B), live shadow rows via `tools/jev-replay.mjs --no-mask` (Jev) | nobody |
| 4 | Select the points worth a fork | rule below, applied by hand this cycle | me |
| 5 | Fork each: G continues as recorded, A-natural forces the heads' action; three replicates each | `tools/fork.mjs`, chained by `runs/.fork-chain.mjs` | nobody |
| 6 | Measure: first-try oracle, final oracle, wall, decoded tokens, probes, resumes; whether the skipped gather's result was ever referenced | fork reports + this document | me |
| 7 | Retain what holds up: a finding, a rule, or a harness change | `docs/batch/*.md`, the roster, the guards | me, with the user |

Steps 1–3 and 5 are mechanical today. Step 4 is the judgment this cycle supplies by hand and the one an automated outer loop would have to own; its rule is stated precisely so it can be.

## Step 4, the selection rule as applied

A point is a candidate when all of these hold:

1. **The recorded action is a gather** (inspect, memory, checkpoint) and the recorded *next substantive action* S follows within a few steps. The question is whether the gather bought anything.
2. **Both heads say S now**, confidently: the 27B substantive head at p ≥ 0.85 and Jev picking S. Two different models agreeing on "act now" is the signal that the gather may be skippable, and it is the situation the confidence-gated hybrid would act on.
3. **No deterministic guard requires the gather.** A read of the tests before an implementer spawn is required by the topology nudge, so forcing the spawn there just produces a denial and the G branch (fork 21/14 lesson, and the Task 3 ruling). Calls 6, 10 and 12 in this run are excluded for that reason.
4. **The gather is cheap to skip in principle**: an `ls`, a re-read of a file already in context, a checkpoint, a memory note to the future. Not a first read of the spec or the module.

Applied to run `2026-09-18T00-01-44` (25 points; 27B substantive agreement 20/24, Jev 18/24, heads agree 22/24), the candidates were:

| call | recorded | next S | steps | 27B | Jev | guard? | chosen |
|---|---|---|---|---|---|---|---|
| 1 | read README | spawn tester | 4 | spawn 1.00 | spawn 1.00 | no | no — first read of the workspace, not cheap to skip |
| 2 | read src/pathnorm.mjs | spawn | 3 | spawn 1.00 | spawn 1.00 | no | no — same |
| 3 | memory_get ×3 | spawn | 2 | spawn 1.00 | spawn 1.00 | no | no — the seed records feed the brief |
| **4** | `ls .` | spawn tester | 1 | spawn 1.00 | spawn 1.00 | no | **yes** — a listing of a directory already read |
| 8 | grep tests | spawn implementer | 1 | spawn 0.93 | spawn 0.96 | **yes** (tests:unread) | no |
| **13** | `ls src` | resume tester | 1 | resume 0.99 | resume 0.84 | no | second choice — held for a later cycle |
| **15** | grep tests | probe | 1 | probe 1.00 | probe 0.94 | no | second choice — the grep may shape the probe body |
| 21 | memory note | done | 3 | done 1.00 | done 0.96 | no | no — a note to the future has no value *for this run* by construction |
| **22** | re-read src/pathnorm.mjs | done | 2 | done 1.00 | done 0.53 | no | **yes** — "verify once more" after three matched probes; the day's central question |
| 23 | checkpoint | done | 1 | done 0.94 | probe 0.80 | no | no — heads disagree |

Two forks: **call 4** (skip the listing, spawn now; A-natural `--action spawn`) and **call 22** (skip the re-read and the checkpoint, claim now; A-natural `--action done`). Three replicates per branch, both under the jev config so the shadow keeps recording. Null gate: this run's states are captured the same way as the one the gate passed on (6/6 state match, 5/6 class), and the runner re-verifies the first request of every replicate.

## What each fork can and cannot say

- **Call 4.** If A-natural passes as often as G and costs less, the listing had no value at that point and a head confident at 1.00 could be trusted to skip it: one inference (~25 s, ~2k decoded tokens) per run. If A-natural is worse, the listing carried something the brief needed and the heads' confidence was misplaced — the more interesting result, because both heads were certain.
- **Call 22.** The recorded orchestrator re-read the code and checkpointed before claiming, and passed. If A-natural also passes ×3, the re-read was ceremony and "verify once more" has no value once the probes match; if it fails, the re-read was catching something the probes did not, and the 27B's 1.00 was a false confidence on the exact frontier (declare vs verify) the earlier forks probed from the other side.
- Neither fork can show *automatic improvement*. They show whether a head's confident "act now" is safe at these two points. A rule that generalises needs the same test across runs and tasks, which is step 7's job.

## Results

Both forks: every replicate on both branches passed the oracle first try (12 of 12 at 70/70). The question each fork asked is therefore answered by cost and by what the unforced replicates chose to do.

### Call 4 — skip the listing, spawn the tester now

| branch | first action | first-try oracle | wall s | decoded |
|---|---|---|---|---|
| G 1 | spawn | 70/70 | 389 | 22.4k |
| G 2 | spawn | 70/70 | 606 | 36.4k |
| G 3 | ls, then spawn | 70/70 | 289 | 25.3k |
| A 1 | ls denied ×1, spawn | 70/70 | 403 | 24.8k |
| A 2 | ls denied ×1, spawn | 70/70 | 403 | 19.3k |
| A 3 | ls denied ×2, spawn | 70/70 | 564 | 34.6k |

The listing had no value: nothing downstream differed. Left alone, the orchestrator skipped it in two of three replicates, so the recorded gather was sampling noise and the heads' 1.00 matched the model's majority behaviour rather than correcting it. Forcing the spawn cost more than the inference it saved: every A replicate attempted the listing first, took one or two guard denials, then spawned.

### Call 22 — skip the re-read of the source, claim done now

| branch | actions from the fork | first-try oracle | wall s | decoded |
|---|---|---|---|---|
| G 1 | checkpoint, done | 70/70 | 33 | 0.7k |
| G 2 | checkpoint, done | 70/70 | 21 | 0.9k |
| G 3 | checkpoint, done, answer | 70/70 | 22 | 1.2k |
| A 1 | checkpoint denied, done | 70/70 | 20 | 0.8k |
| A 2 | checkpoint denied, done, answer | 70/70 | 22 | 1.2k |
| A 3 | checkpoint denied, done, answer | 70/70 | 107 | 9.7k |

Same shape at the frontier the earlier forks approached from the failing side: after three matched probes the re-read was ceremony, and not even the model's own ceremony — no G replicate re-read the source; all three checkpointed and claimed. The forced branch saved nothing and once cost a long answer turn.

## What this cycle retains

1. **Finding f1 (candidate):** at a gather of kind `ls` or a re-read of a file already in context, where both heads name the next substantive action at p ≥ 0.95, skipping the gather changes neither first-try nor final oracle. Settlement criterion: the same on a second run. Evidence: the twelve rows above.
2. **Finding f2 (candidate):** a recorded gather at such a point is often not the model's modal choice. Two of three unforced replicates skipped the listing and three of three skipped the re-read. A confident head at these points is a majority vote over the model's own samples, which is useful for prediction and says nothing about correction.
3. **A rule for the management spec, retained now:** the way to act on a settled "skippable gather" finding is not to force the substantive action at the tool edge. Forcing made the model fight the guard and cost more than the gather. The promotion path is to remove the reason for the gather (the listing was of a directory already read; the re-read followed probes that already matched) or to pre-answer it, which is the harness's job, not the manager's. This changes §8 of the spec: `compare` settles findings; a settled finding of this kind becomes a prompt or a pre-answered tool result, never a forced action.
4. **What the cycle did not show:** any automatic improvement, or anything about the failing frontier. Both points were chosen because both heads were certain, and certainty here meant the gather was already optional. The informative forks are the ones where the heads are confident and the model is not modal — the failing run's claims — and those need the failure-side signal the retracted jev-3 was meant to supply.

Cost of the cycle: one observed run (11 min), two replays (2 min), twelve fork replicates (52 min), all on one server slot.
