# Three borrowings from Claude Code's Workflow tool

Date: 2026-09-14
Status: design agreed in conversation; plans written, awaiting approval

## 1. Context

Claude Code's `ultracode` effort level is `xhigh` plus a standing opt-in for its
Workflow tool: the seat model writes a JavaScript orchestration script per task
(`agent()`, `parallel()`, `pipeline()`, JSON-schema outputs, a hard token budget, a
journal for resume), and once written the control flow is deterministic. Verification
inside a Workflow is model-driven — several skeptic agents vote on each finding.

Arbiter is the mirror image. Inside a run the control flow is model-driven (the
orchestrator decides the split, the briefs, when to probe, when to claim) and
acceptance is deterministic (hash + quiescence gate, host-executed probes, hidden
oracle). Under arbiter's claim taxonomy a majority of refuters is `interpreted`, never
`observed`. The two systems put determinism in opposite places, and arbiter keeps its
side: the oracle stays the only authority.

Three Workflow ideas translate. Three do not:

| Workflow idea | Verdict | Why |
|---|---|---|
| per-agent `effort` | **take** (slice A) | workers spend 36–39 % of context on thinking (slice 3 measurement); pi and pi-subagents both accept a thinking level per role |
| `schema`-forced structured output | **take, reshaped** (slice B) | the value is that *code* acts on the model's output; in arbiter the code that acts is the probe runner and the gate |
| `budget` as a hard ceiling | **take, tokens only** (slice C) | local runs cost $0; a campaign has no ceiling at all today |
| `pipeline()` concurrency | no | blocked by the one-worker join key (backlog #7) |
| vote-based adversarial verify | no | a vote is a claim; the oracle already rules |
| journal resume with cached prefix | no | rounds read and write memory, so a cached round would misreport what ran; crash recovery is a `--from` flag |

Each slice is independent, opt-in where it changes behaviour, and measured by a paired
run before any default flips. Plans: `docs/superpowers/plans/2026-09-14-thinking-level.md`,
`…-worker-report.md`, `…-campaign-contract.md`.

## 2. Slice A — per-role thinking level

- `roles.<role>.thinking` in the run config, optional. Valid values are pi's:
  `off, minimal, low, medium, high, xhigh, max`. pi-subagents accepts the first six
  for a worker (its `THINKING_LEVELS` has no `max`), so `roles.worker.thinking: "max"`
  fails at config load with the accepted list named. Env override `ROLE_<name>_THINKING`.
- Supervisor-launched roles (orchestrator, builder, critic) get `--thinking <level>` on
  the pi command line. The worker gets a `thinking: <level>` frontmatter line in the
  generated `.pi/agents/worker.md`; pi-subagents reads it (`src/config/custom-agents.ts`).
- Nothing is written when the key is absent, so every existing config runs unchanged.
- The resolved config is already embedded in `summary.json`, so a run records its levels.
- **The local stack needs one more switch.** The `llama.cpp` entries in
  `~/.pi/agent/models-store.json` are declared `reasoning: false` with
  `compat.supportsReasoningEffort: false`, so pi sends no reasoning parameter for them;
  the thinking in worker transcripts is Qwen3's own `<think>` output relayed as
  `reasoning_content`. The one per-role switch pi can reach is Qwen3's soft switch:
  `/no_think` appended to the role's system prompt when `thinking` is `off` on that
  provider (`thinkingSuffix` in `lib/worker-def.mjs`). It is deterministic at the chat
  template, not an instruction the model weighs. Levels between `off` and on have no
  local effect; hosted providers honour the level as sent. The plan opens with a curl
  spike confirming llama-server honours the soft switch before anything is built on it.
- Measurement: a paired batch on `dw-explore-real` (baseline vs worker `off`), comparing
  oracle outcome, wall, `E_excl`, per-role context peak and the share of thinking
  characters in each role's transcript.

## 3. Slice B — worker report contract

**Tool.** `report`, registered by `ext/report-ext.ts` (same shape as `checkpoint-ext.ts`:
TypeBox schema, validated by pi before `execute`, appended to `runs/<id>/reports.jsonl`,
reported to the lifecycle file as `worker:report`). Schema:

```
status          "done" | "partial" | "blocked"
summary         string, 1..600
changed         string[] ≤ 30 (paths the worker edited)
findings        [{ claim: observed|interpreted|hypothesis, text ≤ 600, evidence_refs?: string[] ≤ 12, settlement_criterion?: string ≤ 400 }] ≤ 20
verify          [{ id ≤ 40, args: any[] ≤ 12, expect?: any }] ≤ 12   — a probe case, byte-for-byte
open_questions  string[] ≤ 12
```

Only workers can call it: `report` is added to the worker definition's `tools:` line and
never to `ORCHESTRATOR_TOOLS`. Role asymmetry stays a matter of which tools exist.

**Presence is enforced at the gate, not measured.** `decideApproval` in `lib/gate.mjs`
gains one input, `unreported`: the ids of workers whose status is `completed` and whose
latest report predates their latest start or resume. Failed workers are exempt. A `done`
with any such worker is refused with reason `unreported`, and the rejection names the
workers and the fix (resume each with `subagent`, ask it to call `report`). A worker can
still end its turn without reporting; the run cannot finish until it has not. The
quiescence-fallback oracle (orchestrator idle, no live worker, tree changed) is left as
it is — it is the safety net for models that never claim, and blocking it on reports
would trade a measurable rejection for a wall-clock stall.

**The supervisor acts on the report (opt-in).** With `report: { autoProbe: true }`, the
moment a report lands whose `verify` list is non-empty and the task has a `probe.mjs`,
the supervisor runs those cases as a probe (`runProbe` with `from: "supervisor"`), and
the results reach the orchestrator labelled as the worker's own cases executed by the
supervisor. Repeats are blocked by the existing args+hash cache. The probe sets
`lastProbeHash` like any other: the gate's invariant is that the code tested is the
code approved, whoever asked. `orchestratorProbedBeforeDone` still counts only the
orchestrator's own probes, so the behaviour under study stays measurable.

**Retention.** On a successful run, every report finding becomes a semantic memory
record with the worker's claim label, `source: "agent"` (the source agents' memory mail
already uses; the worker id is in the evidence and the text), `status: "candidate"`,
confidence 0.4, evidence `run:<id>`, the worker id, and the worker's own
`evidence_refs`. The ledger's rule applies unchanged: an `interpreted` or `hypothesis`
finding needs a `settlement_criterion` (an optional field on the report schema), and
one without it is filed as `unreviewed`. A writer never promotes its own record; the
oracle's evidence never attaches to a worker's claim.

**Everything else.** `tracker.reports` in `lib/workers.mjs`; one ledger line in the
compaction instructions; `summary.reports` = `{ enabled, autoProbe, total, byWorker,
unreported, verifyCases, autoProbes }`; the worker prompt gains one paragraph, appended
by `resolveWorkerPrompt` so every task's own `worker.md` gets it without edits.

**Config.** `report: true` = tool on + gate rule; `report: { autoProbe: true }` adds the
auto-probe; absent/false = nothing registered, gate input always empty. Off by default
so paired runs stay comparable; the default flips only after a pair shows a gain.

**Measurement.** Three-way batch on `orbit` (baseline `configs/orch-orbit-27b.json`,
`report: true`, `report: { autoProbe: true }`): oracle outcome, probes by origin,
`summary.reports.unreported` at finish, whether the orchestrator's own probes reuse
the worker's cases, `E_excl`.

## 4. Slice C — campaign contract

**The campaign is data.** `campaigns/<name>.json`:

```json
{
  "name": "spe162910",
  "phases": [
    { "phase": "study",     "config": "configs/orch-dw-paper-study-27b.json",     "rounds": 2, "file": "study.json" },
    { "phase": "apply",     "config": "configs/orch-dw-paper-apply-27b.json",     "rounds": 3, "file": "exploration.json" },
    { "phase": "synthesis", "config": "configs/orch-dw-paper-synthesis-27b.json", "rounds": 1, "file": "report.json" }
  ],
  "brake":  { "minNovelty": 0.5, "sameTitle": 0.4 },
  "budget": { "tokens": 3000000 }
}
```

`lib/campaign.mjs` validates it the way `lib/config.mjs` validates a run config (unknown
keys are errors; every config path must exist). One driver, `tools/campaign.mjs`, runs
any campaign; `tools/research.mjs` is deleted and its phases become
`campaigns/spe162910.json`. The legacy form `node tools/campaign.mjs <name> <config>
--rounds N` still works by synthesising a one-phase campaign. The novelty brake is
unchanged in substance (same query, identical rows, similar title) and moves into the
library with a test; seeding reads every earlier run's deliverable for the same task
plus the semantic record titles in the campaign's memory scopes.

**Token ceiling, two layers.** Per run: `caps.tokens` (default 0 = off, env
`ARBITER_CAP_TOKENS`) ends a run the way `caps.usd` does, counting fresh input + output
across every agent; `summary.tokens` records the total. Per campaign: before each round,
`decideRound` skips it when the budget is exhausted or when the remainder is below the
median cost of the rounds run so far; a skipped round is a row in the report with its
reason, never a silent omission. When a round does run, the remainder is passed as that
run's `caps.tokens` as a backstop, so one unexpectedly expensive run cannot overshoot the
campaign. A round that is starved would fail its oracle and leave a partial episode in
memory; a round that is skipped leaves nothing, which is the failure we prefer.

**Crash recovery, not caching.** `--from <phase>:<round>` starts partway; rounds before
it are listed as skipped. The novelty tally still seeds from disk and memory, so
nothing earlier is forgotten. No digest, no journal.

**Why the seat model may author this later.** A Claude Code session driving arbiter
(the next step after these slices) can emit a campaign document instead of a hand-edited
one; the oracle still gates every round. That is where Workflow's "the model writes the
script" lands in arbiter — as data checked by code, not as a planner role.

## 5. Non-goals

- Concurrency across workers; sandboxing; any change to dyad or solo behaviour.
- Delivering the structured report to the orchestrator as a message (the free-text
  result already reaches it through pi-subagents; a second copy would confound the pair).
- Cached or replayed rounds.
- USD ceilings on campaigns (per-run `caps.usd` already exists and local runs cost $0).

## 6. Testing

Every pure decision has a unit test under `test/` (`node --test "test/**/*.test.mjs"`):
config parsing, worker definition, gate inputs, lifecycle reducer, messages pinned,
retention records, ledger line, campaign loader, round decision, novelty tally, token
totals. Extensions are driven through tsx with a fake `pi` as `test/pre-spawn-compact-ext.test.mjs`
does. Supervisor wiring is verified by the paired runs in each plan's final task.

## 7. Open items

- Whether pi maps `--thinking low` to anything on the llama.cpp provider (plan A checks
  the provider code first; `off` is the fallback treatment).
- The gate rule on a resumed worker uses lifecycle pump time for ordering; a report and a
  resume in the same millisecond tie in the report's favour (`>=`). Acceptable.
- Worker `evidence_refs` are stored as given (paths, probe ids), not prefixed `memory:`
  like the explorer's; the wiki lint may want a rule later.
