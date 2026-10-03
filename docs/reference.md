# arbiter reference

Configuration, task format, run output, and command-line tools. For what arbiter is and why, see the [README](../README.md).

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

| Field | Meaning |
|---|---|
| `task` | A directory under `tasks/`. |
| `pattern` | `solo` (one builder), `dyad` (builder + critic), or `orchestrator` (orchestrator + pi-subagents workers). |
| `roles` | Provider and model per role, as pi names them. `worker.max` caps concurrent workers. |
| `caps` | Run limits: tool calls, wall-clock seconds, USD, tokens, and `done` attempts. A run that hits one ends with a `CAP` outcome. |

Optional blocks turn on memory recall, a worker roster, guards, supervisor-timed compaction, the Jev done-guard, and the management interface. Each is off by default so paired runs stay comparable. Environment variables override single fields for one-off runs, for example `ROLE_builder_MODEL=claude-haiku-4-5 node supervisor.mjs`.

## Run patterns

| Pattern | Roles | Who triggers the oracle |
|---|---|---|
| `solo` | builder | the builder's own `done`, or a quiet, settled workspace |
| `dyad` | builder, critic | the critic's approval |
| `orchestrator` | orchestrator, workers | the orchestrator's `done` claim |

Agents talk only through `send_mail`, which appends to a bus file the supervisor tails. Routing is decided by sender and `kind`, never by the body: `probe` and `done` from the verifying role are intercepted (the supervisor runs probes against the live code and runs the oracle on claims); `memory` is stored for future runs; everything else is relayed to the peer as a pi *steer*. Workers are reached only through the orchestrator's subagent tools.

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

Check a task before any agent sees it: the reference must pass every hidden test, the stub must pass none, and the probe runner must answer.

```bash
node tools/verify-task.mjs pathnorm
node tools/verify-task.mjs --all
```

## Run output

Every run writes to `runs/<timestamp>/`:

| File | Contents |
|---|---|
| `summary.json` | Outcome, oracle score, wall time, cost, tokens, tool calls, probes, guard counts. |
| `transcript.md` | Human-readable run: briefs, mail, probes, worker reports, oracle verdicts. |
| `bus.jsonl` | Every `send_mail` message. |
| `lifecycle.jsonl` | Worker lifecycle and guard events. |
| `audit.jsonl` | Everything the supervisor did, timestamped. |
| `decisions.jsonl` | One line per orchestrator inference, used by fork replay. |
| `sessions/` | Every agent's pi session. |
| `ws-builder/` | The final workspace. |

`node tools/build-console.mjs` compiles every run into `tools/console.html`, a static replay viewer.

## Tools

| Command | Purpose |
|---|---|
| `node supervisor.mjs --config <file>` | Run one task. |
| `node tools/batch.mjs <name> <configs...>` | Run configs in sequence and write a report to `docs/batch/<name>.md`. |
| `node tools/campaign.mjs campaigns/<name>.json` | Multi-phase campaigns under a shared token budget. |
| `node tools/fork.mjs <runId> <call> --config <file> --branch G\|A-natural\|A-oracle` | Restart a recorded run at an inference call, optionally forcing the next action. |
| `node tools/decision-points.mjs [runId ...]` | Extract the decision points of runs. |
| `node tools/verdict.mjs <runId> accept\|reject "why"` | Record a human verdict and promote or tombstone the run's memory candidates. |
| `node tools/memory.mjs list\|promote\|tombstone\|consolidate\|lint` | Manage the memory log and wiki. |
| `node tools/build-console.mjs` | Build the run console. |
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
tools/           batch, fork, memory, console and analysis CLIs
memory/          the memory log (wiki and index are generated)
docs/            design specs, plans, backlog, and batch reports
test/            node:test suite
```
