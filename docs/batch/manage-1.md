# Management interface — first live checks

Date: 2026-09-18. Spec: `docs/superpowers/specs/2026-09-18-management-interface-design.md`.
Plan: `docs/superpowers/plans/2026-09-18-management-interface.md`.

This is the log of the live checks for Tasks 2–5. **Every section below is a skeleton written
with the code, not a result.** Nothing here was run; the controller fills each section from the
run it actually performs, and leaves any section it skips marked as not run.

## 0. What was built

| task | what | state |
|---|---|---|
| 1 | task state, ledger, packet assembler | on this branch |
| 2 | triggers, pause, supervisor wiring, instruction executor (`continue`, `correct`, `escalate`) | on this branch |
| 3 | `restore` and `compare` over the fork runner; findings | on this branch |
| 4 | `accept` with the four evidence kinds; checkpoints | on this branch |
| 5 | manager driver, replay harness, `serve` loop | on this branch |

All five are on `management` and none is on `master`.

## 1. Trigger and pause (Task 2, step 9)

Config: pathnorm with `manage: { enabled: true, failThreshold: 1, taskDir: … }`.

- [ ] `manage:trigger` fires on the first failed verdict, and the delivery waits.
- [ ] `tools/manage.mjs execute` with a `correct` releases it, with the message delivered.
- [ ] A second run with no executor defaults after 120 s with `manage:defaulted`.

Run ids, lifecycle lines and the audit excerpts go here.

## 2. Restore and compare (Task 3)

- [ ] A `restore` from a captured inference produces a run, and its id lands as an outcome row.
- [ ] A `compare` of two branches × 2 replicates writes reports, a candidate finding and a
      `comparison_ready` packet.

The compare table and the finding ids go here.

## 3. Acceptance (Task 4)

- [ ] A milestone is accepted only with evidence of the kind its criterion declares.
- [ ] A missing-evidence `accept` is refused and the refusal names the criterion.
- [ ] A checkpoint candidate is preserved by the run and promoted by hand.

## 4. First live manager (Task 5, step 4)

One pathnorm task with `manage.enabled` on a config that fails at least once, with
`node tools/manage.mjs serve <taskDir>` driving the decisions (`--run <runId>` adopts a run whose
trigger events and config both fail to name the task).

**The two deadlines, and why they are not the same number.** The supervisor holds a paused
delivery for `manage.timeoutMs` / `MANAGE_DECISION_TIMEOUT_MS`, default 120 000 ms, then defaults
and closes the pause. The driver's own budget for one decision is `--timeout <ms>`, else
`MANAGE_DRIVER_TIMEOUT_MS`, else **0.75 of the supervisor's deadline — 90 000 ms by default**.
The difference is not slack. Noticing the lifecycle event costs up to `pollMs` (2 000 ms), the
supervisor reads the control file on its own 2 s poll, and packet assembly and the executor sit
in between. An answer that arrives at the deadline arrives at a pause that has already closed:
the withheld verdict has gone out alone and the correction lands behind it, which is what §4
forbids. Raise one and you raise both — set `MANAGE_DECISION_TIMEOUT_MS` and the driver follows
at 0.75; set `MANAGE_DRIVER_TIMEOUT_MS` only to shrink the driver's share further. One retry on a
429 / 529 / 5xx fits inside the driver's budget and is skipped when it would not.

**The key.** `ANTHROPIC_API_KEY` in the environment, else an `ANTHROPIC_API_KEY=` line in the
repo's `.env` (quotes stripped); `ARBITER_DOTENV=<file>` names another file instead of the
repo's own. Missing → exit 2 before any request. A bare `--timeout`, `--model` or `--run` (the
flag with no value) is exit 2 too, never a silent default.

**`ARBITER_WS_SOURCE`** is the fourth environment variable in play, and the executor sets it
rather than an operator: it names the accepted checkpoint a restored run builds its workspace
from. It is MANAGE-gated inside the supervisor, so a config with no `manage` block ignores it and
starts from the task's seed — which is why a `ck-` restore is refused unless its config enables
`manage`. A workspace carrying a symbolic link or junction is refused on the way in and on the
way out: neither a restore nor a checkpoint candidate will preserve one.

**`budget.used` is consumption, for all five keys.** A run's own wall seconds and tool calls are
charged against the task at the ended trigger, from that run's `summary.json`, in the same write
that takes the run out of `current.activeRuns` — so a re-fold cannot charge twice. A run that
wrote no summary is charged nothing and the ledger row says its cost is unknown, and a run that
overran the task's ceiling is charged what was left with the overrun named in the row. A
manager's grant is charged on top, when it is made. `usd` is the one key still uncharged: the
manager's own token usage is recorded per row (`manager.usage`) and no price table converts it
yet.

**The model matters.** Forced `tool_choice` is a hard 400 on the fable and mythos families, and
every packet forces the `instruct` call, so `decide`, `replay` and `serve` refuse those ids rather
than spend a run writing defaults. The live manager is `claude-opus-5`.

**One loop per task.** `serve` takes `serve.lock` (an exclusive create holding `{ pid, startedAt }`)
and a second loop refuses with exit 3 while the first is alive; a lock whose owner is gone is
taken over. It answers each trigger once, durably, and the marker is the packet: a crash after the
packet is written skips the trigger and lets the supervisor default it, rather than launching the
same `restore` or `compare` twice.

| packet | trigger | verb | rationale (abridged) | outcome | manager ms |
|---|---|---|---|---|---|
| | | | | | |

Notes on what the manager saw and whether the instruction was the right one go here.

## 5. Manager selection by replay (§7)

The same packets replayed against cheaper candidates:

```
node tools/manage.mjs replay <taskDir> --model claude-sonnet-5
node tools/manage.mjs replay <taskDir> --model claude-haiku-4-5
```

| model | agreement | by trigger kind | cost |
|---|---|---|---|
| claude-opus-5 (live) | — | — | |
| claude-sonnet-5 | | | |
| claude-haiku-4-5 | | | |

Confusion table (ledger verb → candidate verb) and the routing conclusion go here: which trigger
kinds a cheap manager may answer, and which go to the expensive one.

## 6. What this changes

Findings, open questions and the next slice go here.
