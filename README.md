# arbiter

**A model-free supervisor for multi-agent coding runs, and a test bench for the harness around them.**

arbiter launches [pi](https://github.com/earendil-works/pi) coding agents on a task, relays every message between them, enforces budgets, and decides success with a **hidden oracle** the agents never see. The supervisor contains no language model: it relays, counts, kills, and runs the oracle. It is the one component in the system that cannot be argued with.

Each run is an experiment. Every guard, memory policy, and prompt change is measured with paired runs before it is kept.

```text
            ┌──────────────────── supervisor.mjs (no LLM) ────────────────────┐
            │  mail routing · approval gate · caps · watchdogs · hidden oracle │
            └──────▲───────────────────────▲──────────────────────────▲───────┘
         bus.jsonl │ send_mail      RPC steer│ prompts       lifecycle │ events
            ┌──────┴───────┐        ┌──────┴───────┐          ┌───────┴───────┐
            │ orchestrator │──────▶ │   workers    │  ...     │  guards (in-  │
            │  (pi agent)  │ subagent tools        │          │  band hooks)  │
            └──────────────┘        └──────────────┘          └───────────────┘
                       shared workspace (ws-builder/)  ·  oracle stays outside
```

## Why

Agent harnesses tend to grow rules from anecdotes. arbiter takes the opposite approach:

- **The model never grades itself.** A `done` claim triggers hidden acceptance tests; the agent only learns the verdict.
- **Verifiers probe, builders don't self-report.** A verifying role sends `probe` mail; the supervisor runs it against the real current code and returns real values.
- **Hooks decide, the supervisor rules.** Checks on one agent's own tool call run in-band as pi extensions. Anything cross-agent, or anything that needs authority the model's process must not hold, stays in the supervisor.
- **Evidence over self-report.** Memory records are promoted only with oracle evidence; a writer never promotes its own record.

## Features

| Area | What it does |
|---|---|
| **Run patterns** | `solo` (one builder), `dyad` (builder + adversarial critic), `orchestrator` (an orchestrator that delegates to pi-subagents workers). |
| **Mail bus** | `send_mail` is the only channel between agents. Routing is decided by sender and `kind`, never by message body; probes and approvals are intercepted. Delivered as a pi *steer*, so busy agents receive it after the current tool round. |
| **Approval gate** | A `done` claim passes only when the workspace has been probed as it stands and no worker is mid-edit. Repeated identical probes on unchanged code are answered from cache. |
| **Guards** | In-band pi extensions on the `tool_call` edge: a path guard that keeps agents inside their workspace and away from the oracle, and bash-timeout injection. Each deny carries a redirect and is counted in the run summary. |
| **Caps and watchdogs** | Tool calls, wall clock, USD, tokens, and done attempts; silent-turn nudges; bash watchdog. |
| **Fork replay** | Restart a recorded run at any inference call with its workspace snapshot, then let it continue (`G`) or force an action class (`A-natural`) or the recorded action (`A-oracle`). Counterfactual analysis of individual decisions. |
| **Memory** | Append-only `memory/records.jsonl` with promote/tombstone ops, compiled deterministically into a wiki (`memory/wiki/`) and recalled within a budget. No embeddings, no graph store. |
| **Compaction** | Supervisor-timed compaction at phase boundaries, with the orchestrator's own `checkpoint` folded into the instructions. |
| **Management** | Optional escalation channel: the orchestrator can ask a manager for a decision while the supervisor holds delivery. |
| **Measurement** | Batch and campaign runners with KPI reports; a static console of every run; decision-point extraction and replay. |

## Requirements

- Node.js 22+ (developed on Node 26).
- A checkout of [pi](https://github.com/earendil-works/pi) with dependencies installed. arbiter looks for it in a `pi/` directory next to its own, or wherever `ARBITER_PI` points. Developed against pi `coding-agent` 0.85.
- A model provider configured in pi. The bundled configs use a local [llama.cpp](https://github.com/ggml-org/llama.cpp) server (`qwen3-27b`); any provider pi supports works.

```text
some-dir/
├── arbiter/   # this repo
└── pi/        # earendil-works/pi checkout, `npm install` done
```

## Quick start

```bash
git clone https://github.com/bagude/arbiter.git
cd arbiter
npm install
npm test                      # test suite; no model calls (some tests load pi extensions from the pi checkout)

# check that a task's oracle is self-consistent before any agent sees it
node tools/verify-task.mjs pathnorm

# run one task with the orchestrator pattern
node supervisor.mjs --config configs/orch-pathnorm-27b.json
```

Every run writes to `runs/<timestamp>/`: `summary.json` (outcome, oracle score, cost, tokens, guard counts), `transcript.md`, the mail bus, the lifecycle log, every agent's session, and the final workspace.

## Configuration

A run is described by a small JSON file. `arbiter.json` is the default; `configs/` holds the variants used in experiments.

```json
{
  "task": "pathnorm",
  "pattern": "orchestrator",
  "roles": {
    "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" },
    "worker":       { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 }
  },
  "caps": { "toolCalls": 250, "wallSec": 1800, "usd": 5, "doneAttempts": 5 }
}
```

Optional blocks turn on memory recall, a worker roster, guards, compaction, the Jev done-guard, and the management interface. Each is off by default so paired runs stay comparable. Environment variables override single fields for one-off runs, for example `ROLE_builder_MODEL=claude-haiku-4-5 node supervisor.mjs`.

## Tasks

A task is a directory under `tasks/<name>/`:

```text
tasks/pathnorm/
├── spec.md          # what the agents are told to build
├── ws-builder/      # the starting workspace (README + stub src/)
└── oracle/          # hidden: never copied into the workspace
    ├── *.test.mjs   # acceptance tests
    ├── reference.mjs
    └── probe.mjs    # runs a verifier's probe against the current code
```

`tools/verify-task.mjs` checks that the reference passes every hidden test, the stub passes none, and the probe runner answers.

## Tools

| Command | Purpose |
|---|---|
| `node tools/batch.mjs <name> <configs...>` | Run configs in sequence and write a report to `docs/batch/<name>.md`. |
| `node tools/campaign.mjs campaigns/<name>.json` | Multi-phase campaigns under a shared token budget. |
| `node tools/fork.mjs <runId> <call> --config <file> --branch G\|A-natural\|A-oracle` | Fork a recorded run at an inference call. |
| `node tools/decision-points.mjs` | Extract the decision points of a run. |
| `node tools/verdict.mjs <runId> accept\|reject "why"` | Record a human verdict and promote or tombstone the run's memory candidates. |
| `node tools/memory.mjs promote\|tombstone\|list\|consolidate\|lint` | Manage the memory log and wiki. |
| `node tools/build-console.mjs` | Build `tools/console.html`, a static browser view of every run. |
| `npm run smoke:substrate`, `npm run smoke:guards` | Live smoke tests against a real pi process. |

## Repository layout

```text
supervisor.mjs   the supervisor: launches agents, routes mail, gates, judges
lib/             pure, unit-tested logic (routing, gate, policies, memory, fork, ...)
ext/             pi extensions loaded into agent processes (mail, guards, memory, checkpoint)
prompts/         role prompts (builder, critic, orchestrator, worker)
roster/          worker specialist definitions
tasks/           tasks with hidden oracles
configs/         run configurations
campaigns/       multi-run campaign definitions
tools/           batch, KPI, fork, memory, console and analysis CLIs
memory/          the memory log (wiki and index are generated)
docs/            design specs, plans, backlog, and batch reports
test/            node:test suite
```

## Results so far

Design decisions and their evidence are written up as they happen:

- [`docs/backlog.md`](docs/backlog.md): what was built, what was measured, and what was rejected, with run IDs.
- [`docs/batch/`](docs/batch): batch reports. For example, ten hidden-oracle tasks with a local 27B orchestrator passed 9/10, every success on its first `done` claim ([night-2026-09-12](docs/batch/night-2026-09-12.md)).
- [`docs/superpowers/specs/`](docs/superpowers/specs): design specs (fork runner, memory wiki, working context, management interface).

Findings are reported at the sample size they were measured at; many are N=1 and are labelled as such.

## Status

Research code under active development. Interfaces, config fields, and file formats change without notice.

## License

[MIT](LICENSE)
