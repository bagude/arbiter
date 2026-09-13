# Working Context (slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim the orchestrator's and workers' working context inside a run: large tool results become handles with excerpts and a recall tool, and the supervisor compacts the orchestrator at phase boundaries with a two-part checkpoint.

**Architecture:** A pure projection policy (`lib/policies/result-handles.mjs`) applied by a guard on pi's `context` event with a `recall_result` tool; a `checkpoint` tool that appends to a run file and emits a lifecycle event; a pure compaction policy (`lib/compaction.mjs`) driven by the supervisor at boundaries through pi's RPC `compact` command. Session logs are never edited; only projections change.

**Tech Stack:** Node 26, `node:test`, TypeScript pi extensions, pi 0.85.1 RPC (`compact`, `agent_settled`), existing guard kit.

**Spec:** `docs/superpowers/specs/2026-09-13-working-context-design.md`

## Global Constraints

- Work in `C:\Users\user\open_harnessess\pi\arbiter` on a branch off `master`. Never touch the pi checkout.
- Commit with `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit …`; end messages with the two attribution lines.
- Run tests with `node --no-warnings=ExperimentalWarning --test "test/**/*.test.mjs"`; all must pass.
- Sizes from the spec: handle threshold 8 192 bytes, after 2 assistant turns, head 1 024 bytes, tail 512 bytes, recall pages 16 KB or 400 lines; compaction defaults 30 000 tokens, max 3, gap 5 turns, checkpoint wait 120 s.
- Never edit the session log; the guard changes only the `context` projection. Fail open on any archive error.
- Lifecycle event names: `handles:archived`, `handles:recalled`, `checkpoint:written`.

---

### Task 1: Result-handles policy

**Files:** create `lib/policies/result-handles.mjs`; test `test/result-handles-policy.test.mjs`.

**Produces:** `handleMessages(messages, { minBytes, fullTurns, headBytes, tailBytes, archive })` → `{ messages, archived: [{ id, tool, bytes, lines }] }`; `handleIdFor(message)`; `placeholderFor({ id, tool, bytes, lines, head, tail, omitted })`; `readSlice(file, offset, { maxBytes = 16384, maxLines = 400 })` → `{ text, bytes, lines, nextOffset, eof }`.

- [ ] Tests: a 9 KB `read` result older than two assistant turns is replaced, its `toolCallId`/`toolName`/`details` kept, placeholder contains the id, byte count, head, tail and the recall hint; a 9 KB result with one assistant after it is untouched; a 2 KB result is untouched; an `isError` result is untouched; a `subagent` tool result over the threshold is replaced (worker reports); applying the policy to its own output changes nothing and archives nothing new; `archive` is called once per id across two applications; `readSlice` pages a 40 KB file in 16 KB steps with `nextOffset` and `eof`.
- [ ] Implement following `lib/policies/context-diet.mjs` (same `assistantsAfter` walk). Id: `h_` + sha256(`${toolName}\0${toolCallId}\0${sha256(text)}`).slice(0, 12). Head/tail cut on whole lines.
- [ ] Commit: `working context: result-handles policy`.

### Task 2: Result-handles guard, recall tool, lifecycle folding, config

**Files:** create `ext/guards/result-handles.ts`; modify `lib/workers.mjs` (fold `handles:*` into `tracker.handles = { archived, recalled, bytesArchived, byRole }`), `lib/config.mjs` (`guards.result_handles`), `lib/patterns.mjs` (`recall_result` in both role lists), `supervisor.mjs` (GUARDS list, env `ARBITER_RESULT_HANDLES` JSON options or "", `ARBITER_RESULTS_DIR` = `runs/<id>/results`, summary.handles); tests `test/workers-handles.test.mjs`, `test/config.test.mjs`.

- [ ] Guard: on `context`, run `handleMessages` with `archive` writing `<ARBITER_RESULTS_DIR>/<id>.txt` (mkdir, write once, `O_EXCL`), report each new archive with `kit.emit("handles:archived", ctx, { id, tool, bytes })`, return the projection; unset env registers nothing. Tool `recall_result({ id, offset? })`: validate `^h_[0-9a-f]{12}$`, read the slice, header `[recall_result id=… offset=… next_offset=… eof=…]`, emit `handles:recalled`.
- [ ] Config: `guards.result_handles` joins `context_diet` in the known set; explorer configs set `"guards": { "result_handles": true }`.
- [ ] Smoke: pi print mode with the guard, a prompt that reads a 20 KB file three times and then calls `recall_result` on the placeholder id; expect one archive event and one recall.
- [ ] Commit.

### Task 3: Checkpoint tool

**Files:** create `ext/checkpoint-ext.ts`; modify `lib/workers.mjs` (fold `checkpoint:written` → `tracker.checkpoints = [{ n, findings, questions, steps, ts }]`), `lib/patterns.mjs` (`checkpoint` in `ORCHESTRATOR_TOOLS`), `prompts/orchestrator.md` (one paragraph), `supervisor.mjs` (env `ARBITER_CHECKPOINT_FILE` = `runs/<id>/checkpoint.jsonl`, load with `-e` for the orchestrator); test `test/workers-handles.test.mjs`.

- [ ] Tool schema: `findings: [{ claim: observed|interpreted|hypothesis, text: string ≤ 600, evidence_refs?: string[] }] (≤ 24)`, `open_questions: string[] (≤ 12)`, `next_steps: string[] (≤ 12)`. Appends `{ ts, n, findings, open_questions, next_steps }`; replies `checkpoint #n recorded (f findings, q questions, s steps)`.
- [ ] Commit.

### Task 4: Compaction policy

**Files:** create `lib/compaction.mjs`; test `test/compaction.test.mjs`.

**Produces:** `contextTokensOf(usage)`; `decideCompaction({ contextTokens, threshold, compactions, maxCompactions, turnsSinceLast, minGapTurns, busy, workersLive })` → `{ compact, reason }` with reasons `below_threshold | busy | worker_live | max_reached | too_soon | off | ok`; `composeInstructions({ ledger, checkpoint })` → string; `ledgerLines({ probes, memoryCalls, workers, oracle, time })` → string[].

- [ ] Tests for every reason; the composer keeps ids verbatim, labels the two parts, and says "(no checkpoint was written)" when absent; `contextTokensOf({ input: 100, cacheRead: 900 })` is 1000.
- [ ] Commit.

### Task 5: Supervisor wiring

**Files:** modify `supervisor.mjs`, `lib/messages.mjs` (`compaction.checkpointRequest`, `compaction.done`), `lib/config.mjs` (caps `compactAtTokens` 30000, `maxCompactions` 3, `minGapTurns` 5, `checkpointWaitSec` 120), `lib/transcript.mjs` (`summary.compactions`, `summary.handles`, `summary.checkpoints`), tests `test/config.test.mjs`, `test/messages.test.mjs`.

- [ ] Track `s.contextTokens` and `s.turnsSinceCompaction` on assistant `message_end`.
- [ ] Boundary flags: after the `pendingDecisionFor` hand-off, on gate rejection in `handleApproval`, on a failed oracle in `runOracle`.
- [ ] Pump-tick state machine: `boundaryPending` → decide → request checkpoint → wait for `checkpoint:written` or deadline → `send("orchestrator", { id: "compact-<n>", type: "compact", customInstructions })` → on `response` with that id: audit `compaction`, timeline `{ kind: "compaction", body }`, `compactions.push(...)`, reset counters, deliver `M.compaction.done`. On `success: false`: audit `compaction_failed`, no retry until the next boundary.
- [ ] Summary fields; transcript renders compactions.
- [ ] Commit.

### Task 6: Context report, live run, docs

**Files:** create `tools/context-report.mjs`; modify the two explorer configs (`guards.result_handles`, caps compaction on), `docs/batch/working-context.md`, `docs/backlog.md`.

- [ ] `node tools/context-report.mjs <run>`: per role, per request context tokens (input + cacheRead) and the tool called, peak, totals; lists compactions and archives from summary.json. Run it on 03-17-50 for the baseline.
- [ ] Live: one `dw-explore-real` run with handles and compaction on. Compare. If the orchestrator never reaches 30k, lower `compactAtTokens` to 20k for a second run so the compaction path is exercised at least once.
- [ ] Report and backlog; commit.

## Self-review

Spec coverage: handles → Tasks 1–2; checkpoint → Task 3; policy and composer → Task 4; boundaries, RPC compact, caps, summary → Task 5; measure and live comparison → Task 6. Names: `handleMessages`, `readSlice`, `recall_result`, `checkpoint`, `decideCompaction`, `composeInstructions`, events `handles:archived|recalled`, `checkpoint:written`, caps `compactAtTokens|maxCompactions|minGapTurns|checkpointWaitSec` are used consistently above.
