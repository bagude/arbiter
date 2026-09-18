# Final whole-branch review — `management` (2a4b514..2c4294d)

Reviewer: whole-branch (not a re-review of the per-task rounds). Read-only; nothing committed.

- **Range**: `2a4b514..2c4294d`, **45 commits**, 51 files, +8787/−59.
- **Suite**: `npm test` run once from the arbiter root — **738 pass, 0 fail, 0 skipped**, exit 0,
  2.56 s. Matches the expected count.
- **Spec**: `docs/superpowers/specs/2026-09-18-management-interface-design.md` (read in full).
- **Hygiene**: `git diff --stat` and `git log --stat` over the range touch no path under
  `memory/`, `runs/`, `tasks-live/` or `.env`. `.gitignore` gains `tasks-live/`. Verified.

## Verdict

**Mergeable after the listed fixes.** The architecture holds up end to end: `task.json` really
does have one writer, acceptance really is immutable on every path that writes it, the ledger
row really does precede every act with a consequence, and the pause state machine is pure,
unit-tested and correctly the single chokepoint in `deliver()`. The per-task rounds did their
job — I found no defect of the kind a per-task review should have caught. What the whole-branch
view exposes is a different class: contracts stated in one place and implemented differently in
another. The one Critical is that the manager's own prompt and tool description teach a
checkpoint syntax the parser rejects, so the live manager this branch exists to introduce cannot
use `restore` or `compare` from a captured inference at all — four of the six verbs work and two
are silently unreachable, with no test comparing the prompt against the parser. That is a
two-character fix. Around it sit six Important findings, each a spec invariant that is written
down and not enforced (an escalation does not pause anything, `budget.used` means two different
things in one object, a hand-run instruction and the serve loop can both answer the same
trigger). None of them is structural; all are local fixes inside files this branch already owns.
The branch should not merge as is, because the Critical makes the headline feature half-inert,
but nothing here calls the design into question.

---

## Critical

### C1. The manager is told a checkpoint syntax the parser rejects — `restore` and `compare` from a captured inference are unreachable

- **Claim**: `INSTRUCT_TOOL` and the system prompt both document `run:<id>@<call>`; `parseCheckpoint`
  requires `run:<runId>#<call>`.
- **Where**: `lib/manage/manager.mjs:111` (`"...a run:<id>@<call> capture takes firstAction..."`),
  `docs/manage/manager-system.md` (the `restore` row of the verb table),
  `lib/manage/instructions.mjs:43` (`/^run:([^#]+)#(\d+)$/`).
- **Input → wrong outcome**: a `run_ended_without_acceptance` packet; the manager follows its
  prompt and answers `restore` with `checkpoint: "run:2026-09-18T05-36-41@21"`. `parseCheckpoint`
  returns `null`, `checkpointRefusal` returns `checkpoint must be ck-NNNN or run:<runId>#<call>`,
  the instruction is refused as `precondition`, and nothing runs. Every `restore` and `compare`
  from a captured inference fails this way — the two verbs the fork-runner integration (Task 3)
  was built for. The refusal text names the correct syntax, but see I4: nothing re-asks.
- **Fix**: change `@` to `#` in `lib/manage/manager.mjs:111` and in the `restore` row of
  `docs/manage/manager-system.md`. Add a test that runs every checkpoint form named in
  `INSTRUCT_TOOL.description` through `parseCheckpoint` and asserts a non-null parse — the class
  of bug is "two files describe one grammar", and only a test that reads both closes it.

---

## Important

### I1. `escalate` writes `status: "paused"` and nothing anywhere reads it

- **Claim**: §3 says `escalate` "pauses the task … nothing else moves". The write happens; the
  pause does not.
- **Where**: `lib/manage/instructions.mjs:897` writes `status: "paused"`. Grepping `lib/`, `tools/`
  and `supervisor.mjs` for a reader finds exactly one other mention of `task.status`, at
  `instructions.mjs:890`, which only carries the old value forward. `serve`, `runsForTask`,
  `assemblePacket`, `defaultVerbs` and `validateInstruction` never consult it.
- **Input → wrong outcome**: a manager escalates `wants: "criteria_change"` because a criterion is
  unreachable. The task is marked paused, the human is not notified by anything in this branch,
  and the serve loop answers the very next trigger from the same run, spends the next grant and
  can launch a `compare` — precisely the "nothing else moves" the verb promises. The same applies
  to `status: "complete"` after the final `accept`.
- **Fix**: one guard at the top of `serve`'s per-run loop and one in `validateInstruction`:
  a task whose `status` is not `"active"` refuses every verb but `escalate`, with a
  `task_paused` code. Notification can stay out of scope; the refusal is the invariant.

### I2. Symlink containment is checked on the leaf only, so an artifact criterion can read outside the checkpoint

- **Claim**: `checkArtifact` `lstat`s the resolved target and refuses a symlink there, but no
  component of the path in between, and `snapshotCheckpoint` never refuses a workspace containing
  links in the first place.
- **Where**: `lib/manage/evidence.mjs:265-281` (resolve, then `lstatSync(target)`);
  `lib/manage/checkpoint.mjs:72-87` (`snapshotCheckpoint`, no `findSymlinks` call) versus
  `supervisor.mjs` ~line 138, where the `ARBITER_WS_SOURCE` block does call `findSymlinks` and
  exits 2.
- **Input → wrong outcome**: a builder that cannot produce `docs/report.md` creates the directory
  junction `docs -> C:\Windows\System32` (the round-1 test confirms `isSymbolicLink()` reports a
  Windows junction). `finish()` snapshots it into `cand-<runId>` unchallenged; a human promotes it;
  a criterion `artifact:docs/notepad.exe:exists` resolves textually inside the checkpoint, `lstat`
  on the final component is a regular file, and the criterion passes on a file the run never
  produced. The playthrough copy has the same exposure.
- **Fix**: call `findSymlinks(fromDir)` at the top of `snapshotCheckpoint` and throw when it is
  non-empty, exactly as the `WS_SOURCE` block does. That closes the artifact read and the
  playthrough copy in one place, and it fails at the moment the bad tree is preserved rather than
  at the moment someone tries to accept it.

### I3. `options.verbsAllowed` advertises `restore` and `compare` at every pausing trigger, where they are always refused

- **Claim**: `defaultVerbs` prunes on budget and on the accept-eligible trigger kinds only. It does
  not prune on `liveWorkRefusal`, which refuses `restore` and `compare` whenever a run is pending.
- **Where**: `lib/manage/packet.mjs:145-151` (`defaultVerbs`) versus
  `lib/manage/instructions.mjs:264-272` (`liveWorkRefusal`) and its use at `:379` and `:443`.
- **Input → wrong outcome**: `oracle_failed_repeatedly` fires. `registerRunForTrigger` puts the run
  into `current.activeRuns`; `pendingRuns` reports it live (no `summary.json`, fresh `audit.jsonl`).
  The packet says `verbsAllowed: [continue, correct, restore, compare, escalate]`. The manager
  chooses `restore`, which is the right call for a run stuck at the same score, and is refused with
  "a run is still live on milestone m2 … or pass parallel: true". Because nothing re-asks (I4), the
  paused orchestrator waits out the full 120 s deadline and gets a defaulted zero-grant continue.
  The one trigger where changing approach matters most is the one where the useful verbs cannot be
  used without a flag the manager is never told about.
- **Fix**: in `defaultVerbs`, drop `restore` and `compare` when `pendingRuns` or `pendingBatches` is
  non-empty, and document `parallel: true` in `docs/manage/manager-system.md` and in
  `INSTRUCT_TOOL.description` so the manager can opt into it deliberately.

### I4. A refused instruction never produces the fresh packet §3 promises

- **Claim**: §3 says a stale instruction is "refused **with the new packet**". Verified by reading
  `serve` and `handleTrigger`: after `execute` returns a refusal the result is logged, `i` advances,
  and no packet is re-assembled. The only occurrence of "fresh packet" in `lib/manage/manager.mjs`
  is a comment about `nextPacketId`.
- **Where**: `lib/manage/manager.mjs`, `handleTrigger` (the `execute(...)` call and the `log` that
  follows it) and `serve`'s inner `for (let i = done; ...)` loop.
- **Input → wrong outcome**: any refusal on a pausing trigger — a stale version because a worker
  reported mid-decision, C1's checkpoint syntax, I3's live-run refusal, or a `continue` whose
  `milestone` is null because the last milestone was just accepted. One refusal row goes down, the
  manager is never re-asked, and the run waits the remaining deadline for a default. The packet's
  budget has already been spent on a decision that was discarded.
- **Fix**: in `handleTrigger`, on `result.code === "stale_version"` (only — a precondition refusal
  will repeat), re-assemble one fresh packet and decide once more, bounded to a single retry and to
  whatever is left of the driver budget. Refusals that are not stale should at minimum be logged at
  a level an operator sees, since they are silent today outside `serve.log`.

### I5. `budget.used` means two different things in one object, and `wallSec`/`toolCalls` can never be exhausted

- **Claim**: `runs` and `forkReplicates` are charged on consumption (`prepareBatch`'s `spend`);
  `wallSec` and `toolCalls` are charged only when a manager explicitly grants them. Nothing ever
  charges a run's actual wall time or tool calls against the task budget.
- **Where**: `lib/manage/instructions.mjs:830-833` (grant only) and `:731` (`spend` for a batch) are
  the only two `spendBudget` call sites in the repo (verified by grep). §1's example shows
  `"wallSec": { "total": 14400, "used": 3812 }` as consumption.
- **Input → wrong outcome**: a task with `wallSec.total: 14400` runs six 1800-second runs. Real
  wall time consumed is 10800 s; `budget.wallSec.used` is 0, `budgetLeft.wallSec` reports 14400, and
  every packet tells the manager it has the full four hours left. "Budgets are the harness's to
  enforce" (§1) holds for run and replicate counts and not for the two resources the grant verb is
  built around.
- **Fix**: either charge `wallSec`/`toolCalls` from a finished run's `summary.json` totals at the
  ended-trigger fold (the executor is already saving there), or rename the two grant keys to
  `granted`/`grantsLeft` in `task.json` and in the packet so the manager is not shown a consumption
  figure that is not one. The first is right; the second is honest if the first is deferred.

### I6. A hand-run `packet` + `execute` does not advance `serve.state.json`, so the loop re-answers the same trigger

- **Claim**: §3's "a `restore` or `compare` can never launch twice" is enforced by the idempotency
  key, which is derived from the packet id — and a second packet for the same trigger gets a
  different id and therefore a different key. `serve` tracks trigger indices in
  `serve.state.json`; `tools/manage.mjs packet` never writes it (verified by grep: `markHandled`
  and `serve.state` appear nowhere in `tools/manage.mjs`).
- **Where**: `lib/manage/manager.mjs`, `markHandled` / `readServeState` / `serve`; `tools/manage.mjs`
  `cmdPacket` (lines 94-112) and `cmdExecute`.
- **Input → wrong outcome**: the ledger shows the controller driving decisions by hand during the
  live checks, which is exactly this path. A `compare` is issued by hand for trigger index 3
  (packet 12, key `p12-v41`, batch launched). The serve loop is then started, reads
  `handled[runId] = 0`, walks to index 3, assembles packet 13, gets key `p13-v42`, passes the
  duplicate check, and launches the same branches × replicates a second time — charged twice, both
  batches contending for the single model-server slot, and the fork runner's collision preflight
  abandoning one of them after the budget is spent.
- **Secondary, concurrent variant**: two executors answering different packets at once both call
  `nextCompareId`, both `mkdir` and write `compares/<n>/spec.json` before either saves. The loser
  retracts its ledger row and never launches, but its `spec.json` has already overwritten the
  winner's, so the winner's detached child runs the loser's branches under the winner's ledger row.
  Narrow (the window is `prepareBatch` to `saveTask`) but it is the same invariant.
- **Fix**: have `cmdPacket` call `markHandled` when it can identify the trigger index (or, simpler
  and sufficient, key `serve.state.json` off the packet file it wrote rather than off the trigger
  index, so any packet on disk marks its trigger answered). For the concurrent variant, create
  `compares/<n>` with an exclusive `mkdirSync` (no `recursive`) and retry the id on `EEXIST` — the
  same technique `snapshotCheckpoint` already uses.

---

## Minor

- **M1. The acceptance-immutability scan refuses honest text.**
  `lib/manage/instructions.mjs:612` refuses any instruction whose rendered args match `/acceptance/i`.
  A `correct` message reading "the acceptance criteria say the oracle must be 70/70 — you are at
  68" is refused as an attempt to edit acceptance. `escalate` is exempt; `correct` is not. Narrow
  the scan to the args keys that could plausibly carry a criteria edit, or exempt `correct.message`
  as `escalate` is exempted.
- **M2. `packet.mjs`'s bounding ladder cannot drop `history.settledFindings`.**
  `lib/manage/packet.mjs:273-290` drops the tail, the chain and worker summaries, in that order.
  `task` is verbatim by design (§2) and `readFindings` is unsliced, so a long-lived task that has
  accumulated candidate findings grows every packet with nothing left to drop. This is the concrete
  mechanism behind the Task 1 deferred minor; add findings as a fourth rung (oldest first, or
  `verified` only).
- **M3. The whole-packet redact pass is a `JSON.parse` with no guard.**
  `lib/manage/packet.mjs:299` is `JSON.parse(redact(JSON.stringify(packet)))`. I read `redact`
  (`lib/jev.mjs:253-264`): every replacement is a bracketed literal or a `$1` that reproduces the
  captured prefix verbatim, so none can emit an unescaped quote or backslash and I found no input
  that breaks the round trip. It is still an unguarded parse in the one code path a paused
  orchestrator is waiting on: a throw here is a full-deadline stall. Wrap it and refuse the packet
  loudly rather than letting it surface as a thrown handler.
- **M4. `registerRunForTrigger` can throw `StaleVersion` out of `cmdPacket`.**
  `lib/manage/instructions.mjs:149` saves with `expectedVersion` and does not catch. Inside `serve`
  the throw is caught and the trigger is skipped (defined degradation); at the terminal,
  `tools/manage.mjs packet` exits 1 with a stack and no packet. Catch and retry once.
- **M5. `checkPlaythrough` resolves its script against `ROOT` with no containment check.**
  `lib/manage/evidence.mjs:357`: `playthrough:../../anything.js` runs. Criteria are human-written
  and hashed, so this is not reachable by a manager or an agent, but it is the one evidence kind
  with no path guard while the other three have one.
- **M6. Docs drift.** `docs/manage/manager-system.md` says a `run:` capture "takes `firstAction` and
  `message` and no config" — `configRefusal` (`instructions.mjs:296`) accepts `approach.config` and
  falls back to the packet's `run.config`, and refuses when neither exists. The same file's
  `pendingBatches` bullet says a restore or compare "is refused while one is pending" without
  mentioning the `parallel: true` bypass (see I3). `ARBITER_WS_SOURCE` is documented in
  `supervisor.mjs` and in the spec but not in `docs/batch/manage-1.md`'s env-var paragraph, which
  covers `MANAGE_DECISION_TIMEOUT_MS`, `MANAGE_DRIVER_TIMEOUT_MS` and `ARBITER_DOTENV`.
  `manage-1.md`'s "what was built" table marks Tasks 1-4 "merged", which is true of this branch and
  not of master.

---

## Cross-task seams checked

| seam | what I verified, and how |
|---|---|
| **Supervisor trigger → serve loop** | `manageTrigger` writes `jevEvent("manage:trigger", { kind, pauses, packetRequest: { runId, detail, taskDir } })`; `handleTrigger` reads `event.data.kind` and `event.data.packetRequest.detail`, and `runTriggersName` reads `packetRequest.taskDir`. Field names and nesting match exactly. Every kind `decideTrigger` can return is in `LIVE_TRIGGERS ∪ ENDED_TRIGGERS`; no kind falls through `registerRunForTrigger` unhandled. Read both sides. |
| **Executor → supervisor control file** | `controlAppend` writes `{type: "grant"\|"correct"\|"decision"}`; `pause.onControl` handles exactly those three and logs anything else. Ordering verified: `executeInstruction` writes grant/correct inside the verb branch and the trailing `decision` last, unconditionally, for every verb — so a batch read by `pumpControl` always carries the correction before the release. |
| **Pause release payload arity** | Two producers: `deliverVerdict(correction)` (1 arg) in `runOracle` and `ackEscalation(correction, defaulted)` (2 args) in the `escalate` mail case. `applyPauseActions` calls `d.payload(correction, d.defaulted)`; the 1-arg form ignores the second, correctly. |
| **Packet assembly ↔ a live run** | `liveSummary` covers the no-`summary.json` case, marks `tokens: null` and lists `partial`. `liveConfig` reads the `type: "config"` audit line — and `supervisor.mjs` now logs exactly that line, bare path, unconditionally at startup. Producer and consumer verified against each other. |
| **task.json single writer** | Grepped every write path. `saveTask` is the only function that renames onto `task.json`, and its only callers are in `lib/manage/instructions.mjs` (the executor) plus `createTask`. The supervisor writes `checkpoints/cand-<runId>/` and never task state; the batch child writes `compares/<n>/done.json` and outcome rows only. Confirmed by reading `runBatchSpec` and `markBatchDone`. |
| **stateVersion compare-and-swap** | Every executor save passes `expectedVersion`; `saveTask` throws `StaleVersion` and leaves the file untouched. The loser's already-written ledger row is retracted by a `reversed` row, and `findByKey`, `executedFor`, `assemblePacket`'s history tail and `checkReview` all subtract `reversedSeqs`. Four readers, all consistent. |
| **Acceptance immutability** | `saveTask` checks self-consistency **and** equality with the persisted hash on every write, so no path — `accept`, `escalate`, `continue`, a batch fold — can weaken criteria. The `/acceptance/i` args scan is a second, cruder layer (see M1). No bypass found. |
| **Checkpoint → restore → evidence** | `snapshotCheckpoint` hashes the copy before writing the manifest, so `treeHash(ckDir)` equals `workspaceHash(fromDir)`; `checkOracle` re-derives the hash from `finalWorkspaceOf` and compares to `manifest.treeHash`. The supervisor cuts the candidate from the mount-filtered archive (`runs/<id>/ws-builder`), which is what `finalWorkspaceOf` looks at first. The three agree. `CHECKPOINT_OWN` is excluded identically in the restore copy, the playthrough copy and the snapshot refusal. |
| **Restore config ↔ checkpoint task** | A `ck-` restore requires `approach.config`, requires `manage.enabled` in it (or `ARBITER_WS_SOURCE` is ignored and the run silently starts from the seed), and refuses a config whose `task` differs from the manifest's. All three checks read; all three are in `ARGS.restore.check`. |
| **Two deadlines** | `supervisorDeadlineMs` and the supervisor's `MANAGE` block read the same `MANAGE_DECISION_TIMEOUT_MS` with the same fallback of 120 000; `driverTimeoutMs` is 0.75 of it. Verified both sides read the same variable. |
| **Idempotency across processes** | `findByKey` is consulted before anything else in `validateInstruction`, matches executed and non-retracted rows only. Holds for a retry of one key. Does **not** hold across two packets for one trigger — see I6. |
| **Budget ledger/state coupling** | A batching verb spends and records its pending entry in one `saveTask`; the drop rows are appended after the save. Verified the ordering comment matches the code. The `used` semantics are the problem, not the atomicity — see I5. |

## Failure modes across processes

| failure | recovery | tested? |
|---|---|---|
| Supervisor killed mid-pause | Defined. `settledRuns` ends the entry on `summary.json`, on an absent run directory, or after `staleRunMs` of audit silence; the executor folds it out on its next save with a `run_stale`/`run_ended` row. | Behaviourally tested in `test/manage-instructions.test.mjs` against fixture directories. The supervisor half is untested. |
| Batch child crashes | Defined. The `finally` in `runBatchSpec` writes `done.json` on every exit path including a throw, and the `catch` records an outcome row first. A child killed outright writes neither, and the entry ages out at `max(staleBatchMs, 2 × expectedMs)`. | Tested. |
| Executor crashes between its ledger row and its `task.json` save | **Partially defined, and this is the weakest of the four.** The row says `verified: true`; nothing retracts it (retraction only happens on a caught `StaleVersion`). For a batching verb the row is down, `compares/<n>/spec.json` exists, the budget is *not* charged and the batch never launched. A retry with the same key is refused as a duplicate of something that did not happen, and the manager has no way to reissue. No reconciliation pass exists. | Not tested. |
| Two executors racing | Defined for the save (compare-and-swap, retraction, refusal) and **not** for `compares/<n>` — see I6's secondary variant. | The save race is tested via the injected `save`. The directory race is not. |
| Serve loop restarted | Defined. `serve.state.json` is durable and the marker is the packet, written before the manager is asked, so a crash skips rather than re-answers. `serve.lock` is claimed by rename, not deleted, so two loops cannot both believe they hold it. | Tested (`test/manage-manager.test.mjs`). The hand-run gap is I6. |
| Driver dies with the supervisor's stdout piped to it | Defined and fixed on this branch: both standard streams swallow `EPIPE` after the audit line is written. This was the cause of the first live check's death. | Source-text assertion only. |

## Untested invariants

Leading with what is verified rather than asserted: **every management test in
`test/supervisor-guards.test.mjs` greps `supervisor.mjs` as text** (the file's helper at line 12
reads the source and the tests assert on substrings). No test executes supervisor-side manage
code. So the following are pinned by source shape alone:

1. The pause → control file → release round trip end to end (each half is unit-tested in
   isolation; the join is not).
2. The held-claim rule in `handleApproval` — that a `done` re-sent during a pause consumes no
   attempt and runs no oracle.
3. The finish-time checkpoint candidate: that it is cut from the archive, carries the task, and
   that a run whose task directory moved still exits cleanly.
4. The `ARBITER_WS_SOURCE` restore path, including the symlink refusal and the `CHECKPOINT_OWN`
   filter.
5. The `EPIPE` guard.
6. `manageBudgetCheck` firing once per run, and its interaction with the cap tests.
7. `ARBITER_FORK_CONTROL` being copied into the restored run before the resuming `continue`.

**Real behavioural evidence exists for part of this.** Live attempt 2 (runs `2026-09-18T05-36-41`
and `05-51-13`) exercised trigger → live packet → pause → held silent turn → default at +120 s →
release with the held verdict, and `milestone_candidate` fired. That covers items 1 and part of 2
for the *defaulted* path. **Attempt 3 — the correct/decision path, where an executor writes a real
decision into `control.jsonl` and the pause releases on it rather than on the clock — never ran.**
So the executor-to-supervisor direction of the control channel has no live evidence at all, only
unit tests on each side of it.

Also untested, independent of the supervisor:

8. Executor crash between the ledger row and the save (no test, no recovery path).
9. The `compares/<n>` id race (I6's secondary variant).
10. That `INSTRUCT_TOOL`'s documented arg grammar parses — this is what let C1 through.
11. That `redact` round-trips any packet through `JSON.parse` (M3).

## Deferred minors already in the ledger

| ledger item | still accurate? | evidence |
|---|---|---|
| Solo-pattern claim guard (`solo_done` / `maybeQuiescentOracle` reach `runOracle` outside the claim guard) | **Yes.** The pause guard is at the top of `handleApproval` only; `case "solo_done": runOracle()` and `maybeQuiescentOracle` call `runOracle` directly with no pause check. Unreachable under the orchestrator pattern, as the ledger says; a `manage` block on a solo config would need the guard moved into `runOracle`. |
| `taskDir` guard nit (hoist onto the `readManifest` line) | **Yes**, and now strictly cosmetic. `instructions.mjs:416` calls `readManifest(taskDir, cp.id)` before the `taskDir &&` guard on the next line, so a null `taskDir` throws in `path.join`. Since round 1 that throw is caught by `validateInstruction`'s try/catch and becomes a clean `precondition` refusal, and `executeInstruction` always passes a `taskDir`, so it is unreachable in practice. |
| `compareFirstRequest` cwd-line normalisation | **Yes.** `tools/fork.mjs:135-140` still compares payloads verbatim with no normalisation of pi's "Current working directory:" line. A fork run from another root still reports a state mismatch. |
| Restored runs not continuable | **Yes**, and correctly documented rather than hidden — `runsFromPendingBatches` explains why (`runOnce` awaits the exit, so the id exists only post-mortem) and `ARGS.continue.check` refuses it as not live. The manager's remedy is a second restore. |
| Pid recycling on the serve lock | **Yes.** `acquireServeLock` writes `{ pid, startedAt }`; `pidAlive` reads only the pid. A recycled pid makes a dead loop's lock look alive, and the second loop exits 3 rather than taking over. `startedAt` is written and never read. |
| Task 1: ladder can return an oversized packet | **Yes**, with a concrete mechanism now — see M2. `history.settledFindings` is unsliced and is not a rung on the ladder. |
| Task 1: two concurrent `assemblePacket` calls can compute the same id | **Yes**, and the `wx` flag in `writePacket` still makes it fail loudly rather than overwrite. Unchanged. |
| Task 2: a legacy task's packet blob carries a normalised budget key the file lacks | **Yes.** `loadTask` normalises on read and `assemblePacket` embeds `task` verbatim from that normalised object, so the packet shows `toolCalls` where `task.json` has none. Harmless; still true. |

## Suggested merge order for the fixes

C1 alone makes the branch's headline feature work and is one character in two files plus a test.
I1, I3 and I4 are the three that together decide whether a live manager can actually steer a
paused run; they are small and they belong in one round. I2 is a one-line call to a function that
already exists. I5 is the one that needs a judgement call about what `used` should mean, and is
the only finding here I would accept being deferred with a rename instead of a fix. I6 is the
invariant the spec names verbatim and should not be deferred.

---

# Re-review — fix wave

- **Range**: `2c4294d..1a8a118`, **9 commits**, 15 files, +786/−65.
- **Suite**: `npm test` run once — **756 pass, 0 fail, 0 skipped**, exit 0, 2.54 s. Matches the
  reported count; 18 new tests over the 738 of round 1.
- **Hygiene**: the wave touches no path under `memory/`, `runs/`, `tasks-live/` or `.env`. No
  network call made during this review; nothing touched `127.0.0.1:8080`.

## Updated verdict

**Mergeable after two one-line fixes (N1, N2).** Every one of the thirteen findings from round 1
is addressed, and addressed in the way the rulings asked rather than in the cheapest way that
would make a test green — the C1 test genuinely extracts checkpoint forms from both documents
with a regex and parses each one, so it would have failed on the `@` form it was written to
catch, which is the difference between a test and a restatement. The ninth commit is the wave
reviewing itself and finding two real holes it had just made, including the I3 / `parallel`
contradiction that was C1's own defect repeating inside C1's own round; catching that unprompted
is the single best thing in this wave. What remains are two narrow gaps the wave opened, both in
the new code and both one line: the I6 packet scan ignores every packet written before this wave,
so the fix's own premise — that a packet on disk is the shared record — is not true of the three
packets sitting in the live worktree right now; and the I5 once-only guard latches on "cost
unknown", so a poll landing in the window between the ended trigger and the summary write
forfeits that run's charge permanently. Neither is a safety break and neither needs a design
decision.

## Findings from round 1

| finding | commit | status | evidence |
|---|---|---|---|
| **C1** checkpoint grammar | `4945531` | **ADDRESSED** | `lib/manage/manager.mjs:111-112` now says `run:<runId>#<call>` in both the `restore` and `compare` lines; the `manager-system.md` restore/compare rows likewise. The test (`test/manage-manager.test.mjs:125-142`) extracts forms with a regex from `INSTRUCT_TOOL.description` **and** `systemPrompt()`, substitutes the placeholders and asserts `parseCheckpoint` accepts each and returns the right kind. Verified it would have failed on the old text. |
| **I1** paused task | `4b69278` | **ADDRESSED** | `lib/manage/instructions.mjs:707-715` refuses every verb but `escalate` when `task.status` is set and not `"active"`, coded `task_paused` / `task_complete`, naming open blockers. `serve`'s per-tick `taskStatus` guard in `lib/manage/manager.mjs` returns `refused: "task_<status>"`. A legacy task with no `status` is unaffected (`task.status &&`). Both sides tested. |
| **I2** symlink containment | `7535594` | **ADDRESSED** | `lib/manage/checkpoint.mjs:78-86` calls `findSymlinks(fromDir)` and throws before anything is created. I checked the two things that could have gone wrong and neither does: `snapshotCheckpoint` has exactly one production caller (`supervisor.mjs:2239`), so `accept`'s evidence path and `tools/manage.mjs checkpoint` are untouched; and the archive the candidate is cut from is written with `archiveFilter(MOUNTS)` (`supervisor.mjs:2215`, `lib/mounts.mjs:41-47`), which drops the mount junctions — so a mounted run does not now lose its candidate to its own mounts. The throw was already caught; the log moved from `warn` to `manage`. |
| **I3** verbsAllowed | `e022770` + `1a8a118` | **ADDRESSED** | `lib/manage/packet.mjs:158-161`: `defaultVerbs` drops both verbs when `pendingRuns` or `pendingBatches` is non-empty. The reconciliation is right and I verified its premise independently: `validateInstruction` checks `verbsAllowed` at line 717, before any arg is read, and no caller on this branch passes an explicit `verbsAllowed`, so a pruned `restore` carrying `parallel: true` is refused `verb_not_allowed` regardless. Documenting the flag as a manager opt-in would have been C1 again. |
| **I4** fresh packet | `ca49164` | **ADDRESSED** | `handleTrigger` now loops, re-assembling and re-deciding once on `stale_version` only, inside `deadline - Date.now()`. I checked the loop question: on the retry `registerRunForTrigger` is a no-op in both directions (a live trigger takes `live && !folds → return null`; an ended trigger takes `charged → consumed null → !folds && !spending → return null`), so the version does not move and the retry cannot feed itself. `attempt >= 1` bounds it at two decides regardless. |
| **I5** budget consumption | `4dfef7f` + `1a8a118` | **ADDRESSED**, see N2 | `lib/manage/instructions.mjs:203-220`. The ninth commit's correction is the right one and the implementer's account of the original bug is accurate — the first version charged behind the fold, and `folds` is false for exactly the ordinary-run case. `runConsumption` sums `summary.toolCalls`, which `lib/transcript.mjs:25` does write as a per-agent object. The once-only guard is the ledger row, not the fold, so `settledRuns` cannot double-charge (it writes no `charged` key). Charged twice: no. Charged never: see N2. |
| **I6** one answer per trigger | `2795904` | **(a) PARTIAL, (b) ADDRESSED** | (b) `claimCompareDir` (`instructions.mjs:799-812`) creates `compares/<n>` with a non-recursive `mkdirSync` and walks the id forward on `EEXIST`; `prepareBatch` uses it. Correct and tested. (a) The mechanism is right — every packet carries `trigger.index`, `serve` reads `packets/` before answering — but it recognises only packets that have the field. See N1. |
| **M1** acceptance scan | `eb42926` | **ADDRESSED** | `instructions.mjs:743-744`: `correct` is scanned with `message: undefined`, which `JSON.stringify` drops. Every other arg of a `correct`, and every arg of every other verb, is still scanned. |
| **M2** findings rung | `eb42926` | **ADDRESSED** | `packet.mjs:323-333`: candidates dropped first, then the whole list — the right order, since §5 makes `verified` the ones a decision may rely on. |
| **M3** guarded redact | `eb42926` | **ADDRESSED** | `packet.mjs:345-357`: the parse is wrapped and the failure is a named error; the unredacted packet is never returned. |
| **M4** cmdPacket retry | `eb42926` | **ADDRESSED** (untested, as the report says) | `tools/manage.mjs:107-121`, one retry on `StaleVersion`. |
| **M5** playthrough containment | `eb42926` | **ADDRESSED** | `evidence.mjs:193-202`, relative criteria only. |
| **M6** doc drift | `eb42926` + `1a8a118` | **ADDRESSED** | All four: the `run:` config sentence, the pending-batches paragraph, `ARBITER_WS_SOURCE` in `manage-1.md`, and the "merged" column now reading "on this branch" with a line saying none is on master. |

## New — Important

### N1. `answeredTriggers` ignores packets written before this wave, so they mark nothing

- **Claim**: `answeredTriggers` requires `Number.isInteger(t.index)`. Every packet on disk today
  predates the field, so the loop treats its trigger as unanswered — which is the I6 scenario the
  commit was written to close.
- **Where**: `lib/manage/manager.mjs`, `answeredTriggers` (the `Number.isInteger(t.index)` filter)
  and `serve`'s `already.find(...)` skip.
- **Input → wrong outcome**: verified on disk rather than reasoned about.
  `.worktrees/mgmt-live/tasks-live/pathnorm-night/` holds `packets/1.json`, `2.json` and `3.json`,
  each with a `trigger` carrying `kind`, `runId` and `detail` and **no `index`**, and that
  directory has **no `serve.state.json`** — so both records the loop consults are empty. Point
  `serve` at it and it walks each run's lifecycle from index 0 and re-answers. On this particular
  directory the blast radius is small and I want to be accurate about that: packets 1 and 2 are
  `oracle_failed_repeatedly` on runs that are long dead, so a re-answer produces refusal rows
  rather than a double launch, and packet 3's `milestone_candidate` was hand-authored with a
  `note` detail and may have no matching lifecycle event at all. The defect is that the fix's
  premise — "the packets themselves are the shared record, written by both paths" — holds only
  for packets written from now on, which is not what a durability fix should mean.
- **Fix**: in `answeredTriggers`, when `index` is absent, recompute it with the rule
  `triggerIndexOf` already uses — the last event of that `kind` in that run's `lifecycle.jsonl`.
  That is the same inference `cmdPacket` relies on, applied on read instead of on write, and it
  makes every existing packet mark its trigger correctly.

### N2. The once-only charge guard latches on "cost unknown", and the ended trigger fires before the summary is written

- **Claim**: `alreadyCharged` matches any non-retracted `run_ended` row with a `charged` key, and
  `endedRow` writes `charged: null` when there is no summary. So the "unknown" answer is recorded
  as final and no later trigger will charge that run.
- **Where**: `lib/manage/instructions.mjs`, `alreadyCharged` (`"charged" in r`) and `endedRow`'s
  null branch. The timing is `supervisor.mjs:2060` — `manageTrigger(t0.kind, …)` — against
  `finished = true` at :2066 and the `buildSummary` / `summary.json` write that follows it.
  `milestone_candidate` is emitted earlier still, in `runOracle`, before `finish()` is entered at
  all.
- **Input → wrong outcome**: every ended trigger reaches `lifecycle.jsonl` before `summary.json`
  exists. `serve` polls every 2 000 ms; a poll landing in that window calls `runConsumption`, gets
  `null`, writes `{ charged: null, note: "…unknown and were not charged" }`, and latches. For a
  run whose oracle passed, `milestone_candidate` is the **only** ended trigger — `finish()`
  suppresses `run_ended_without_acceptance` when `milestoneCandidateFired` — so that run's wall
  seconds and tool calls are never charged, silently, and I5's whole point is lost for it. The
  window is short (milliseconds to a few seconds), so this is occasional rather than routine, but
  it under-accounts in the direction that lets a task overrun, and it compounds.
- **Fix**: make the latch mean what it says — `alreadyCharged` should require
  `r.charged !== null`, so an "unknown" row records the attempt without closing the question and a
  later ended trigger (or a reconciliation pass) can still charge it. The note row is then exactly
  what the implementer intended: a statement that the cost was not known *at that moment*.

## New — Minor

- **N3. The I4 retry has no minimum-attempt floor.** `decide` has `MIN_ATTEMPT_MS` (250 ms) before
  it will spend budget on an HTTP retry; `handleTrigger`'s packet retry only checks
  `remaining <= 0`. A stale refusal arriving with 5 ms left re-assembles a packet, calls `decide`
  with a 5 ms budget, gets a guaranteed default and burns the one retry. Apply the same floor.
- **N4. Nothing resumes a paused task.** The `task_paused` refusal says "until a human resumes it"
  and no command does — the human must hand-edit `task.json`, which the spec does contemplate (§3:
  a human edits the file) but the message implies otherwise. Either add
  `tools/manage.mjs resume <taskDir>` or have the refusal name the file to edit.
- **N5. Judgement call 10 confirmed, and it has a second path.** A run folded out by `settledRuns`
  after a killed supervisor is uncharged, as the report says. So is a fork replicate whose
  `comparison_ready` packet the batch child assembles directly — the child never calls
  `registerRunForTrigger`, correctly, so its runs' wall time is charged only if `serve` happens to
  admit them by config and answer their own ended triggers. Worth naming in whichever round takes
  the killed-run case.

## Judgement calls assessed

1. **Log under `manage`, not `warn`** — agree. No candidate to promote is a management fact.
2. **I5 clamps instead of throwing** — agree, and the reasoning is exactly right: `spendBudget`
   throws for a *request*, and a measurement is not one. Verified the clamp cannot itself throw
   (`Math.min(v, max(0, room))` makes `used + amount === total` at worst, and `spendBudget`'s
   guard is `>`). The overrun is named in the row.
3. **`usd` uncharged** — agree; outside the ruling and documented in `manage-1.md`.
4. **"No summary" is not zero** — agree with the principle. It is the interaction with the latch
   that is wrong, not the distinction (N2).
5. **I4 retries `stale_version` only, once** — agree. Every other refusal repeats by construction.
6. **M5 relative criteria only** — agree. The finding named the climb; an absolute path written out
   in full is a choice, and refusing it would have been wider than the finding.
7. **M1 exempts `correct.args.message` and nothing else** — agree, and verified that a sibling
   `args.acceptance` on a `correct` is still refused.
8. **Index on every packet, `null` for `comparison_ready`** — agree, and it is the safe direction:
   a packet with no index marks nothing rather than marking the wrong thing. It is also why N1 is a
   read-side fix and not a write-side one.
9. **`serve` reports `refused: "task_paused"` and exits 3** — agree; consistent with the held-lock
   path, and `cmdServe` now exits 3 on any `refused`.
10. **Killed runs uncharged** — accurate; see N5.

## Untested invariants — updated

Round 1's list stands with these changes. **Removed** (now behaviourally tested): the packet
bounding ladder's findings rung, the redact round trip, the `compares/<n>` race, the paused-task
refusal on both sides, `INSTRUCT_TOOL`'s grammar against the parser, and the consumption charge in
its four cases. **Still true**: every MANAGE assertion in `test/supervisor-guards.test.mjs` greps
`supervisor.mjs` as text, so the pause-to-control-to-release round trip, the held-claim rule, the
finish-time candidate, `ARBITER_WS_SOURCE` and the EPIPE guard remain pinned by source shape only;
the executor crash between the ledger row and the save still has no reconciliation pass and no
test; M4's `cmdPacket` retry has no test; the `serve` signal handlers have none. Live attempt 3 —
the correct/decision path through `control.jsonl` — still has not run, so the
executor-to-supervisor direction of the control channel still has no live evidence. **New and
untested**: N1's pre-wave packet case and N2's trigger-before-summary window, neither of which any
current test reaches.
