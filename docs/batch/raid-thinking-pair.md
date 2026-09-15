# raid: three runs — old supervisor, fixed supervisor, worker thinking off (2026-09-15)

The largest implement-to-spec task so far (`tasks/raid`, 47 hidden tests over seven stages plus a three.js scene), run three times on the local 27B in both seats. Run 1 is the night's first run on the pre-fix supervisor (`docs/batch/raid-first-run.md`). Runs 2 and 3 are batch `raid-night-3` on branch `probe-match` (probe verdicts from probe.mjs, canonical repeat guard): the same config, then `configs/orch-raid-27b-nothink.json` with the worker's thinking off (chat-template `enable_thinking=false` via the `~/.pi/agent/models.json` override; orchestrator unchanged). This is the second thinking pair the backlog asked for before any default flips.

| | run 1 `03-11-27` (old supervisor) | run 2 `12-05-53` (fixed) | run 3 `13-22-13` (fixed, worker thinking off) |
|---|---|---|---|
| outcome | 47/47 on claim 2 (claim 1: 46/47) | 47/47 on claim 1 | 47/47 on claim 1 |
| wall | 4033 s (67 min) | 4579 s (76 min) | **1864 s (31 min)** |
| workers | 4 (3 build + 1 fix) | 5 | 5 |
| probes | 44 | 17 | 18 |
| tool calls | 154 | 126 | 138 |
| fresh tokens (in + out) | 1 079 981 | 1 106 960 | **689 532** |
| worker output tokens | 164 608 | 170 471 | **52 509** |
| worker thinking chars | 329 547 | 314 486 | **0** |
| worker fresh tokens | 321k | 324k | 174k |
| orchestrator fresh tokens | 759k | 783k | 516k |
| compactions | 3 | — | — |
| guards | bash_timeout ×6, path ×1 | bash_timeout ×2 | bash_timeout ×16 |

## Reading

- **The probe fix did what it was meant to.** Probes fell from 44 to 17 on the same task, and the run passed on its first claim. Wall did not fall because the orchestrator split the work into five workers rather than three, which is a planning choice, not a cost of the fix.
- **Worker thinking off is a clean win here: 2.5× faster, 38% fewer fresh tokens, same 47/47, first claim.** The workers' output shrank to under a third (52k vs 170k) with the thinking channel measured at zero characters, so the switch is doing exactly and only what it claims. The orchestrator, unchanged, also spent less (516k vs 783k), because it waited less and probed a leaner transcript.
- **The cost of no thinking shows up as more shell attempts.** Sixteen bash-timeout rewrites against two: the workers without thinking try things and rerun rather than reason first. On this task it did not hurt the oracle. It is the thing to watch on tasks where a wrong first attempt is expensive (the campaign's real-data explorations).
- **Together with `docs/batch/thinking-level.md`** (dw-explore-real: 14/14 both ways, 568 s vs 861 s, 202k vs 331k tokens), that is two paired tasks, N=1 each, both showing worker thinking off faster and cheaper with no oracle loss. Still N=1 per task; the orbit pair the backlog asked for remains owed before a default flip.

## The cost of the manager, for the record

The local model is free; the metered seat was the Claude Code manager on a Max subscription. Over the whole night (seven tasks authored, nine runs supervised): 274k output tokens, 68.6M cache-read tokens, $50.74 list-equivalent at Fable 5.1 rates, of which $27.52 (54%) was 120 one-line replies to run notifications and $18.73 the actual authoring, fixes, launches and reports. The local pair did 15 fresh tokens for each fresh token of the manager's real work. Lesson recorded: one background wait per outcome, never an event stream.
