# Arbiter: orchestrator–workers pattern and the generalisation of duo

Date: 2026-09-11
Status: design approved in conversation; awaiting written-spec review

## 1. Context and goals

`duo/` is a supervised two-agent harness: a model-free Node supervisor drives pi agents over RPC, relays a single mail channel, enforces role asymmetry through tool grants, and accepts a result only when a hidden, host-executed oracle passes. Over 2026-09-10/11 it ran fourteen dyad runs (BUILDER + CRITIC) and one solo ablation (BUILDER alone, spec in prompt). The ablation showed the dyad's dialogue was not required for correctness — solo passed the same oracle — but the dyad reached a pass 39% faster because CRITIC surfaced the one spec subtlety solo had to find by blind search. Across every run, what the second agent demonstrably contributed was spec clarification and a targeted error signal, not adversarial catching of wrong claims. The model-free gate (probes, hash+quiescence, oracle) did the load-bearing work in every pattern.

This spec does three things:

1. **Generalises the harness** from one hard-coded pattern to a run configuration naming a pattern and its roles, and renames the project from `duo` to `arbiter` — the model-free component that decides from execution evidence, present in every pattern.
2. **Adds an orchestrator–workers pattern**: one orchestrator agent decomposes a task at runtime, spawns workers, can resume and steer them, and its result is still gated by the oracle.
3. **Chooses `@gotgenes/pi-subagents` as the worker substrate** rather than hand-rolled subprocess plumbing, based on a spike showing an external supervisor can observe and gate its children.

The first use of the pattern is an experiment in *behaviour* (how an orchestrator decomposes, delegates, and whether it verifies workers before accepting their claims), run across several orchestrator models on the `orbit` task. Numbers (wall time, tokens, attempts) fall out for free and are recorded in the existing KPI table.

Non-goals: parallel workers with independent workspaces and a merge step; sandbox enforcement on Windows (see §9); self-improvement of the harness; any change to how the dyad and solo patterns behave.

## 2. Rename and run configuration

- `duo/` → `arbiter/`. One commit renames the directory, the console title, and the extraction/KPI paths that point at `duo/runs`. No file keeps the old name.
- A run is described by a JSON file, default `arbiter.json` in the project root, selectable with `--config <path>`:

```json
{
  "task": "orbit",
  "pattern": "orchestrator",
  "roles": {
    "orchestrator": { "provider": "zai",       "model": "glm-5.3-flash" },
    "worker":       { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 }
  },
  "caps": { "toolCalls": 200, "wallSec": 6000, "usd": 5, "doneAttempts": 5 },
  "oracle": { "reportFailingInputs": false }
}
```

- `pattern` is one of `dyad` (roles `builder`, `critic`), `solo` (role `builder`), `orchestrator` (roles `orchestrator`, `worker`). A pattern declares which roles it requires; a config missing one fails at startup with the role named.
- Env vars override for quick swaps: `ROLE_<name>_PROVIDER`, `ROLE_<name>_MODEL`, `ARBITER_TASK`, `ARBITER_PATTERN`, and the existing cap variables. The file is the source of truth; env is convenience.
- `DUO_*` variables are removed, not aliased. `supervisor.mjs` prints the resolved config at startup and writes it into `summary.json` so a run is reproducible from its own record.
- Dyad and solo keep their current behaviour exactly. The change to them is where their roles and models come from, nothing else.

## 3. Roles and tools

Role asymmetry is enforced by what tools exist, never by prompt. This is the one principle every run this session confirmed: instructions the model can ignore were ignored; options the model does not have cannot be misused.

**Orchestrator** (the parent pi agent, launched by the supervisor in `--mode rpc`):
- Workspace tools: `read`, `ls`, `grep`. It can inspect the shared workspace and cannot write to it. If it could edit, the cheapest failure is that it does the work itself and never delegates.
- `subagent` (from pi-subagents): spawn a worker from a role-specific agent definition with a brief. The supervisor generates the worker definition (§4); the orchestrator chooses only the brief.
- Resume and steer (from pi-subagents): continue an existing worker with its context intact. This is the "talk to it again" the pattern requires.
- `probe(cases)` (ours, via `-e`): host-executes cases against the shared workspace, as CRITIC's probe does today — same echo of args, same `expect` support, same repeat-blocking, same 1500-char value cap.
- `done` (ours, via `-e`): claims the shared workspace is complete. Goes through the hash+quiescence gate before the oracle runs.
- No `bash`, no `edit`, no `write`.

**Worker** (a pi-subagents child, defined by generated frontmatter):
- `read`, `bash`, `edit`, `write`, `ls`, `grep`, `find` — the BUILDER toolset.
- `notify_parent` (non-blocking progress) and `ask_parent` (blocking question) from pi-subagents; its final message is its report.
- No `subagent` (no recursion), no `probe`, no channel to other workers, no `done`. A worker's report is information to the orchestrator; only the orchestrator can claim completion.
- Prompt: the existing BUILDER prompt adapted — the brief comes from the orchestrator, the counterpart is the orchestrator, completion is reported by finishing the turn, and the spec is *not* in the worker's prompt. Whether the orchestrator passes spec detail in its brief is exactly the behaviour under study.

**Supervisor** (unchanged in nature): model-free, external, owns delivery, budgets, the probe runner, the gate, the oracle, and all logging.

## 4. Supervisor mechanics for the orchestrator pattern

Substrate: `@gotgenes/pi-subagents` (pinned version; peer range checked against the pi checkout at startup). The spike verified: a parent in `--mode rpc` with the extension loaded via `-e` spawns children in-process; children are registered with the permission system before their extensions bind; resume and steer exist on the service; child tool sets are frontmatter-restricted.

**Launch.** The supervisor writes a per-run agent definition for the worker role into the run's agents directory (frontmatter: name, tools, `max_turns`, model/provider for the worker role, generated system prompt), then launches the orchestrator pi with `-e <pi-subagents> -e <arbiter bridge ext> -e <arbiter tools ext>`, cwd = the shared workspace, tools as in §3.

**Observation.** Child tool calls are not on the parent's RPC stream. Two additions recover them:
1. *Bridge extension* (~20 lines, host code, loaded with `-e`): subscribes to `subagents:*` lifecycle events and appends them to `RUN/lifecycle.jsonl` — spawn (with the full brief), resumed, update (`notify_parent`), completed (with result), failed.
2. *Transcript tailer*: pi-subagents persists each child's full transcript as pi-format JSONL under the parent session's `tasks/` directory. The supervisor tails those files with the same watcher it uses for `bus.jsonl` and feeds them through the existing event handler, so per-worker tool calls, edits, costs, and bash watchdog timing all work unchanged — each worker is a `state[<agentId>]` entry.

**Per-agent state.** The singular globals (`lastEditTs`, `pendingBash`, tool counts, cost) become a map keyed by agent id. The shared workspace's edit-quiescence is the max over all workers' `lastEditTs`.

**Gate.** Unchanged in substance: the orchestrator's `done` is accepted only if the shared workspace's hash equals the hash at its most recent probe and no worker has edited for `QUIESCENCE_MS`. Rejections are reported to the orchestrator with the reason, as today. Solo's quiescence fallback carries over: orchestrator idle, no live worker, workspace changed since the last oracle run → the oracle runs without a `done`.

**Oracle.** Unchanged. On failure the orchestrator receives the pass count. `oracle.reportFailingInputs` (default `false`) additionally lists the failing cases' inputs — never expected values. It stays off for the first runs so results compare cleanly to the dyad and solo numbers.

**One live worker.** `roles.worker.max` defaults to 1. Enforcement must be host-side; the spawn is the orchestrator's in-process tool, so the supervisor cannot refuse it from outside. Resolution is deferred to implementation with a test: preferred is the package's permission hook (fires before a child binds) or a package concurrency setting, enforced from the bridge extension; if neither can block, the run allows N workers, logs concurrent spawns as a `warn` event, and the first task's dependent stages serialise naturally. This is the one open item in the design.

**Worker reporting.** Children inherit extensions from pi settings, not from the parent's `-e` list, so Arbiter does not rely on its own host tool inside workers. Progress rides `notify_parent`; the final report is the child's result. Both are size-capped by the bridge (the same 1500-char cap probe values use) before they reach the orchestrator's context — the untruncated text stays in the child transcript.

**Lifetime.** Workers persist until the run ends; the orchestrator may resume any of them. Budget caps are shared across all agents; per-role tool-call and cost totals are reported separately.

## 5. Instrumentation

This is the deliverable of the first experiment, not a side effect.

- `audit.jsonl` gains event types: `spawn` (worker id, full brief text), `resume` (worker id, message), `report` (worker id, capped text), `decide` (what the orchestrator did in the turn after a report: `probed`, `resumed`, `spawned`, `accepted`, `claimed_done`), `oracle_trigger` (already added for solo).
- `transcript.md` renders the delegation tree: orchestrator turns at the top level, each worker's spawn/resume/report nested under it, probes and oracle runs inline.
- Console (`duo-console` → `arbiter-console`): an orchestrator lane plus one lane per worker; the existing facet filters apply; the source panel shows the shared workspace.
- KPI: tokens and cost split by role; the success-per-1k-tokens metric unchanged in definition.
- The one behaviour every run is scored on by hand: whether the orchestrator called `probe` before its first `done`, and whether it probed after any worker's report. Logged as a boolean in `summary.json` (`orchestratorProbedBeforeDone`) so it can be tabulated.

## 6. First runs

Task: `orbit` (five dependent stages, one file; room to decompose, nothing to merge). Workers: local Qwen3-27B in all runs except the first.

Order, cheapest first, each a separate run with its own config file under `configs/`:
1. Flash-Next MoE as both orchestrator and worker (already on disk, free; 65k context cap on the orchestrator noted).
2. GLM-5.3-Flash orchestrating (`zai`, ≈$0.12 list under the measured traffic shape).
3. GPT-5.4 mini orchestrating (`openai`, ≈$0.59).
4. Sonnet 5 orchestrating (`anthropic`, ≈$1.57) — the reliability reference: zero false judgements in four runs as CRITIC.
5. Qwen3.5-9B Q4_K_M co-resident with the 27B workers at 64k context — the local-orchestrator experiment, after a 6 GB download.

Provider setup for 2–4 is a key in `~/.pi/agent/auth.json` (`type: "api_key"`) plus a one-line smoke test per provider; all target model ids are already in pi's catalog.

## 7. Testing

- **Unit** (`node:test`, new `arbiter/patterns/*.mjs`): pattern→required roles resolution; config load with env override precedence; per-agent state map (quiescence = max over workers); mail/report routing table for each pattern; gate decision function given (probe hash, workspace hash, last edit times); report/brief capping. The supervisor has no tests today; this is where the intricate logic moves so it can have them.
- **Extension render**: the tool descriptions for orchestrator and worker roles are dumped and checked for the exact tool set per role (as done this session for `send_mail`).
- **Live smoke** (25 s wall cap) per pattern: dyad, solo, orchestrator — launches, kicks off, first tool call observed, clean shutdown with workspaces archived and the temp workspace root removed.
- **Substrate smoke**: the spike's echo experiment re-run against the pinned package version on every pi bump; failure blocks the orchestrator pattern with a clear startup error.
- **First real run** on `orbit` with Flash-Next, watched with the same monitor patterns as every run this session.

## 8. Failure handling

- Worker crash or failed child: the orchestrator receives the failure as its tool result (package behaviour) and the supervisor logs it; the worker's state entry is removed; the run continues.
- Orchestrator process exit: the run ends, as any agent exit does today.
- Bash watchdog: applies to workers through the transcript tailer (pending bash tracked per worker); abort is sent via the package's steer/cancel on that child.
- Budget caps: shared; hitting one ends the run with the cap named.
- Malformed probe body, repeated probe cases, oversized values: handled exactly as today.
- Idle: orchestrator idle with no live worker for `idleNudgeSec` → nudge; after `maxNudges` → stalled finish, unless the quiescence fallback runs the oracle first.

## 9. Phase two: authority boundaries (not built now)

`@xzzpig/pi-sandbox` named profiles are the correct fix for the workspace leak observed on 2026-09-10 (BUILDER read `bus.jsonl` via `cd ..`), and they bind only through pi-subagents' native child path — which this design adopts. They do not enforce on native Windows: the extension exits on any platform other than `darwin`/`linux`, and enforcement is `bubblewrap`/`sandbox-exec`. The viable route is WSL2 (installed, Ubuntu): pi, node, and workspaces move into WSL; the llama.cpp server stays on Windows, reachable over localhost. That is an environment migration and is scheduled after the orchestrator pattern has produced its first results. Until then `summary.json` continues to record `sandbox: none` and isolation is by placement (workspace root outside the run directory).

Caveat recorded for phase two: with a named profile selected, an unsupported platform blocks the child before its first turn; *without* a profile the extension only warns and the agent runs unsandboxed. Arbiter must always select a profile, never rely on "sandbox on".

## 10. Open items

1. One-live-worker enforcement mechanism (§4) — resolved during implementation with a test.
2. Whether `-e` host tools reach children — resolved by the substrate smoke; the design does not depend on it.
3. `orbit`'s worker prompt: adapted from `builder.md`, with the counterpart being the orchestrator; written during implementation, reviewed against the same "no rules the mechanism already enforces" standard applied to `critic.md` after the context-engineering read.
4. The console (`duo-console.template.html`, `build-artifact.mjs`), run extraction (`extract-runs.mjs`) and KPI (`kpi.mjs`) scripts currently live in a session scratch directory, not in the project. The rename step moves them into `arbiter/tools/` so the project is self-contained; their run lists become derived from `runs/*/summary.json` instead of hand-maintained arrays.
5. The project is not under version control. Putting it under git before the rename is recommended so the rename and every subsequent change are recoverable; it is the user's call.
