# Context trace: per-agent, per-call prefix-cache tracking

**Goal:** For any run, reconstruct every LLM call each agent (orchestrator and every worker/subagent, or builder/critic in dyad runs) made, with its context size split into cached and fresh prefill tokens, its output, its wall time split into inference and tool time, and the events that landed on it (spawn, return, resume, guard rewrite, compaction). Expose it as a library function, a CLI, a kpi column, and a lane timeline in the console.

**Why:** On a local llama-server the cost of a run is prefill seconds, not dollars. Every mid-prefix rewrite (context-diet, result-handles) re-prefills the tail because chunk reuse is off on the 27B (q8_0 KV). Today `tools/context-report.mjs` collapses `input + cacheRead` into one number and nothing computes a hit ratio. The 2026-09-15 audit measured a 0.93 cache-read ratio on a guard-free run against 0.61–0.77 on guarded runs, but only by hand.

**Spec:** the design agreed in chat on 2026-09-15 (this file is its written form). No separate spec document.

## Global Constraints

- Node ≥ 22, ESM (`.mjs`), tabs for indentation, no new dependencies, tests with `node:test` under `test/*.test.mjs` (`npm test` runs `node --test "test/**/*.test.mjs"`).
- Windows paths: normalise with `.replace(/\\/g, "/")` before matching, as `tools/context-report.mjs` does.
- Read the archived `sessions/` tree of a run (pi session jsonl), never `raw-*.jsonl`. Role of a session file: a file under `/tasks/` is a worker (`role: "worker"`); otherwise the role is the first path segment under `sessions/` (`orchestrator`, `builder`, `critic`, …). This is the rule `tools/context-report.mjs` already uses.
- Never mutate run directories. Tests use a committed fixture under `test/fixtures/run-trace/` and temp dirs.
- The console stays a single `file://` page with inlined data, Tailwind play CDN and Material Symbols only; every visual is hand-built DOM/inline SVG (no chart library).
- `tools/context-report.mjs` keeps working unchanged.

## Data facts (verified on `runs/2026-09-15T04-19-12`)

pi session jsonl entries (one JSON object per line). Relevant shapes:

```json
{"type":"session","version":3,"id":"01a0a34a-…","timestamp":"2026-09-15T04:19:13.843Z","cwd":"…"}                       // first line; child files add "parentSession":"<orchestrator session id>"
{"type":"session_info","id":"0ed49cc6","parentId":null,"timestamp":"…","name":"orchestrator"}                            // optional
{"type":"message","id":"9a0acc02","parentId":"5e881d27","timestamp":"2026-09-15T04:19:19.380Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"…"},{"type":"toolCall","id":"…","name":"read","arguments":{…}}],"api":"openai-completions","provider":"llama.cpp","model":"qwen3-27b","usage":{"input":6007,"output":72,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":6079,"cost":{…}},"stopReason":"toolUse","timestamp":1789445954793}}
{"type":"message","id":"0ed8888e","parentId":"9a0acc02","timestamp":"2026-09-15T04:19:19.385Z","message":{"role":"toolResult","toolCallId":"…","toolName":"read","content":[…],"timestamp":1789445959385}}
{"type":"message","id":"…","timestamp":"…","message":{"role":"user","content":[{"type":"text","text":"[SUPERVISOR] …"}],"timestamp":1789445954665}}
{"type":"custom","customType":"subagents:record","data":{"id":"8eb067bb-8ebc-4b3","type":"worker","description":"Implement src/gear.mjs","status":"completed","result":"…"}}
{"type":"compaction","id":"4d7bdbf4","parentId":"a47b7b50","timestamp":"2026-09-15T04:39:57.900Z","summary":"…","firstKeptEntryId":"a9301069","tokensBefore":117428,"details":{…},"usage":{…},"fromHook":false}
```

Timestamp semantics for an assistant entry, verified: `message.timestamp` (epoch ms) is when the request started; the entry's `timestamp` (ISO) is when the response was persisted, i.e. the end. Example: msgTs 04:19:14.793, entryTs 04:19:19.380, so inference took 4587 ms. Tool time for a call is the gap from its entry `timestamp` to the next assistant entry's `message.timestamp` in the same file.

Cache identity, verified: on a byte-stable prefix, `cacheRead` of call N equals `totalTokens` of call N−1 (6538 = 6473 + 65). So `retained = cacheRead / prev.totalTokens` is 1.0 when nothing invalidated the prefix and < 1.0 when a rewrite or compaction did.

`lifecycle.jsonl` (run root), `{ts: epochMs, ev, data}`; relevant `ev` values and data fields:

- `subagents:created` `{id, type, description, isBackground}`; `subagents:started` `{id,…}`; `subagents:completed` `{id, …, result}`; `subagents:resuming` / `subagents:resumed` `{id,…}`; `subagents:steered`; `subagents:compacted`.
- `guard:context_diet_rewritten` `{role, thinkingDropped, resultsAged, charsSaved}`; `guard:bash_timeout_rewritten`, `guard:call_args_rewritten`, `guard:path_denied`, `guard:pre_spawn_compact_denied` `{role, …}`.
- `handles:archived`, `handles:recalled`, `checkpoint:written`, `worker:report` `{role: "worker:<transcript basename>", status, …}`, `memory:*`.

Guard `data.role` is `"orchestrator"`, `"builder"`, `"critic"`, or `"worker:<transcript basename>"` (the child session FILE basename without `.jsonl`, e.g. `worker:2026-09-15T04-22-16-260Z_01a0a34d-…`; resolve like `lib/workers.mjs` `workerIdForTranscriptName`). The lifecycle `id` of a subagent (e.g. `8eb067bb-8ebc-4b3`) is NOT the child session id (e.g. `01a0a34d-21c4-…`); join a worker session to its spawn FIFO, mirroring `lib/workers.mjs`'s `bindTranscript`: process worker agents in `startMs` order and, for each, claim the EARLIEST still-unclaimed `subagents:created` (or `subagents:resuming`) event whose `ts` is at or before the worker's first assistant `message.timestamp` and within 120 s of it. Picking the latest candidate inverts descriptions when two workers are spawned in the same window. `lifecycle.jsonl` may be absent (older runs): everything degrades to no markers.

`summary.json` exists only for finished runs; `runId`, `reason`, `wallSec`. The console's `extract-runs.mjs` computes run-relative seconds; the trace carries absolute epoch ms plus `t0`, and consumers convert.

## Trace document schema (the contract every task shares)

```js
{
  run: "2026-09-15T04-19-12",            // basename of the run dir
  t0: 1789445953843,                     // epoch ms: earliest session "session" entry timestamp across all files
  agents: [Agent],                       // orchestrator/builder/critic first (by session start), then workers by startMs
  markers: [Marker],                     // every marker in the run, sorted by tMs (also attached to calls)
  totals: Totals                         // over all agents
}
Agent = {
  id: "orchestrator" | "builder" | "critic" | "worker:<last 8 chars of session id>",
  role: "orchestrator" | "builder" | "critic" | "worker" | <first path segment>,
  sessionId, file /* path relative to sessions/, forward slashes */,
  parent: <Agent.id of the session named by parentSession, else null>,
  spawn: { id, description, background: bool|null, createdMs, startedMs, completedMs } | null,
  startMs /* first call startMs */, endMs /* last call endMs */,
  calls: [Call],
  totals: Totals
}
Call = {
  i /* 1-based within the agent */,
  startMs, endMs, inferenceMs /* endMs - startMs */,
  toolMs /* next call startMs - endMs, null on the last call */,
  context /* input + cacheRead */, cached /* cacheRead */, fresh /* input */,
  output, reasoning, totalTokens,
  hitRatio /* cached / context, 0 when context is 0 */,
  retained /* cached / prev.totalTokens, null on the first call or when prev.totalTokens is 0 */,
  tools: ["read", "ls"] /* toolCall names in the assistant content, in order */,
  stopReason,
  markers: [Marker] /* markers with tMs in (prev.endMs, this.endMs], or before the first call for i = 1 */
}
Marker = {
  tMs, agent: <Agent.id> | null,
  kind: "spawn" | "return" | "resume" | "guard" | "compaction" | "report" | "handles" | "checkpoint",
  ev /* raw lifecycle ev, or "compaction" for a session compaction entry */,
  detail /* short string: description for spawn/return/resume, e.g. "context_diet thinkingDropped=1 resultsAged=3" for guards, "tokensBefore=117428" for compaction */
}
Totals = { calls, context /* sum */, cached, fresh, output, reasoning, peakContext, hitRatio /* cached / (cached + fresh) over the sums, 0 when both 0 */, inferenceMs, toolMs }
```

Marker attachment: `spawn`/`return`/`resume` markers attach to the **orchestrator** (the parent agent, resolved through the worker's `parent`) call whose window contains `tMs`, and also appear on the worker agent with the worker's id. `guard` markers attach to the agent whose `data.role` matches (`orchestrator`/`builder`/`critic` by role, `worker:<sid>` by session id). `compaction` markers come from the session file's own `compaction` entries (agent = that file's agent). `report`, `handles`, `checkpoint` attach by `data.role` when present, else to the orchestrator.

---

### Task 1: `lib/context-trace.mjs` + fixture + tests

**Files:** create `lib/context-trace.mjs`, `test/context-trace.test.mjs`, `test/fixtures/run-trace/` (a trimmed copy of `runs/2026-09-15T04-19-12`: `lifecycle.jsonl`, `summary.json`, and `sessions/**` with every `text`, `thinking`, `summary`, `result` string longer than 60 chars truncated to 60 chars + "…"; produce it with a throwaway script, do not commit the script; keep the fixture under 150 KB).

**Exports:**

```js
export function readSessionFile(file)            // -> parsed entries (skip unparsable lines)
export function traceRun(runDir)                 // -> trace document per the schema; the still-running case needed no clock input, so there is no `opts` parameter
export function walkSessions(sessionsDir)        // -> sorted list of .jsonl paths (recursive), like context-report's walk
```

Behaviour:
- Calls come from `type === "message" && message.role === "assistant" && message.usage` entries. `startMs = message.timestamp`, `endMs = Date.parse(entry.timestamp)`; if `message.timestamp` is missing, use `endMs` for both. Sort calls by `startMs`.
- `t0` = min over all files of `Date.parse(first "session" entry timestamp)`; fall back to the earliest call `startMs`.
- Agent ordering and ids per the schema. Two workers whose last 8 chars collide get `-2`, `-3` suffixes (do not silently merge).
- Missing `lifecycle.jsonl` → `markers: []`, every `spawn: null`, `calls[].markers: []`.
- A session file with no assistant calls is skipped (same as context-report).
- Pure function of the directory; no `console.log`; throws only if `runDir/sessions` does not exist.

**Tests** (against the fixture, exact numbers you read from it, no `assert.ok(true)`):
1. `traceRun` finds two agents: `orchestrator` and one `worker:<…>` with `parent === "orchestrator"` and `spawn.description === "Implement src/gear.mjs"`, `spawn.background === true`.
2. For every call of every agent: `context === cached + fresh`, `hitRatio` within 1e-9 of `cached / context`, and for `i >= 2`: `retained === cached / prev.totalTokens`.
3. The orchestrator's first three calls match the verified numbers: call 1 `fresh 6007, cached 0`; call 2 `fresh 394, cached 6079, retained 1`; call 3 `cached 6538, retained 1`.
4. The orchestrator has exactly one `compaction` marker, with `detail` containing `tokensBefore=117428`, attached to the first call whose `startMs` is after the compaction entry's timestamp.
5. Spawn/return markers: the orchestrator has a `spawn` marker and a `return` marker for the worker; the worker agent's `spawn.createdMs` equals the lifecycle `subagents:created` `ts`.
6. Wall time: for the orchestrator's call 1, `inferenceMs === 4587` (04:19:14.793 → 04:19:19.380) and `toolMs` is the gap to call 2's `startMs`.
7. `totals.hitRatio` for the orchestrator is `cached / (cached + fresh)` over sums (compute it in the test from the calls).
8. A temp run dir with `sessions/orchestrator/x.jsonl` containing one assistant call and no `lifecycle.jsonl` traces without throwing, with `markers: []` and `spawn: null`.
9. `traceRun` on a temp dir with no `sessions/` throws.

Run: `node --test test/context-trace.test.mjs`. Commit: `lib: context-trace — per-agent per-call prefix-cache trace from a run's sessions`.

---

### Task 2: CLI `tools/context-trace.mjs` and a hit-ratio column in `tools/kpi.mjs`

**Files:** create `tools/context-trace.mjs`; modify `tools/kpi.mjs`; create `test/context-trace-cli.test.mjs`.

CLI: `node tools/context-trace.mjs <runDir | runId> [--json]`. Resolve like `tools/context-report.mjs` (existing path, else `runs/<id>`). `--json` prints `JSON.stringify(trace, null, 2)`. Text mode prints, per agent:

```
# context trace — 2026-09-15T04-19-12
## orchestrator: 39 calls, hit 0.928, fresh 158679, cached 2034572, peak 118443, inference 1234.5s, tools 2345.6s
   i   t+s    ctx     cached   fresh  hit   ret   out    tools / markers
   1   0.9   6007         0    6007 0.00     —     72    read,ls
   2   5.5   6473      6079     394 0.94  1.00     65    read,read
  …
## worker:d313919 (parent orchestrator, spawned 182.4s "Implement src/gear.mjs", background): …
```

`t+s` is `(startMs - t0)/1000` with one decimal; markers print after the tools as `[spawn …]`, `[guard context_diet …]`, `[compaction tokensBefore=…]`. Column widths as in the sample; keep the whole line ≤ 140 chars by truncating the tools/markers cell.

kpi.mjs: add a `hitRatio` column (three decimals) right after `cacheRd`, computed as `cacheRead / (input + cacheRead)` from the totals `tokenTotals(dir)` already returns (0 when both are 0). Add one line to the footer explaining it: "hitRatio = cache reads / (fresh input + cache reads): the share of prompt tokens the server did not have to prefill."

Tests: run the CLI with `spawnSync(process.execPath, …)` against the fixture: `--json` output parses and has `agents.length === 2`; text output contains `# context trace — run-trace`, a line starting with `## orchestrator:`, and the call-1 row with `6007`. kpi.mjs is script-only; test the column by extracting its formula into `export function hitRatio({ input, cacheRead })` in `lib/usage.mjs` and testing that (`{input: 100, cacheRead: 300} → 0.75`, `{input: 0, cacheRead: 0} → 0`).

Commit: `tools: context-trace CLI; kpi hitRatio column`.

---

### Task 3: trace in `tools/extract-runs.mjs` output

**Files:** modify `tools/extract-runs.mjs`, `test/extract-runs.test.mjs`.

In `extractRun(run)`, add `trace: safeTrace(run.dir)` to the returned object, where `safeTrace` calls `traceRun` and returns `null` on any error (a run without `sessions/` must not break the console build). Keep the trace's absolute `t0`, and additionally add `tRel0`: the run-relative seconds of `t0` computed with the same `toRelSec` anchor the function already builds (so the console can align lanes with the scrubber without re-deriving the anchor); `tRel0` is `0` when no anchor exists.

Test: build a temp run dir with `summary.json`, `bus.jsonl`, `audit.jsonl` (copy the shapes the existing test uses) plus the fixture's `sessions/` and `lifecycle.jsonl`; `extractRun(discoverRuns(tmp)[0]).trace.agents.length === 2`; a second temp run without `sessions/` gives `trace === null`.

Commit: `extract-runs: carry the context trace into runs-data`.

---

### Task 4: console "Context lanes" panel

**Files:** modify `tools/console.template.html` only.

Add a full-width section directly below the existing two-column `<section>` that holds the feed and the delivered source (after its closing tag, before `</div></main>`), styled like the neighbouring panels (same `bg-stone-900 border border-stone-800` frame and header strip; header text `02 CONTEXT LANES`, right-hand caption `prefill per call · cached vs fresh`). Contents:

1. **Stats strip** (one row of the same small boxes `buildStats()` renders): per agent `calls`, `hit` (totals.hitRatio, 2 decimals), `fresh` (fresh tokens, thousands with `k`), `peak` (peakContext), `infer`/`tools` (seconds via `fmtTime`). One box group per agent, agent id as the label.
2. **Lanes** (inline SVG, width 100 %, `viewBox` computed from the container width on build and on `resize`): one lane per agent, orchestrator/builder/critic first, workers after, each lane 56 px tall plus a 14 px label row; x axis = run-relative seconds from `tRel0 + (ms - t0)/1000`, spanning `[0, duration]` where `duration` is the variable the page already uses for the scrubber. Each call is a `<rect>` from `x(startMs)` to `x(endMs)` (min width 2 px), height proportional to `context / maxContext` (max over all agents in the run), drawn as two stacked rects: cached part in `stone-600`, fresh part in the page's `klein` blue on top. Output is a 2 px `braun-green` cap on top when `output > 0`. Tool time between calls is left empty. Markers are drawn on the lane's baseline: `spawn` ▲ vermilion, `return` ▼ braun-green, `resume` ▲ amber, `guard` a 1 px amber tick full lane height, `compaction` a 2 px vermilion tick full lane height, others a 1 px stone-500 tick. A worker lane gets a 1 px dashed stone-600 connector from its `spawn.createdMs` x on the parent lane down to the worker lane's first call.
3. **Hover**: an absolutely positioned tooltip `div` (font-mono, text-[10px]) that shows, for the call under the pointer: `#i  t+s  ctx N (cached C / fresh F)  hit 0.93  retained 1.00  out O  inference 4.6s  tools 171.2s` plus one line per marker. Hide on pointer-out.
4. **Playhead**: a 1 px `stone-50` vertical line across all lanes at the scrubber's `playhead`; update it inside `seekTo(t)`.
5. **Legend** row under the lanes: cached, fresh, output, spawn, return, guard, compaction.
6. When `run.trace` is `null` or has no agents, the section shows one muted line `no session archive for this run`.

Wire-up: add `buildContextLanes()` and call it wherever `buildStats()` is called when a run is selected (find the selection handler; call after `buildStats()`), and update the playhead in `seekTo`. Use plain string-built DOM like the rest of the file; tabs are not used in this file (two-space indent), match it.

Verification (no automated test; the file is a template): run `node tools/extract-runs.mjs && node tools/build-console.mjs` in the repo, open `tools/console.html` and screenshot the panel for run `2026-09-15T04-19-12` and one dyad run (`2026-09-12T01-21-29`); attach both screenshots' paths to the report. Also run `node --check` is not applicable to HTML: instead extract the `<script>` body to a temp file and run `node --check` on it to catch syntax errors.

Commit: `console: context lanes — per-agent prefill timeline with cached/fresh split and markers`.
