# Run analysis — workspace

This workspace holds the complete record of 23 finished runs of **arbiter**, a supervised multi-agent harness that drives coding agents on small tasks and grades the result with a hidden test. Your job is described in your system prompt: find the failure signatures that recur across these runs and say which single model-free guard would remove the most wasted cost. The deliverable is `src/findings.json`; its schema and the grounding rules are in the specification.

## Layout

```
runs/<id>/            one directory per run, <id> = start time (UTC)
  summary.json        outcome and totals (see below)
  audit.jsonl         the supervisor's event log, one JSON object per line
  bus.jsonl           every mail an agent sent, one JSON object per line
  lifecycle.jsonl     (orchestrator runs only) worker lifecycle + guard reports
  transcript.md       the run as prose: mails, supervisor messages, delegation tree
docs/backlog.md       the harness's own list of known problems and ideas — a list of hypotheses, not evidence
src/findings.json     the deliverable (currently a stub)
```

## The harness in one paragraph

A supervisor process (no model) launches one or more agents ("builder"/"critic" in the *dyad* pattern; "builder" alone in *solo*; an "orchestrator" that spawns "worker" children in the *orchestrator* pattern), relays their mail, executes the verifier's **probes** host-side against the real code, enforces caps (wall clock, tool calls, done attempts), and runs a hidden **oracle** (a test suite the agents never see) when the verifier claims `done`. A claim is only accepted if the verifier's last probe matches the current, unchanged code (`approval` / `Approval not accepted` lines). Tasks: `glob` (a glob matcher), `duration`, `decline`, `orbit` (a five-stage numerical pipeline), `intercom-review` (a code-review task).

## File formats

### summary.json
`reason` ("SUCCESS: oracle passed" or the cap/stall that ended the run), `wallSec`, `toolCalls` per agent, `mail`, `mailByKind`, `doneAttempts`, `nudges`, `caps`, `task`, `builderModel`/`criticModel` (or `model`), and for orchestrator runs `workers`, `orchestratorProbedBeforeDone`, `guards` (counts of guard actions by name/kind/role). Older runs lack some fields.

### audit.jsonl
Each line: `{"t": "<seconds since start>", "agent"?: "<role or worker:<id>>", "type": "<event>", "msg": "<text>"}`. Event types you will see:
- `tool` — an agent's tool call, `msg` = tool name + truncated arguments
- `mail` — a mail relayed; `deliver` — a supervisor message delivered (`msg` = why)
- `probe` — a host-side probe run: cases executed / blocked (a blocked case is an exact repeat against unchanged code)
- `approval` / `Approval not accepted` texts appear in `deliver` reasons and in transcript.md
- `oracle` — a hidden-test verdict, e.g. `Oracle run #1: 58/59 passed.`
- `settled` (agent idle), `silent_turn` (a turn produced text but no tool call), `bash_timeout` (a bash call aborted by the watchdog), `stderr`, `rpc_error`, `model_error`, `retry`
- orchestrator runs: `spawn`, `resume`, `report`, `decide` (the orchestrator's first tool call after a worker report), `worker_failed`, `guard` (an in-band guard acted: `path denied`, `bash_timeout rewritten`, `context_diet rewritten`), `memory`
- `finish` — the final line: outcome, cost, totals

### bus.jsonl
Each line: `{"ts": <epoch ms>, "from": "<role>", "to": "<role|supervisor>", "kind": "<question|answer|proposal|status|done|probe|memory>", "body": "<text>", "truncated": <bool>}`. A `probe` body is a JSON array of cases the verifier asked the supervisor to run.

### lifecycle.jsonl
Each line: `{"ts": <epoch ms>, "ev": "<subagents:started|completed|…|guard:<name>_<kind>>", "data": {...}}`.

### transcript.md
Every mail and supervisor message in order, each headed `### [<t>s] <from> → <to> (<kind>)`, preceded in orchestrator runs by a `## Delegation` tree (worker briefs, resumes, reports).

## Working method

Quotes in `findings.json` must be **verbatim substrings** of the cited file (copy them; `grep -n` is your friend). Count occurrences across runs with `grep -c` / `grep -l` over `runs/*/audit.jsonl` before writing a finding — a signature is only a signature if it recurs. Put scratch notes under `src/notes/` if you need them; only `src/findings.json` is graded.
