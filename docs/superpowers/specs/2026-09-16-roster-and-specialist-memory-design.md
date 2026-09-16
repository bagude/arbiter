# Roster and specialist memory — design

Date: 2026-09-16. Status: draft for review. Follows the KV-cache audit and the slot pair (`docs/batch/cache-ram-diet.md`, `docs/batch/slot-pair.md`).

## Problem

Every worker today is one generated definition (`lib/worker-def.mjs` `workerDefinition()`, written to `<workspace>/.pi/agents/worker.md` by the supervisor) with a brief supplied by the orchestrator. Three consequences:

1. Specialist knowledge cannot be authored, reviewed, or versioned; the manager re-derives it in every brief.
2. Every worker starts cold: in the raid runs each worker spent 20–27k fresh tokens reading README and the source tree before writing anything.
3. Nothing a worker learns survives the run except as candidate records in the shared task/repo memory, unscoped to who learned it and never fed back to the worker type that could use it.

The 2026-09-16 measurements also fixed the order of costs on this box: output tokens dominate wall time (decode 2075–2399 s vs prefill 173–315 s per orchestrator), so anything that adds orchestrator chatter loses, and anything that cuts worker exploration or orchestrator turns wins.

## Goals

- A **roster**: specialists defined once in the repo, selected per run by name. Model and provider stay out of the definitions.
- **Specialist memory**: each specialist has its own knowledge store it queries through the existing memory tools; records link to the runs and evidence they came from; unverified lessons are searchable but never injected into a prompt.
- A **control**: the generic worker stays in the roster so every roster run can be paired against it.
- No change to prefix stability: nothing new is injected per turn; retrieved knowledge arrives as tool results.

Non-goals for this slice: prompt distillation from the store (slice 3), persistent worker sessions (rejected: context growth), graph queries beyond one hop (slice 2).

## Design

### 1. Roster folder

`roster/<name>.md`, one file per specialist, in the pi-subagents agent-definition format the supervisor already installs. Frontmatter keys (all optional except `name` and `description`):

```yaml
---
name: tester
description: Writes and runs a test suite against the spec; never sees the implementer's transcript. Reports failures with file:line evidence.
tools: read, bash, write, ls, grep, find, memory_search, memory_get, remember
thinking: off          # per-specialist default; run config may override
background: false      # default for run_in_background
maxTurns: 60
memory: tester          # scope name for this specialist's store; default = name
---
<prompt body: role, method, report contract>
```

`model:` is forbidden in roster files (loader error): the run config supplies provider/model. The prompt body is the specialist's stable prefix and must not contain anything per-run.

Initial roster (four files, all reviewed by hand before the first run):

- `worker.md`: the current generic worker prompt, verbatim. The control.
- `scout.md`: read-only (`read, ls, grep, find, memory_search, memory_get, remember`), thinking off, returns a map of the repo and the spec's obligations in the worker report format. Cheap first call.
- `implementer.md`: the current worker prompt with the scout's map expected in its brief.
- `tester.md`: writes and runs tests, mutation-style where the task has a reference; independent of the implementer (never resumes or reads the implementer's session).

### 2. Run config

```json
"workers": {
  "default": { "provider": "llama.cpp", "model": "qwen3-27b", "thinking": "off" },
  "use": ["scout", "implementer", "tester"],
  "overrides": { "tester": { "thinking": "low" } },
  "max": 1
}
```

- `use` names must exist in `roster/`; unknown names fail config loading with the roster listing. Model preflight (existing) runs on the default and every override.
- Back-compat: a config with `roles.worker` and no `workers` block is mapped to `workers: { default: roles.worker, use: ["worker"], max: roles.worker.max }`. All existing configs keep their meaning; `summary.json` records the resolved `workers` block so the batch and kpi tools can tell roster runs from legacy ones.
- `background` per specialist comes from the roster file unless overridden.

### 3. Installation and the orchestrator's view

The supervisor installs one `.pi/agents/<name>.md` per selected specialist and writes `.pi/subagents.json` with `maxConcurrent: workers.max`. pi-subagents then exposes them as `subagent_type: <name>`. Installation rewrites the roster frontmatter into the keys pi-subagents reads today (`lib/worker-def.mjs:380-394`): `name`, `description`, `tools`, `model: <provider>/<model>` (from config), `thinking` (config override, else roster, else omitted), `max_turns` (roster `maxTurns`), `run_in_background` (config override, else roster `background`). The generic `worker` entry keeps today's `resolveWorkerPrompt` behaviour (a task-local `tasks/<task>/worker.md` overrides its body, and the memory excerpt and report instruction are appended); other specialists get their roster body plus the same appended memory excerpt and report instruction, and no task-local override in this slice.

`prompts/orchestrator.md:5` today describes a single `subagent_type "worker"`; that sentence is replaced by a generated **Roster** section built from each selected specialist's `description` line, inserted once at spawn (prefix-stable within the run). The section states the intended order for the shipped roster (scout first, then implementer, then tester) as guidance, not a rule. Per-run text is never added to it.

### 4. Specialist memory

Scope `agent:<memory-name>` in the existing store (`memory/records.jsonl`), same record shape, same index, same tools. Changes:

- `validScope` and the two duplicated validators accept `agent:<name>`; `wiki.mjs` INDEX sections and `recall` ordering learn the new prefix (today `recall` silently drops unknown scopes).
- Scopes for a specialist's process: `["global", "task:<task>", "repo:<repo>"?, "agent:<memory>"]`; the orchestrator's scopes are unchanged (it does not see specialist stores). Since scopes reach the extension through `ARBITER_MEMORY_SCOPES` in the child env and all workers share the orchestrator's env today, the supervisor writes a per-specialist scopes file into the workspace (`.pi/agents/<name>.memory.json`) and the extension reads it by matching its own session's agent name; the env stays the orchestrator's default.
- New tool `remember` for specialists only: appends a **candidate** record (`source: "agent"`, `status: "candidate"`, `claim: "unreviewed"`, confidence 0.4, scope `agent:<memory>`, evidence `run:<runId>` and the worker's session id). Budget-charged like `memory_get`. Rate-limited to 5 per worker run. Candidates are searchable by later specialists of the same type, and the search row already shows `candidate`/`promoted` and verified/unverified, so the specialist can weigh them.
- Retention at run finish (existing `retainFromRun`) additionally writes, per specialist that ran: one procedural record in `agent:<memory>` naming what it was asked and whether the run passed (evidence `run:<id>`, `oracle:<id>#<n>` when present). Promotion stays as today: host-vouched records promote; agent candidates need the human `verdict` tool. **Nothing from `agent:*` is ever injected into a prompt**: the spawn brief for a specialist is a seeded search over its scopes (existing `seededBrief`) restricted to promoted records; candidates are reachable only through `memory_search`.
- Links: evidence strings already carry `run:`, `oracle:`, `memory:`; this slice adds `applies_to:task:<name>` on retained specialist records so a later query can filter by task class, and `from_agent:<memory>` on candidates. No new record fields; the graph is evidence edges until slice 2 needs more.

### 5. Observability

- `workers.jsonl` manifest and the trace label worker lanes `worker:<id>` today; both gain the specialist name (`subagents:*` events carry `type` = the definition name; verified, see Risks). The lanes page and CLI show `tester:c1b24099`.
- kpi.mjs gains a `roster` column (comma-joined `use`) so paired runs sort together.
- Lifecycle event `memory:remember` for the new tool, folded into `tracker.memory` like search/get.

### 6. Experiment (pathnorm, 3–5 min per run)

Four runs, same task, same model:

| arm | config | expects |
|---|---|---|
| control | `workers.use: ["worker"]` | matches the four existing pathnorm runs (176–317 s) |
| roster | `use: ["scout","implementer","tester"]` | more worker calls, fewer orchestrator output tokens if the scout's map shortens briefs |
| roster + memory, run 1 | same, `remember` enabled | candidates written to `agent:scout`, `agent:tester` |
| roster + memory, run 2 | same task class (lru), after promoting the useful candidates by hand | specialists call `memory_search` and their fresh-token count drops versus run 1 |

Report: `docs/batch/roster-pathnorm.md` with the kpi line (turns, fresh, output, hit, retained), per-lane fresh tokens, and the count of `memory:search`/`memory:remember` events per specialist.

## Risks and rulings

- Orchestrator choice cost: more tools, more narration. Mitigation: the roster section is short and ordered; the control arm measures it. If orchestrator output rises more than the workers' fresh tokens fall, the roster shrinks.
- Candidate pollution: specialists writing wrong lessons. Mitigation: candidates never injected, rate-limited, promoted only by the human verdict tool, and linted by the existing `unbacked-promotion` rules.
- pi-subagents naming: verified 2026-09-16 — `subagents:created/started/completed` carry `type: record.type`, the `subagent_type` the orchestrator passed (`node_modules/@gotgenes/pi-subagents/src/observation/subagent-events-observer.ts:38-44,141-146`), which is the definition name (`"worker"` in every run so far). The manifest and lanes can label lanes by it with no pi-subagents change.
- Scope per specialist through a workspace file rather than env: the extension must find its own agent name from the session path (guard-kit's `roleFor` gives `worker:<session id>`); the subagents bridge records `id → type`, and the manifest's `bound` record joins session to type. If the name cannot be resolved in-process, fall back to a single shared scope list per run (all selected specialists' scopes) and note it.

## Slices after this one

2. Graph queries: one-hop neighborhood in `memory_get` (records sharing a `run:` or `applies_to:` edge), `contradicts` as an op.
3. Distillation: an offline tool that proposes prompt lines from frequently retrieved promoted records, written as a new roster file version next to the old one, A/B'd on the same task.
