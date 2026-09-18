# Management interface — design

Date: 2026-09-18. Status: spec, not yet built. Follows `docs/batch/outer-loop-1.md` (the hand-run cycle this generalises) and the fork runner spec. The fork results from run `2026-09-18T00-01-44` (calls 4 and 22) will be the first ledger entries and will validate the packet and ledger formats below; they do not block the contract.

## What it is

A persistent management structure around the agents doing the work. Four roles:

| role | owns | model-driven? |
|---|---|---|
| **Manager** | the overall goal and its acceptance criteria; milestones; assessing progress from evidence; deciding when to change approach | yes — a paid model, called at triggers only |
| **Orchestrator** | turning the current milestone into assignments, coordinating workers, inspecting results, reporting completion or blockers | yes (today: Qwen3 27B in pi) |
| **Workers** | bounded implementation, testing and investigation | yes (pi subagents) |
| **Harness** | executing tools, enforcing budgets and permissions, preserving checkpoints, recording what happened, carrying out the manager's instructions | no — deterministic |

The control machinery between manager calls is deterministic. The orchestrator and workers remain model-driven. Forking, correcting and comparing are capabilities the harness gives the manager; automated experimentation is one use of them, not the point of the structure.

The manager never touches the workspace, the oracle or a transcript directly. It receives an observation packet and returns one instruction. The same isolation that keeps the oracle out of the workers' reach keeps it out of the manager's.

## Files

Everything lives under a **task directory** that outlives any single run: `tasks-live/<task-id>/`.

```
tasks-live/<task-id>/
  task.json          durable task state (§1) — rewritten atomically on every change
  ledger.jsonl       management ledger (§5): every trigger, packet id, instruction, outcome
  packets/<n>.json   every observation packet handed to a manager, verbatim
  checkpoints/<id>/  accepted workspace checkpoints (a snapshot dir + manifest)
  runs -> ../../runs/<run-id>  (the harness's existing run records, by reference)
```

## 1. Durable task state — `task.json`

The manager must not reconstruct the project from history. `task.json` says where the task stands, and every packet carries it whole.

```json
{
  "taskId": "raid-2026-09-18",
  "goal": "…one paragraph, human-written…",
  "acceptance": {
    "criteria": [ { "id": "c1", "text": "…", "check": "oracle:tasks/raid/oracle" },
                  { "id": "c2", "text": "…", "check": "playthrough:docs/raid/playthrough.md" },
                  { "id": "c3", "text": "…", "check": "review:human" } ],
    "hash": "sha256 of criteria as written — immutable for the task's life"
  },
  "milestones": [
    { "id": "m1", "title": "…", "criteria": ["c1"], "status": "accepted", "acceptedCheckpoint": "ck-0007", "acceptedAt": 0, "evidence": ["oracle:runs/…/oracle-1"] },
    { "id": "m2", "title": "…", "criteria": ["c2","c3"], "status": "active" },
    { "id": "m3", "title": "…", "criteria": [], "status": "pending" }
  ],
  "current": { "milestone": "m2", "checkpoint": "ck-0007", "activeRuns": ["2026-09-18T01-02-03"], "activeBranches": [] },
  "blockers": [ { "id": "b1", "text": "…", "raisedBy": "orchestrator", "raisedIn": "run-id", "status": "open" } ],
  "budget": { "wallSec": { "total": 14400, "used": 3812 }, "runs": { "total": 20, "used": 6 }, "forkReplicates": { "total": 24, "used": 12 }, "usd": { "total": 10, "used": 0 } },
  "stateVersion": 41
}
```

Rules:

- `acceptance.criteria` and `acceptance.hash` are written by a human when the task is created. **No instruction can change them.** A manager that wants a criterion changed emits `escalate` (§3) and a human edits the file; the hash changes and the ledger records it.
- `stateVersion` increments on every write. Every packet and every instruction carries the version it was built on (§4).
- `current.checkpoint` is the last **accepted** workspace, never the live one. The live workspace is a run's; a run that ends without acceptance leaves the checkpoint where it was.
- Budgets are the harness's to enforce. A manager instruction that would exceed one is refused before execution, and the refusal is a ledger row.

## 2. Observation packet — `packets/<n>.json`

Assembled by the harness at a trigger; bounded; the same shape every time, so packets can be replayed against candidate managers (§7).

```json
{
  "packetId": 17, "trigger": { "kind": "oracle_failed_repeatedly", "runId": "…", "detail": { "attempts": 3, "scores": ["68/70","68/70","69/70"] } },
  "task": { …task.json verbatim… },
  "run": {
    "id": "…", "config": "…", "milestone": "m2", "status": "running|finished", "reason": "…",
    "wallSec": 0, "decodedTokens": 0, "toolCalls": 0, "mails": 0,
    "oracle": [ { "attempt": 1, "pass": 68, "total": 70 } ],
    "workers": [ { "wid": "…", "type": "tester", "status": "completed", "reported": true, "summary": "…≤300 chars…" } ],
    "guards": { "topology": { "denied": 1 }, "path": { "denied": 3 } },
    "decisions": { "points": 38, "substantive": { "spawn": 3, "resume": 10, "probe": 5, "done": 6 } },
    "heads": { "local27b": { "agreement": 0.71, "confidentDisagreements": [ { "call": 21, "recorded": "done", "head": "probe", "p": 0.93 } ] },
               "jev":      { "agreement": 0.47, "doneCheck": { "call": 21, "pPass": 0.77, "verdict": "pass" } } },
    "chain": [ "…the causal chain from lib/causal-links.mjs, ≤ 40 lines…" ],
    "tail": "…the last ~2 000 chars of the orchestrator's transcript, redacted…"
  },
  "history": {
    "recentInstructions": [ { "packetId": 15, "verb": "correct", "outcome": "run finished 68/70" } ],
    "settledFindings": [ { "id": "f3", "claim": "…", "verifiedOn": ["run-a","run-b"] } ]
  },
  "options": { "verbsAllowed": ["continue","correct","restore","compare","accept","escalate"], "budgetLeft": { … } }
}
```

Size bound: ≤ 32k tokens rendered (the same bound Jev imposed, and enough for any current model). Secrets are redacted with `lib/jev.mjs redact`. The packet never contains oracle case inputs, the hidden test, or a worker's raw transcript.

## 3. Instruction contract

The manager returns exactly one instruction:

```json
{ "packetId": 17, "basedOnStateVersion": 41, "idempotencyKey": "p17-v41", "verb": "…", "args": { … }, "rationale": "≤ 500 chars, for the ledger" }
```

| verb | args | the harness does | preconditions checked at execution |
|---|---|---|---|
| **continue** | `{ runId, milestone, budgetGrant: { wallSec, toolCalls } }` | lets the named run proceed toward the named milestone with the granted budget added to its caps | run is still live; milestone is `current`; grant within task budget |
| **correct** | `{ runId, message }` | delivers `message` to the orchestrator as a supervisor prompt (the existing deliver path) | run live; message ≤ 2 000 chars; no secrets |
| **restore** | `{ checkpoint, approach: { config?, firstAction?, message? } }` | starts a new run from the named checkpoint (an accepted checkpoint, or a captured inference of a run via the fork runner), with an optional forced first action class and/or a delivered message | checkpoint exists; run budget left; no live run on the same milestone unless `parallel: true` |
| **compare** | `{ checkpoint, branches: [ { label, firstAction?, message? } ], replicates }` | runs every branch × replicates through the fork runner, then triggers `comparison_ready` with the report | fork budget left; ≥ 2 branches; replicates ≥ 2 |
| **accept** | `{ milestone, checkpoint, evidence: [ … ] }` | marks the milestone accepted at that checkpoint **only if** §6 passes; advances `current` | evidence satisfies every criterion the milestone names |
| **escalate** | `{ reason, wants: "criteria_change" \| "human_review" \| "budget" }` | pauses the task, writes the ledger row, notifies the human; nothing else moves | — |

Rules:

- **State check.** `basedOnStateVersion` must equal `task.json`'s current version at execution. If the task moved (a run finished, a worker reported, a checkpoint was accepted) the instruction is **refused with the new packet**, not executed against the state the manager did not see. `continue` included: the run, the milestone and the grant are all checked.
- **Idempotency.** `idempotencyKey` is recorded in the ledger before execution. A retried delivery with the same key is acknowledged and not executed again; a `restore` or `compare` can never launch twice.
- **One instruction per packet.** A packet answered is closed. New evidence produces a new packet.
- **What the manager cannot do:** edit `acceptance`, touch the workspace, read the oracle, address a worker directly, or issue a verb not in `options.verbsAllowed` (the harness prunes the list when budget or state rules one out).

## 4. Trigger behaviour — what happens while the manager decides

Triggers, all emitted by the harness from events it already logs:

| trigger | when | orchestrator while the manager decides |
|---|---|---|
| `milestone_candidate` | the run's oracle (or evidence check) for the active milestone passed | run is finished; nothing to pause |
| `oracle_failed_repeatedly` | N failed done attempts on one milestone (N from config, default 2) | **paused**: the failed verdict is withheld until the instruction arrives, then delivered together with any `correct` message |
| `budget_threshold` | a run crosses a fraction of its caps (default 0.75) | continues; the instruction is delivered at the next turn boundary |
| `escalation` | the orchestrator sends `kind="escalate"` mail (new kind, routed like a done claim) | **paused** at the mail |
| `run_ended_without_acceptance` | caps hit, crash, or done attempts exhausted | run is finished |
| `comparison_ready` | a `compare` batch finished | no live run |

"Paused" means the supervisor holds the next delivery to the orchestrator. The orchestrator is blocked on that delivery anyway (it is waiting for a verdict or a reply), so nothing moves in the workspace. The harness enforces a **decision timeout** (default 120 s): on timeout the default instruction is `continue` with a zero grant, recorded as such, so a slow or absent manager degrades to today's behaviour rather than deadlocking the run.

If the manager's instruction arrives after the state moved anyway (a worker report that was already in flight), the version check refuses it and a fresh packet is issued. The manager is expected to answer packets quickly and small; it is never asked to watch.

## 5. Management ledger — `ledger.jsonl`

One row per event, append-only:

```
{ "ts", "packetId", "stateVersion", "trigger", "manager": { "model", "ms", "usd" }, "instruction": { … }, "verified": true|false, "refused": null | "reason", "executed": { "runId"? , "batch"? }, "outcome": { … filled by the harness when the consequence is known … } }
```

Plus **findings**, written by the harness from `compare` outcomes and read back into packets as `history.settledFindings`, using the memory system's claim shape (`lib/memory.mjs makeRecord`, kind `hypothesis` → `verified`):

```
{ "id": "f3", "scope": "harness:pathnorm", "claim": "At a gather of kind ls where both heads say spawn at p ≥ 0.95, skipping the gather changes neither first-try oracle nor final oracle.",
  "settlement_criterion": "A-natural equals G on first-try oracle across ≥ 3 replicates on ≥ 2 runs.",
  "evidence": [ "docs/batch/fork-2026-09-18T00-01-44-4-G.md", "…-A-natural.md" ], "status": "candidate|verified|refuted", "verifiedOn": [] }
```

A finding is `verified` only when its criterion held on a second run. Verified findings are what let a decision become a rule: the harness may then answer the matching trigger itself (e.g. skip the gather) and record that it did, without a manager call. That promotion is a human-reviewed config change, not something the manager performs.

## 6. Acceptance rules — evidence, not assertion

A milestone is accepted only when every criterion it names has evidence of the kind the criterion declares:

| check kind | evidence the harness requires | who can produce it |
|---|---|---|
| `oracle:<dir>` | a run's oracle result for that dir with pass = total, on the checkpoint being accepted | harness only |
| `playthrough:<script>` | the script's recorded output on the checkpoint, exit 0, with its log attached | harness runs it |
| `artifact:<path>` | the file exists in the checkpoint and passes the criterion's validator (schema, size, a grep) | harness |
| `review:human` | a human's signed ledger row naming the checkpoint | human |

The manager decides *whether the required evidence is present* and asks for acceptance; the harness verifies it against the criterion as written. A manager cannot accept a milestone by asserting the criteria are met, cannot lower a threshold, and cannot substitute one check kind for another. If the evidence is missing, `accept` is refused and the refusal names the criterion.

## 7. Choosing the manager — decision quality first, cost second

"Pick one of six verbs" hides the hard case: deciding whether to continue or change approach requires reading the failure pattern, and a cheap manager that always answers `continue` wastes far more worker time than it saves.

- **Every packet is recorded verbatim**, with the instruction and its outcome. That is a labelled dataset from day one.
- **Candidate managers are evaluated offline** by replaying recorded packets and scoring their instructions against the outcome the ledger recorded (did `continue` lead to the milestone; did `restore` beat it; was `accept` refused). Same method as the decision-head replays, one level up.
- **Routing**: a cheap manager answers a packet only for trigger kinds and packet shapes where the replays show it matches the expensive one; everything else goes to the expensive one. The router is a config table, revised from the replays, not a live judgment.
- The first live manager is the most capable model available, so the dataset is labelled by good decisions.

## 8. Experimentation as a capability

The hand-run cycle in `docs/batch/outer-loop-1.md` becomes: trigger `run_ended` or `milestone_candidate` → packet carries the heads' confident disagreements → the manager may answer `compare` with branches derived from them → `comparison_ready` → the harness writes a candidate finding → a later packet shows it as settled or refuted. The selection rule that was applied by hand (gather step, both heads confident, no guard requires it, cheap to skip) is the manager's to apply from the packet; once findings settle, it becomes a harness rule.

## Non-goals for the first build

Multiple concurrent tasks; a manager that edits prompts or code; cross-task findings; any manager action between triggers; milestones for tasks that have no checkable criterion at all.

## Build order (for the plan)

1. `task.json` + ledger writer + packet assembler over existing run records (no manager yet; packets written at triggers, default `continue`).
2. Instruction executor with version check and idempotency, for `continue`, `correct`, `escalate`.
3. `restore` and `compare` over the fork runner; findings writer.
4. `accept` with the four evidence kinds; checkpoints.
5. First live manager; packet replay harness for §7.
