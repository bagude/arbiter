# Working context, slice 2 — live runs (2026-09-13, branch working-context)

Handles: tool results and worker reports over 8 KB leave the projected context after two turns (id, head, tail, `recall_result`). Compaction: at a phase boundary with the orchestrator's context at or above 30 000 tokens, the supervisor asks for a checkpoint, then issues pi's `compact` with the run ledger and the checkpoint as instructions. Measure: `node tools/context-report.mjs <run>` (context tokens per request from the session files).

| run | feature | orchestrator peak | orchestrator prompt tokens | worker peak | worker prompt tokens | compactions | oracle | wall s |
|---|---|---|---|---|---|---|---|---|
| 2026-09-13T03-17-50 | none (baseline) | 79 963 | 606 595 | 65 874 | 548 800 | 0 | 14/14 | 942 |
| 2026-09-13T13-55-16 | handles (poll-driven compaction never fired) | 45 764 | 349 880 | 49 270 | 366 140 | 0 | 13/13 | 481 |
| 2026-09-13T14-05-03 | handles + event-driven compaction | 50 189 → 25 983 after compacting | 316 880 | 61 012 | 906 285 | 1 | 14/14 | 658 |
| 2026-09-13T14-28-13 | + thinking drop + write elision (slice 3) | 40 062 → 25 285 by projection alone | 167 819 | 37 881 (two workers: 19 930, 37 881) | 185 016 (103 944 + 81 072) | 1 issued, run finished before it completed | 14/14 | 643 |

## What happened in 14-05-03

- 22 s: the orchestrator's 10 KB read archived as a handle; recalled at 112 s when it was needed.
- 280 s: the worker's 8.5 KB bash output archived.
- 575 s: the worker reported; the decision fired at that event with the context at 40 291 tokens; checkpoint requested.
- 598 s: checkpoint #1 written (12 findings, 3 open questions, 4 next steps).
- 601 s: `compact-1` issued with 5 578 characters of instructions (ledger + checkpoint); pi summarised for 34 s.
- 605 s: a probe result delivered during the summary was refused by pi and lost; the orchestrator re-probed. Fixed afterwards: deliveries queue during a compaction and flush after the reply.
- 635 s: 50 415 → 20 733 tokens; summary 4 741 characters; the orchestrator resumed from it and passed the oracle 23 s later.

## Reading the numbers

- The orchestrator's prompt total halved against the baseline in both feature runs, but most of that is run-to-run variance in the model's own output (a 3k-token brief instead of the baseline's 30k). The mechanism's own contribution is visible in the per-request trace: after `compact-1` the orchestrator worked at 26k instead of 50k for the rest of the run.
- Handles saved about 6k tokens per request for as long as an archived result stayed out; in 13-55-16 the model recalled the archived deliverable two seconds after archiving, and the recall page was then archived again. Recall pages are now exempt from archiving.
- Poll-driven compaction never found a gap between generations (13-55-16 crossed its boundary at 449 s and finished 32 s later uncompacted). Deciding at the boundary event itself fixed that.
- The worker in 14-05-03 did more work (28 requests, 906k prompt tokens) than in the other runs; nothing in this slice compacts workers.

## Slice 3: thinking drop and write elision (2026-09-13T14-28-13)

Where a worker's context came from in the two earlier runs: thinking blocks 36–39%, write arguments 24–39%, tool results 14–32%. Two projection edits address the first two, both roles, no compaction involved: the context-diet guard enabled with result-ageing off (drops prior turns' thinking) and a new call-args guard (the file contents inside write/edit calls older than two turns become a stub naming the path and size; the file is on disk).

- Orchestrator: peak 40 062, prompt total 167 819 (baseline 606 595, −72%). The projection alone took request 7→8 from 40 062 to 25 285 tokens: thinking dropped on 8 requests, the worker's 8.4 KB report archived.
- Workers: two this run, prompt totals 103 944 and 81 072 (the single baseline worker: 548 800; 14-05-03: 906 285); thinking dropped on 7 requests, write arguments elided on 3.
- Oracle 14/14; for the first time the explorer labelled two observations `interpreted`.
- Compaction was decided at 596 s and issued at 627 s, but the quiescence oracle trigger fired during pi's summary (the aborted turn looked idle), graded the workspace 14/14 and finished the run before the compaction completed. Fixed afterwards: neither the quiescence trigger nor the idle nudge fires while a compaction is in progress.

## Open

- In-process worker compaction stays deferred: after slice 3 the workers' remaining context is mostly current work, and the abort-and-continue inside pi-subagents is the risky part.
- `fullTurns` of 2 may be too eager for results the orchestrator is about to verify; 3 or a per-tool setting is worth a test.
- The summary is pi's native one with our instructions; nothing yet checks that it kept every id verbatim.
