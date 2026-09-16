# Borrowings from pi-simple-team: model preflight, worker manifest, context_usage tool

**Goal:** Three small, independent slices borrowed from the pi-simple-team extension after the 2026-09-15 review: fail a run before any pi process boots when a role names a model pi does not have; persist the worker-id to session-file join on disk; give agents a read-only tool that reports their own context usage as prose.

**Why:** A wrong model id today surfaces only as a `model_error` audit line after the first turn is attempted. The worker join is an in-memory FIFO pop with nothing on disk, so it is unauditable and would be wrong at concurrency > 1. No agent can ask its own context usage; the only signals are supervisor-pushed messages and the pre-spawn guard's denial text.

**Spec:** the design agreed in chat on 2026-09-15 (this file is its written form).

## Global Constraints

- Node ≥ 22, ESM (`.mjs`), tabs for indentation, no new dependencies, tests with `node:test` under `test/*.test.mjs` (`npm test` runs `node --test "test/**/*.test.mjs"`). Extension files are `.ts` under `ext/` and follow the existing loader pattern (`kit.homeUrl`, `ARBITER_HOME`, policies in `lib/policies/*.mjs` so logic is testable without pi).
- Never mutate run directories other than by appending the new manifest file. Tests use temp dirs.
- Nothing in this plan may add content to a system prompt or rewrite messages (prefix-cache rule): all new information reaches an agent only as a tool result.
- Windows paths: normalise with `.replace(/\\/g, "/")` before matching or storing relative paths.
- `lib/config.mjs` `loadConfig({ configPath, env })` keeps its signature; new behaviour is opt-out only through the env var named below.
- This worktree has no `node_modules`. If `npm test` needs one (some ext tests import `@earendil-works/pi-coding-agent` types), create a directory junction to `../arbiter/node_modules` (`cmd /c mklink /J node_modules ..\arbiter\node_modules` from the worktree root) rather than running npm install; the junction is git-ignored.

## Facts (verified 2026-09-15)

- Provider and model reach a pi process as launch flags: `supervisor.mjs:283-288` passes `"--provider", cfg.provider, "--model", cfg.model` and `--thinking` when set. Workers get theirs from the definition file `lib/worker-def.mjs:14-15` writes (`model: ${provider}/${model}`).
- `lib/config.mjs:40-42` validates presence only: `if (!provider || !model) throw …`. Thinking level is whitelisted at `config.mjs:46-47`.
- pi's model store on this machine: `~/.pi/agent/models-store.json`, shape `{ "<provider>": { "models": [ { "id", "name", "api", "provider", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat" } ] } }`. Providers present: `anthropic` (14 ids) and `llama.cpp` (`qwen3-27b` with `contextWindow: 131072`, `qwen3-flash`, `qwen3-uncensored`). `~/.pi/agent/models.json` is an override layer `{ "providers": { "<provider>": { "modelOverrides": {…}, "models"?: [ { "id", … } ] } } }`; models listed there count as available too.
- Supervisor liveness: `agent_start` sets busy (`supervisor.mjs:488`), `agent_settled` clears it (`:491`), `message_end` updates `contextTokens` (`:559, :566`) via `contextTokensOf` in `lib/compaction.mjs:11` (`input + cacheRead`).
- Worker tracking: `lib/workers.mjs` `createTracker()` (`:34`) keeps `unbound: []`; `applyLifecycleEvent(tracker, state, timeline, { ev, data, now })` (`:144`) handles `subagents:created/started/completed/failed/resuming/resumed`; `bindTranscript(tracker, state, transcriptPath)` (`:329`) pops `tracker.unbound.shift()` and returns the worker id. `lib/child-transcripts.mjs` has `childTranscriptDir()` and `workerIdFromTranscript(filePath)` (basename without `.jsonl` = child session id). The supervisor calls these from `pumpChildTranscripts` (`supervisor.mjs:811-838`) and its lifecycle tailer.
- Lifecycle records are `{ts, ev, data}`; `subagents:created` data is `{id, type, description, isBackground}`.
- The pre-spawn guard (`ext/guards/pre-spawn-compact.ts`) caches a char estimate from pi's `context` event: `pi.on("context", (event) => { contextChars = estimateContextChars(event.messages); })`, with `estimateContextChars` exported from `lib/policies/pre-spawn-compact.mjs`. Its denial text uses a 3.3 chars/token rule of thumb. `ext/memory-ext.ts` shows how an extension registers tools (`pi.registerTool`).
- Extensions are loaded per role by the supervisor's `-e` flag list (grep `GUARDS` / `"-e"` in `supervisor.mjs`); env vars set in the spawn env block (`supervisor.mjs:340-350`) reach extensions.

---

### Task 1: model preflight in `lib/config.mjs`

**Files:** modify `lib/config.mjs`; create `lib/model-store.mjs`, `test/model-store.test.mjs`; extend `test/config.test.mjs`.

`lib/model-store.mjs` exports:

```js
export function defaultModelStorePaths(env = process.env)  // -> { store: <home>/.pi/agent/models-store.json, overrides: <home>/.pi/agent/models.json }, home = env.PI_CODING_AGENT_DIR ? path.dirname(env.PI_CODING_AGENT_DIR) : os.homedir()  — keep it simple: <os.homedir()>/.pi/agent unless env.ARBITER_MODEL_STORE (store path) / env.ARBITER_MODEL_OVERRIDES (overrides path) are set
export function loadModelStore({ storePath, overridesPath })  // -> { available: Map<"provider/id", { provider, id, contextWindow: number|null }>, source: [paths that existed] }; missing files are skipped, malformed JSON throws with the path in the message
export function preflightRoles(roles, store)                // -> { roles: same object with contextWindow added per role (null when unknown), missing: ["builder: llama.cpp/qwen3-27x", …] }
```

`loadConfig` calls `loadModelStore(defaultModelStorePaths(env))` and `preflightRoles`. If `missing.length > 0` it throws:

```
model preflight: roles.builder names "llama.cpp/qwen3-27x" but pi has no such model; available for llama.cpp: qwen3-27b, qwen3-flash, qwen3-uncensored (from C:/Users/x/.pi/agent/models-store.json)
```

(one line per missing role; the available list is that provider's ids sorted, or `no models for provider "<p>"` when the provider is absent, followed by the known providers). When `store.source` is empty (no store files exist), `loadConfig` skips the check, sets every `contextWindow` to `null`, and sets `config.preflight = { skipped: "no model store found", looked: [paths] }`; otherwise `config.preflight = { checked: <n roles>, source: [paths] }`. `env.ARBITER_SKIP_MODEL_PREFLIGHT=1` also skips (same `preflight.skipped` shape, reason `"ARBITER_SKIP_MODEL_PREFLIGHT"`).

Tests (temp dirs, write small store/override JSON files, pass their paths via `env`): available map from store only; from overrides `providers.<p>.models` too; missing file skipped; malformed JSON throws naming the path; `preflightRoles` adds `contextWindow` 131072 for a known id and `null` for a role whose provider exists but id is in overrides without `contextWindow`; `loadConfig` throws the message above for an unknown id (assert the provider's sorted id list appears) and passes with `preflight.checked === <n>` for known ids; `loadConfig` with no store files sets `preflight.skipped` and does not throw; `ARBITER_SKIP_MODEL_PREFLIGHT=1` skips. Existing `test/config.test.mjs` tests must keep passing: they construct configs with arbitrary models, so set `ARBITER_SKIP_MODEL_PREFLIGHT=1` in their `env` or point them at a temp store that lists the ids they use (choose the one that touches fewer lines; say which in the report).

Commit: `config: model preflight against pi's model store; roles carry contextWindow`.

---

### Task 2: worker manifest `workers.jsonl` in the run directory

**Files:** create `lib/worker-manifest.mjs`, `test/worker-manifest.test.mjs`; modify `supervisor.mjs` (wiring only).

`lib/worker-manifest.mjs` exports:

```js
export function appendManifest(runDir, record)   // appends JSON.stringify({ ts: record.ts ?? Date.now(), ...record }) + "\n" to <runDir>/workers.jsonl (mkdir -p runDir)
export function readManifest(runDir)             // -> [] when absent; parsed records in file order, malformed lines skipped
export function manifestJoin(records)            // -> Map<wid, { wid, description, background, sessionId, transcriptPath, createdTs, boundTs, endedTs, status }> folded from the records
```

Record kinds written by the supervisor:
- on lifecycle `subagents:created`: `{ ev: "created", wid, description, background: Boolean(isBackground) }`
- when `bindTranscript` returns a worker id: `{ ev: "bound", wid, sessionId: workerIdFromTranscript(path), transcriptPath: <path relative to runDir, forward slashes> }`
- on `subagents:completed` / `subagents:failed` / `subagents:resumed`: `{ ev, wid, status: "completed" | "failed" | "resumed" }`
- on `subagents:resuming`: `{ ev: "resuming", wid }`

Wiring in `supervisor.mjs`: find the lifecycle tailer that calls `applyLifecycleEvent` and the `pumpChildTranscripts` call to `bindTranscript`; append the manifest record right after each. Read the current run dir variable the supervisor already uses for `lifecycle.jsonl`. Do not change `lib/workers.mjs`.

Tests: `appendManifest` then `readManifest` round-trips two records with `ts` numbers; a malformed line is skipped; `manifestJoin` folds created + bound + completed for one wid into one row with `sessionId`, `transcriptPath`, and `status: "completed"`, and a wid with only `created` has `sessionId: null` and `status: "running"`; `readManifest` on a dir without the file returns `[]`. Supervisor wiring has no unit test (the supervisor is a process); verify it by running `npm run smoke:substrate` if it exists and runs without a live model, else say so in the report and show the exact hunk.

Commit: `supervisor: workers.jsonl manifest — created/bound/completed per worker, on disk`.

---

### Task 3: `context_usage` tool

**Files:** create `lib/policies/context-usage.mjs`, `ext/context-usage-ext.ts`, `test/context-usage-policy.test.mjs`; modify `supervisor.mjs` (load the extension for every role and pass `ARBITER_CONTEXT_WINDOW`).

`lib/policies/context-usage.mjs` exports:

```js
export const CHARS_PER_TOKEN = 3.3;
export function describeContextUsage({ chars, contextWindow })
// -> { chars, estTokens: Math.round(chars / CHARS_PER_TOKEN), contextWindow: number|null, percent: number|null (0-100, one decimal, null when contextWindow is null), text }
// text: "Context: ~12,345 chars (~3,741 tokens est.) of 131,072 (2.9% used)." or, without a window, "Context: ~12,345 chars (~3,741 tokens est.); context window unknown."
```

`ext/context-usage-ext.ts`: same loader preamble as `ext/guards/pre-spawn-compact.ts`; caches `estimateContextChars(event.messages)` on pi's `context` event; registers a tool `context_usage` (no parameters, description: "Report how much of your context window you have used, as an estimate from the current message list. Read-only.") whose execute returns `describeContextUsage({ chars, contextWindow: Number(process.env.ARBITER_CONTEXT_WINDOW) || null }).text`. It must not touch the system prompt or messages.

Supervisor: add the extension to the list every role loads (next to the always-on guards) and set `ARBITER_CONTEXT_WINDOW` in the spawn env from `cfg.contextWindow` (added by Task 1; empty string when null). Workers spawned by pi-subagents inherit the orchestrator's env, so they get the orchestrator's window value; note this in the report.

Tests: `describeContextUsage` for `{chars: 0, contextWindow: 131072}` → percent 0, text contains "0.0% used"; `{chars: 33000, contextWindow: 131072}` → estTokens 10000, percent 7.6; `{chars: 500, contextWindow: null}` → percent null, text ends with "context window unknown."; thousands separators present. The ext has no unit test beyond loading: add a test that imports the `.ts` the way `test/pre-spawn-compact-ext.test.mjs` does (copy its harness pattern) and asserts a `context_usage` tool is registered and returns the policy text after a `context` event with a known message list.

Commit: `ext: context_usage tool — read-only context estimate against the role's window`.
