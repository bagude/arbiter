# Working context, slice 2: handles for large results and supervisor-driven compaction

Date: 2026-09-13 (night of 2026-09-12 local). Repository revision at design time: 5f5e074. Status: approved design.

## Problem

Slice 1 bounded how much memory enters a run. Nothing reclaims what accumulates inside it. Measured on explorer run 2026-09-13T03-17-50 (search mode, 16 000 budget): the orchestrator's context grew from 5.6k to 80k tokens over 16 requests; the worker's from 8.9k to 66k over 20. The growth was the orchestrator's own 30k-token brief, the worker's report returning as a tool result (32k to 64k in one step), and the worker's file writes echoing into its own context (47k to 66k). Total prompt tokens billed: 607k orchestrator, 549k worker, against 58k and 36k output. Removing a record from memory does not remove text already delivered; only changing the messages sent on later turns does.

## Decisions (from the design dialogue)

- Our own code, supervisor-driven. No SoL-Pi dependency.
- Compaction at a phase boundary, only above a size threshold, at most a few times per run.
- The checkpoint has two labelled parts: the supervisor's deterministic ledger and the orchestrator's judgement, written through a tool.
- Handles for tool results and worker reports over a size, for both roles.
- Workers live inside the orchestrator's pi process, so the orchestrator is compacted in place with pi's `compact`; it is never restarted mid-run.

## Measure

`tools/context-report.mjs <run>` prints, per role, context tokens per request (input plus cache reads from the session file), peak, total prompt tokens, total output tokens, and the compactions and archives that happened. Target on the same explorer config: orchestrator peak under 40k (half of today), total prompt tokens down by a third or more, oracle unchanged.

## Handles for large results

`lib/policies/result-handles.mjs`, pure: `handleMessages(messages, { minBytes = 8192, fullTurns = 2, headBytes = 1024, tailBytes = 512, archive })` returns `{ messages, archived }`. A `toolResult` message whose text content exceeds `minBytes` and has at least `fullTurns` assistant messages after it is replaced in the projection by a placeholder:

```
[result handle h_<12 hex> · tool <name> · <bytes> bytes, <lines> lines · archived by the supervisor]
<first 1024 bytes, whole lines>
… (<n> bytes omitted) …
<last 512 bytes, whole lines>
[recall_result(id="h_…", offset=0) pages the original back, 16 KB at a time]
```

The handle id is a hash of tool name, tool call id and content, so the same result maps to the same file; `archive(id, text)` is called once per id (the adapter writes `runs/<id>/results/<handle>.txt`). Error results and non-text results are left alone. The message keeps toolCallId, toolName, isError and details so tool-call pairing never breaks. The session log is never edited.

`ext/guards/result-handles.ts` applies the policy on `context`, registers `recall_result({ id, offset })` (16 KB or 400 lines per page, `next_offset` and `eof` in the header), reports `handles:archived` (id, tool, bytes) and `handles:recalled` (id, offset, bytes) to the lifecycle file, and fails open. Enabled by config `guards.result_handles` (true or options), env `ARBITER_RESULT_HANDLES` and `ARBITER_RESULTS_DIR`; both roles; tool name added to both role lists. The context-diet guard stays available but is not enabled alongside it.

## Checkpoint tool

`ext/checkpoint-ext.ts` registers `checkpoint({ findings: [{ claim, text, evidence_refs? }], open_questions: [string], next_steps: [string] })` for the orchestrator. It appends `{ ts, n, …params }` to `runs/<id>/checkpoint.jsonl`, emits `checkpoint:written` with the entry number and sizes, and answers with the entry number. Claims use the memory vocabulary (observed, interpreted, hypothesis). The orchestrator prompt names the tool and the supervisor asks for one before each compaction.

## Supervisor-driven compaction

`lib/compaction.mjs`, pure:

- `contextTokensOf(usage)` = input + cacheRead.
- `decideCompaction({ contextTokens, threshold, compactions, maxCompactions, turnsSinceLast, minGapTurns, busy, workersLive })` → `{ compact, reason }`; compact only when idle, no live worker, context ≥ threshold, compactions < max, and turnsSinceLast ≥ minGap.
- `composeInstructions({ ledger, checkpoint })` → the custom instructions: a fixed preamble ("keep evidence and interpretation labelled apart; keep every id verbatim; do not invent results"), then `## Run ledger (supervisor)` listing probe ids with verdicts, memory ids fetched, worker ids with report handles, the last oracle result and the time status, then `## Orchestrator checkpoint` with findings grouped by claim, open questions and next steps, or "(no checkpoint was written)".

Supervisor wiring:

- Per agent, `s.contextTokens` is updated from every assistant `message_end` usage; `s.turnsSinceCompaction` counts assistant messages.
- Boundaries: the orchestrator received a worker's result (the existing `pendingDecisionFor` hand-off), a done claim was rejected, an oracle run failed. Each sets `boundaryPending = true`.
- On each pump tick, if `boundaryPending` and the decision says compact: deliver `M.compaction.checkpointRequest`, set `awaitingCheckpoint = { since, deadline: CAPS.checkpointWaitSec }`. When `checkpoint:written` arrives, or the deadline passes with the orchestrator idle, send `{ id: "compact-N", type: "compact", customInstructions }` over RPC. On the response, log `compaction` (tokensBefore, estimatedTokensAfter, summary length, checkpoint yes/no) to the audit and timeline, push to `summary.compactions`, and deliver `M.compaction.done`, which starts the next turn.
- Caps: `compactAtTokens` (30 000), `maxCompactions` (3), `minGapTurns` (5), `checkpointWaitSec` (120). Compaction is off when `compactAtTokens` is 0.
- Workers are not compacted in this slice.

## Testing

Unit: the handles policy (threshold, turns, placeholder shape, pairing kept, errors untouched, idempotent on its own output), slice paging, the compaction decision, the instruction composer, lifecycle folding (`handles:*`, `checkpoint:written`), config parsing. Smoke: pi print mode with both extensions. Live: the explorer config with handles and compaction on, compared with run 03-17-50 by `tools/context-report.mjs`.

## Files

New: `lib/policies/result-handles.mjs`, `ext/guards/result-handles.ts`, `ext/checkpoint-ext.ts`, `lib/compaction.mjs`, `tools/context-report.mjs`, tests. Changed: `supervisor.mjs`, `lib/config.mjs`, `lib/workers.mjs`, `lib/patterns.mjs`, `lib/messages.mjs`, `lib/transcript.mjs` (summary fields), `prompts/orchestrator.md`, the explorer configs, `docs/backlog.md`.
