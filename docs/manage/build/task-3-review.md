# Task 3 review — `restore` and `compare` over the fork runner

Reviewer: review-manage-task3. Range `04074e0..024933f` (config commit `3733abf` and docs commit `9aa65a9` ignored). Read-only; `npm test` re-run.

**Spec compliance: ❌** — two §3/§1 requirements are unimplemented (findings 4 and 5).
**Code quality: needs fixes** — findings 1 and 2 block. Both silently corrupt the record the next manager reads.

`npm test`: **590 pass, 0 fail**, matching the report. No test spawns a supervisor or a batch child: `launchBatch` is injected in every executor test (`test/manage-instructions.test.mjs:313,347,375,408,418,440`) and the fork runner is injected in every batch-child test (`test/manage-compare.test.mjs:182`). The `runBatch` tests all stop at a refusal before the first replicate.

## What is right

The brief's checklist items 1, 2, 5, 6 and 8 hold.

- **Validation (item 1).** All five refusals are present and pinned: 1 branch and `replicates: 1` are `precondition` (`lib/manage/instructions.mjs:158-159`), a short budget is `budget` (`:216-221`), a missing request file is `precondition` (`:58-64`, pinned at `test/manage-instructions.test.mjs:393`), and a `ck-` checkpoint is `precondition` with "checkpoint restore not yet available" (`:60`). The gate order (shape → key → version → verb → budget → per-verb) is unchanged and documented.
- **Execution order (item 2).** The ledger row is appended at `lib/manage/instructions.mjs:404` before `launchBatch` at `:424`. The spend is one `saveTask` carrying both `runs` and `forkReplicates` (`:419`). The launcher is a parameter with a detached default.
- **Supervisor (item 5).** The `ARBITER_FORK_CONTROL` copy sits inside `if (FORK)` at `supervisor.mjs:2149-2161`, after `RUN` is created at `:163` and before the `fork-continue` send. `JsonlTailer` starts at offset 0 (`lib/child-transcripts.mjs:18`), so the copied entries are read in full on the first pump. A non-fork run cannot reach the variable, and the source assertion at `test/supervisor-guards.test.mjs:84` pins that it appears nowhere else.
- **`runBatch` refactor (item 6).** `main` parses argv and calls `runBatch`; `planForks` receives the identical spec, pinned by source assertion at `test/fork-runner.test.mjs:74`. Exit codes are preserved through `ForkBatchError.exitCode`.
- **`findingsFromCompare` (item 4).** Claim carries both fractions and both wall means; `shape` keys on the recorded tool, not the class; both settle directions are pinned (`test/manage-compare.test.mjs:92-105`), as is append-when-empty and skip-when-settled.
- **Hygiene (item 8).** All blobs are LF in the index (the CRLF in the working tree is `core.autocrlf`). No `memory/`, `runs/`, `tasks-live/` or `.env` in the range. Trailers present and well formed. The rulings listed in the brief are all honoured; none is contradicted.

## Findings, ranked

### 1. A collision-abandoned batch still produces findings, and can verify one (blocker)

`tools/manage.mjs:139-148` ignores `runBatch`'s `abandoned` return. `tools/fork.mjs:459-468` stops a branch on the collision preflight after pushing one crashed row, and the comment there says every later replicate would fail the same way — which includes every replicate of every later branch, since a fork reuses the source run's out-of-tree paths.

Input: a `compare` of G and A at 3 replicates each, run while `runs/.ws-<srcRun>` is held by a stale process.
Outcome: each branch contributes one crashed row. `compareReady` computes `firstTry 0/1` for both, `directionOf` returns `same`, and if a candidate of that shape exists, `settleOrAppend` returns `verified` — a finding marked settled against six replicates of which none ran. §5 makes settled findings the basis for promoting a decision to a harness rule.

Minimal fix: in `runBatchSpec`, break on `out.abandoned` and record the outcome as failed without calling `compareReady`. Separately, have `compareReady` skip a finding whose forced or control branch has `crashed === n` or `n < spec.replicates`.

### 2. A restored run joins `activeRuns` only after it is dead, and is never removed (blocker)

`tools/manage.mjs:150-158`. `runOnce` (`tools/fork.mjs:368`) awaits the supervisor's exit, so the batch child learns the new run id only once the run has finished. It then adds that id to `current.activeRuns`, and nothing anywhere removes it — `activeRuns` is written in exactly one place in the whole codebase.

The report's concern 2 describes the window before that write and calls it correct. The window after it is the worse half. Input: a `restore` executes, ten minutes later the run exits, the child writes `activeRuns: ["run-3"]`; the manager then issues `continue` with `runId: "run-3"`. Outcome: validation passes (`lib/manage/instructions.mjs:131`), the grant is charged, `controlAppend` writes into `runs/run-3/control.jsonl`, no process is tailing it, and the ledger records `verified: true`. A budget grant vanishes with a success row against it.

The brief's "Adds the new run to `current.activeRuns`" cannot be satisfied by this mechanism at all: with `runOnce` awaiting exit there is no moment at which the id is both known and live. The code as written satisfies neither reading. `test/manage-compare.test.mjs:222` pins the wrong behaviour.

Minimal fix: drop the `activeRuns` write for `restore` and let the outcome row be the manager's handle on the new run. Publishing the id mid-flight needs `runOnce` to poll for the new run directory while the child is alive and to clear the entry on exit; that is a follow-on, not a one-liner.

### 3. `run-batch` re-entry re-spawns a finished batch before the guard fires

`tools/manage.mjs:132-175` checks nothing before the branch loop. `compareReady`'s `ready.json` guard (`:194-198`) is at the wrong end of the function. Running `node tools/manage.mjs run-batch <taskDir> <compares/1/spec.json>` a second time re-spawns every replicate as real supervisor runs against a budget already charged at execute time, overwrites `report-<label>.md` and `rows.jsonl`, and only then refuses — after which the catch at `:167-174` writes a `failed` outcome row for an instruction that had succeeded.

Minimal fix: test `ready.json` in `dir` at the top of `runBatchSpec` and return the prior result. The same check also answers "can `compare-ready` be invoked twice" affirmatively for the assembler alone: `compareReady` is idempotent-by-refusal today, but the batch around it is not.

### 4. Spec §3's `restore` precondition "no live run on the same milestone" is not implemented

`ARGS.restore.check` (`lib/manage/instructions.mjs:150-160`) checks the approach shape, the checkpoint and the config. It never looks at `task.current.activeRuns`, and `parallel` appears nowhere in the codebase. Input: a live run on `m2` plus a `restore` at a checkpoint; the instruction executes and two supervisors contend for the single model-server slot, which the fork runner's collision preflight then resolves by abandoning the batch (finding 1). Minimal fix: refuse when `task.current.activeRuns.length` and `args.parallel !== true`.

### 5. `current.activeBranches` is dead, so an in-flight batch is invisible

`activeBranches` is initialised at `lib/manage/task-state.mjs:50` and read or written nowhere else. A batch that will run for tens of minutes leaves no mark in `task.json`, so the next packet cannot tell the manager one is in flight, and a second `compare` is stopped only by the budget — the report's own concern 3. Minimal fix: `prepareBatch` writes `{ batchId, kind, branches }` into `current.activeBranches`, `runBatchSpec` clears it in both the success and the failure path, and `compare`/`restore` refuse while one is pending. This is also the cleanest home for finding 2's handle on a restored run.

### 6. Two forced branches in one compare overwrite each other's report and logs

`forkBranchOf` (`lib/manage/instructions.mjs:103`) maps every `firstAction` to `A-natural`. Input: `branches: [{label:"G"}, {label:"A1", firstAction:"spawn"}, {label:"A2", firstAction:"probe"}]`. Both A branches call `runBatch` with `branch: "A-natural"`, so both write `docs/batch/fork-<run>-<call>-A-natural.md` and both write `<logDir>/A-natural-<replicate>.log` in the shared `.batch-fork-<run>-<call>` directory. Only the last survives. This is the invariant the fork-21 comment at `tools/fork.mjs:493-495` exists to protect. Findings are unaffected, because evidence points at the per-label copies `runBatchSpec` writes into the compare directory (`tools/manage.mjs:143`). Minimal fix: thread the manager's `label` into the spec and use it in `reportName` and `logDir`.

### 7. Nits

- **Non-integer `replicates`.** `lib/manage/instructions.mjs:157` accepts `2.5`; the budget is charged `branches × 2.5` while `planForks` produces 2. Require `Number.isInteger`.
- **A `ready.json` refusal is recorded as a batch failure.** `tools/manage.mjs:172` writes `failed: "compare-ready already ran…"` into the outcome. Finding 3's early guard removes the case.
- **`prepareBatch` writes before the ledger row.** `lib/manage/instructions.mjs:389-396` creates `compares/<n>/`, `spec.json` and the control files at `:398-402`, all before the row at `:404`. The stated reason (reserving the id the row names) is sound and nothing outside the task directory moves, so this reads as an acceptable reading of "ledger row before any side effect" rather than a violation. Worth a line in the spec so the next task does not have to re-derive it.
- **A restore's correction is delivered on the first `pumpControl` tick**, whose interval starts at `supervisor.mjs:2354`, after the `fork-continue`. The file is in place before the continue as the brief requires and nothing is lost, but the message reaches the orchestrator up to two seconds after it resumes rather than with it.

## Rulings

None of the brief's pre-made rulings is contradicted by the code. The eight deviations the report lists are all visible in the diff and all argued; deviations 1, 2, 3, 4, 5 and 7 are sound as written. Deviation 8 (the child records its own failure) is right in principle but incomplete: it does not cover the abandoned case, which returns normally rather than throwing (finding 1).

---

# Re-review — fix round 1 (`d73bbc5`)

**Verdict: all seven findings ADDRESSED. One new Important defect (concurrent `task.json` writes, R1 below); no new Critical.** `npm test` re-run: **598 pass, 0 fail**, matching the report.

| finding | status | where |
|---|---|---|
| 1. abandoned batch settles findings (blocker) | **ADDRESSED** | `tools/manage.mjs:169-183`, `lib/manage/compare.mjs:58-75` |
| 2. restored run in `activeRuns` post-mortem (blocker) | **ADDRESSED** | `tools/manage.mjs:182-188`, `lib/manage/instructions.mjs:68-90` |
| 3. `run-batch` re-entry | **ADDRESSED** | `tools/manage.mjs:147-155` |
| 4. §3 live-run precondition | **ADDRESSED**, extended to `compare` (accepted) | `lib/manage/instructions.mjs:92-107, 200, 225` |
| 5. `activeBranches` dead | **ADDRESSED** | `lib/manage/instructions.mjs:429-434, 514`, `tools/manage.mjs:207-218` |
| 6. `runBatch` label | **ADDRESSED** | `tools/fork.mjs:440-441, 504-508` |
| 7. integer `replicates` | **ADDRESSED** | `lib/manage/instructions.mjs:213` |

## The specific checks

**(a) Abandonment and short branches.** `runBatchSpec` breaks out of the branch loop on `out.abandoned` (`tools/manage.mjs:169-178`), writes `{ batchId, failed: "collision", branch, rows }` (`:181`) and returns before `compareReady`. `cmdRunBatch` exits 2 on it (`:225-228`). Pinned at `test/manage-compare.test.mjs:238`: the second branch is never started, no `ready.json`, no finding. `incompleteBranches` (`lib/manage/compare.mjs:70-74`) gates findings at `tools/manage.mjs:256`; the table and the packet still go out, and `short` reaches both the outcome row and `ready.json`. Both directions pinned, a short branch and a full-count branch that crashed every replicate.

One consequence to note rather than a defect: `complete` counts only non-crashed rows, so **a single crashed replicate anywhere in the batch suppresses every finding**. That is stricter than the gate I proposed, and it sits in tension with the report's standing assumption that a finding's denominator counts crashed replicates. `branchStats.n` is now nearly unreachable with a crash in it. If real batches crash a replicate with any regularity, no comparison will ever produce a claim. The looser gate is `rows.length < replicates || crashed === rows.length`. Implementer's call, but worth deciding before the live check rather than after it.

**(b) The `finally`.** `tools/manage.mjs:207-209`. It runs on every path: the `alreadyReady` early return, the abandoned return, both success returns, and the `catch` that re-throws. A `finally` after a re-throwing `catch` still executes, so a `ForkBatchError` from `runBatch` does clear the pending batch. Pinned at `test/manage-compare.test.mjs:283`.

**It does race the executor's write**, and that is the new defect (R1). `clearPendingBatch` is a blind read-modify-write of the whole `task.json`: `loadTask`, filter, `saveTask` (`tools/manage.mjs:211-215`), and `saveTask` has no compare-and-swap. It bumps `stateVersion` from whatever the caller loaded (`lib/manage/task-state.mjs:83`). A child that loaded the task before a concurrent `executeInstruction` saved it writes back a state that discards that instruction's changes. Reachable today:

- With `parallel: true` two batches are in flight. Child 1 loads, child 2 loads, child 1 saves, child 2 saves. Batch 1's entry is resurrected and stays pending forever, blocking every later `restore` and `compare`.
- A `continue` executed while any child is finishing: the executor charges the grant, the child then writes back the task it loaded a moment earlier, and the spend is gone while the ledger says `verified: true`.
- Worse than either, both writers bump from the same base, so **two different task states can carry the same `stateVersion`**. §3's version check is the whole basis for "the manager did not see this state", and a duplicated version silently defeats it.

Minimal fix: give `saveTask` an expected-version argument, re-read and throw on mismatch, and have `clearPendingBatch` retry its filter against the fresh task. A cheaper stopgap is for the child to write its clearance as a marker file in `compares/<n>/` and let the executor fold cleared batches out of `activeBranches` on its next load, so only one process ever writes `task.json`.

**(c) `continue` on a restored run.** Refused as `precondition` with "not live" (`lib/manage/instructions.mjs:171-176`), pinned at `test/manage-instructions.test.mjs:382`, with the outcome row written by `recordOutcome` rather than hand-rolled. The second half of that test pins the forward-looking rule: while the batch is still pending, the same row does make the run live. `runsFromPendingBatches` is honest about being unreachable today and says why in its doc comment. Correct as built.

**(d) The label.** `runBatchSpec` passes `label: b.label` (`tools/manage.mjs:159`); `runBatch` defaults it to `nullMode ? "null" : branch` (`tools/fork.mjs:440`) and uses it for both `reportName` (`:508`) and `logDir` (`:441`). `parseArgs` sets no label, so a hand-run CLI fork keeps the branch as its label and its report name is byte-identical to before. Pinned at `test/fork-runner.test.mjs:435-439`, the default included. The log directory path does change for hand runs, to `.batch-fork-<run>-<call>-<label>`, which the report flags; the stale comment at `tools/fork.mjs:31` still names the old path and should follow.

**(e) Advice on the stale-pending-batch concern (advice only).** The risk is real and asymmetric. The failure mode is a task that refuses every `restore` and `compare` until a human edits `task.json`, which is exactly the state a manager cannot escape from. I would not build a reaper. The minimal rule that matches how the rest of this code reasons:

> `liveWorkRefusal` treats a pending batch as stale when `Date.now() - launchedAt` exceeds a configured `staleBatchMs` (a batch is `branches × replicates` supervisor runs, so a ceiling near four times the run wall cap is generous), and the executor drops stale entries in the same `saveTask` it uses for the new instruction, appending a ledger row `{ kind: "batch_stale", batchId, launchedAt }`.

Three reasons to prefer it over a PID file. It needs no new on-disk state and no new writer, so it does not deepen R1. It is a pure function of `launchedAt`, which `prepareBatch` already records, so it is testable without a clock hack beyond what the fixtures already do. And it fails safe in the only ambiguous case: a batch that really is still running past the ceiling gets a second batch launched beside it, which the collision preflight now abandons *and records* rather than reading out as a comparison, so the outcome is a recorded failure and not a corrupted finding. A PID file adds a third writer, is meaningless after a reboot, and on Windows a recycled pid can report a live process that is not the batch. If more than staleness is wanted later, the honest signal is the batch's own `rows.jsonl` mtime, not a pid.

**(f) New findings.**

- **R1 (Important): concurrent `task.json` writers with no compare-and-swap.** Detailed under (b). This is the first commit with two processes writing `task.json`, so it is newly reachable rather than pre-existing.
- **R2 (Minor): the all-crashed error message now overstates.** `tools/manage.mjs:290-292` still says "findings written" when `short` suppressed them and `candidates` is empty. A one-line wording fix.
- **R3 (Minor): stale comment.** `tools/fork.mjs:31` names `runs/.batch-fork-<runId>-<call>/` for the force files; the directory now carries the label.

Nothing else changed in a way that weakens what round 0 approved. The gate order, the row-before-the-act ordering, the supervisor's control copy and the `runBatch` refactor are all untouched. Hygiene on `d73bbc5` is clean: LF blobs, trailers present, and no `memory/`, `runs/`, `tasks-live/` or `.env`.

---

# Re-review — fix round 2 (`79f3927` only)

**Verdict: R1, the stale rule, the gate, R2 and R3 all ADDRESSED. Two new findings, both Important-adjacent rather than Critical: the executor leaves a `verified: true` ledger row and a burnt idempotency key when its own compare-and-swap loses (R5), and the 2 h stale ceiling is shorter than a legitimate maximal compare (R4).** `npm test`: **620 pass, 0 fail**. Only `79f3927` is reviewed here; `5d6622e` and `2870189` were skipped as instructed.

| item | status | where |
|---|---|---|
| R1 two writers for `task.json` | **ADDRESSED** | `tools/manage.mjs:10, 208-228`, `lib/manage/instructions.mjs:88-118` |
| stale rule | **ADDRESSED** | `lib/manage/task-state.mjs:42-51`, `lib/manage/instructions.mjs:100-118, 556-566` |
| findings gate loosened | **ADDRESSED** | `lib/manage/compare.mjs:58-81` |
| R2 all-crashed message | **ADDRESSED** | `tools/manage.mjs:302` |
| R3 stale force-file comment | **ADDRESSED** | `tools/fork.mjs:28-32` |

## The specific checks

**(a) One writer.** `grep` over `tools/manage.mjs` finds no `saveTask`, no `loadTask` and no `setCurrent`; the import line is gone and replaced by a comment saying why (`:10`). The child's only statement is `markBatchDone` writing `compares/<n>/done.json` with `{ batchId, status, ts }` (`:216-226`), from a `finally` that still covers the `alreadyReady` return, the abandoned return, both success returns and the re-throwing `catch`. The outcome ledger row is unchanged. The executor reads the marker through `settledBatches` (`lib/manage/instructions.mjs:100-114`), appends one `batch_cleared` or `batch_stale` row per drop, and folds the survivors into the same `saveTask` as the spend and the new pending entry (`:562-566`). Pinned on both sides: the child's run leaves `stateVersion` untouched and the entry still listed (`test/manage-compare.test.mjs`, the `done.json` assertions), and a marker left by hand makes the next instruction drop the entry with the ledger note (`test/manage-instructions.test.mjs:141`).

**(b) Compare-and-swap.** `saveTask(dir, task, { expectedVersion })` re-reads the persisted task and throws `StaleVersion` before computing `next`, so nothing is written (`lib/manage/task-state.mjs:100-108`). Omitted, it behaves exactly as before. Pinned at `test/manage-task-state.test.mjs:201`, including that the other writer's change survives on disk and that a no-option save still works. The executor passes `expectedVersion: task.stateVersion` on **all three** of its saves — grant (`:546`), batch (`:565`) and escalate (`:571`) — and `task` there is the object `loadTask` returned at the top of `executeInstruction`, so the version it passes is the version it read. No other caller in `lib/` or `tools/` passes the option, which is correct: `createTask` has nothing to swap against.

**(c) Two executors.** Yes, they can still race, and the loser fails loudly rather than silently — but not cleanly. Two `execute` invocations answering two packets both load version 41 and both pass validation. A saves and the file goes to 42; B's `saveTask` throws `StaleVersion`, writes nothing, and the throw propagates out of `executeInstruction` uncaught (`StaleVersion` appears nowhere in `lib/` or `tools/` outside its definition). `cmdExecute` has no handler, so B exits non-zero with a stack trace. Nothing outside the task directory moves: for a batching verb the throw is before `launchBatch`, for `continue` it is before the `controlAppend` that carries the grant, and the trailing `decision` entry is skipped too.

**That leaves a wrong record, and it is R5.** B appended its ledger row at `:502` before the save, so the ledger says `verified: true, executed: { batchId: 2 }` for an instruction that did not execute. Worse, `findByKey` matches executed rows, so B's honest retry under the same key is refused as a duplicate that "already executed" — the exact failure the key check was written to avoid, now reachable. Minimal fix: wrap the three saves in a `try`, and on `StaleVersion` append a compensating row (`{ kind: "reversed", forSeq: row.seq, reason }`) and return `{ executed: false, code: "stale_version" }`, with `findByKey` ignoring a row that a later `reversed` row names. A smaller stopgap, if the compensating row is too much for this task: have `findByKey` skip rows whose `seq` a `reversed` row names, and leave the reversal to Task 4. The same applies to the `batch_cleared` / `batch_stale` rows appended at `:563` just before the save — on a `StaleVersion` they are written for drops that did not happen, and the next attempt writes them again.

**(d) The gate.** `incompleteBranches` is now `b.rows < replicates || b.crashed === b.rows` over the branch's own rows, returning `{ label, rows, crashed, replicates }` (`lib/manage/compare.mjs:76-81`). Crashed rows stay in `branchStats`' denominators, so the tension the last round named is resolved rather than traded. Pinned in three directions: short by count (`rows: 1, crashed: 0`), full count with every replicate crashed (`rows: 3, crashed: 3`), and one crash out of three still producing its claim with `1/3 vs 1/3` in the text. The console line follows the new shape.

**(e) The two new concerns.**

- **A finished batch stays listed until a later save** — acceptable in the state file, **not** acceptable in the packet. Every reader inside the executor goes through `pendingBatches`, so nothing is refused wrongly, and the entry is a stale record rather than a stale decision. But §2 puts `task.json` in the packet verbatim, and the packet is the manager's only view: it will show a batch in flight that finished, and "is work already running?" is exactly the question `compare` and `restore` turn on. Do not filter `task` — that breaks §2's verbatim promise and §7's replay fidelity. Add the derived list to `options` beside `budgetLeft` (`lib/manage/packet.mjs:223`), which is already the packet's slot for "what the harness worked out". One call site, and it makes the manager's view match the harness's.
- **A long batch past `staleBatchMs` costs the next batch's fork budget** — the trade is right, but **the default number is wrong, and that is R4.** `DEFAULT_STALE_BATCH_MS` is 2 h (`lib/manage/task-state.mjs:46`) while the batch ceiling is `branches × replicates` sequential supervisor runs at the config's own wall cap: `configs/orch-pathnorm-27b-manage.json` caps a run at 1800 s, so a two-branch, three-replicate compare may legitimately run three hours before it is late. The default declares a healthy maximal compare stale mid-flight, and then the fail-safe fires for real: a second batch starts, hits the collision preflight, and its whole `branches × replicates` budget is recorded as a failure. Minimal fix: `prepareBatch` already knows the shape, so give the pending entry an `expectedMs` (`branches.length × replicates × runWallSec × 1000`) and make the ceiling `Math.max(staleBatchMs(task), 2 × expectedMs)`. Failing that, raise the default to 6 h. Either is a one-line change and both are cheaper than the abandoned batch they prevent.

**(f) New findings.**

- **R4 (Important): the stale ceiling is shorter than a legitimate batch.** Detailed under (e). The fail-safe is sound; the constant is not.
- **R5 (Important): a lost compare-and-swap leaves a `verified: true` row and burns the idempotency key.** Detailed under (c). It is the same class of defect R1 was — the ledger asserting something the task does not reflect — one level further in.
- No new Critical. R2 and R3 are closed as described, and nothing round 0 or round 1 approved has regressed: the gate order, the row-before-the-act rule, the supervisor's control copy, the label threading and the `runBatch` refactor are untouched. Hygiene on `79f3927` is clean.

---

# Re-review — fix round 3 (`17e1dbd`)

**Verdict: R5, R4 and `options.pendingBatches` all ADDRESSED. No new Critical or Important defect in the logic. One must-fix before merge that is cosmetic but large: a whole region of `lib/manage/instructions.mjs` was accidentally indented by one extra tab (R6).** Suite: **623 pass, 0 fail** on six consecutive runs; one earlier run failed once at a pre-existing spawn test, see R7.

| item | status | where |
|---|---|---|
| R5 reversed rows on a lost swap | **ADDRESSED** | `lib/manage/ledger.mjs:31-45`, `lib/manage/instructions.mjs:571, 616-624` |
| R5 `batch_cleared` / `batch_stale` after the save | **ADDRESSED** | `lib/manage/instructions.mjs:604-609` |
| R4 `expectedMs` and the derived ceiling | **ADDRESSED** | `lib/manage/instructions.mjs:122-136, 165-173, 493-500` |
| `options.pendingBatches` | **ADDRESSED** | `lib/manage/packet.mjs:12, 249-257` |

## The specific checks

**(a) The racing executor, end to end.** The three saves are inside one `try`; the `catch` re-throws anything that is not a `StaleVersion`, and on a `StaleVersion` calls `reverseRow(taskDir, row.seq, "stale_version")` and returns `{ executed: false, reversed: true, code: "stale_version" }` (`lib/manage/instructions.mjs:616-624`). Nothing outside the task directory moved, and the ordering is what makes that true rather than a claim: each save precedes its own `controlAppend`, `launchBatch` and the trailing `decision` entry, all of which the throw skips. Pinned end to end at `test/manage-instructions.test.mjs:461` with the losing save injected: the refusal code, the untouched control file, the uncharged grant, the original row left unedited, the `reversed` row naming its `seq`, and then the honest retry under the same key executing and charging the grant. That last assertion is the one that matters, and it is there.

One inert leftover, worth a line rather than a change: on the batching path `prepareBatch` has already created `compares/<n>/` with its spec and control files before the row, so a lost swap orphans that directory and the retry takes the next id. Nothing reads it, and the alternative is reserving the id after the row, which was already argued the other way in round 0.

**(b) The `reversed` row cannot be mistaken for an execution**, and is never written for a refusal. A `reversed` row carries no `instruction`, so `findByKey`'s own predicate (`r.instruction?.idempotencyKey === idempotencyKey`) can never match it, quite apart from the `reversed` set it builds (`lib/manage/ledger.mjs:32-38`). The `Number.isFinite(r.forSeq)` guard keeps a malformed row from retracting `seq: undefined`. And the `try` begins only after `v.ok` has been established and the executed row written, so every refusal path returns before it: `reverseRow` has exactly one call site, in that `catch`.

One gap, Minor: `history.recentInstructions` in the packet is the last five ledger rows mapped to `{ packetId, verb, outcome }` (`lib/manage/packet.mjs:214-216`), with no knowledge of retraction. A retracted instruction still appears to the manager as one that happened. A one-line filter using the same reversed set closes it; the ledger itself is correct either way.

**(c) The injected `save`.** The default is the real `saveTask` (`lib/manage/instructions.mjs:534`), and every production caller passes nothing: the only non-test call site in the tree is `tools/manage.mjs:103`, which passes `{ taskDir, instr, packet, runsDir }` and no `save` and no `launchBatch`. So the shipped path is `saveTask` with `expectedVersion` on all three saves. The injection is justified in the doc comment and is the only way to reach the losing branch from one process; I would have asked for it if it were not there.

**(d) The ceiling numbers.** `batchCeiling` is `max(staleBatchMs(task), 2 × expectedMs)` (`:135`), and `prepareBatch` records `expectedMs = branches × replicates × configWallSec × 1000` (`:500`), read from the config's `caps.wallSec` with a `0` fallback that a `catch` also returns for an unreadable config (`:167-173`). Pinned at `test/manage-instructions.test.mjs:496` with exactly the numbers from the finding: a 2×3 compare at 1800 s gives a six-hour ceiling, live at three hours, stale at seven, and a config that caps nothing falls back to the task's two hours. The restore fixture's entry is pinned too, at one branch × one replicate × 60 s (`:389`).

**(e) `pendingBatches` in the packet.** Derived, in `options` beside `budgetLeft`, with `task` untouched (`lib/manage/packet.mjs:257`). Pinned at `test/manage-packet.test.mjs:260` over three entries at once — one in flight, one with a `done.json` marker, one five hours old that nobody closed — asserting `options.pendingBatches` is `[1]` while `task.current.activeBranches` still reads `[1, 2, 3]`. That is exactly the split I asked for, and §7's replay fidelity is preserved.

**(f) New findings.**

- **R6 (Minor by nature, must-fix before merge): a large accidental re-indent.** From roughly `lib/manage/instructions.mjs:444` to the end of `executeInstruction`, every line carries one extra leading tab, so top-level declarations such as `export function executeInstruction` (`:534`) and `function prepareBatch` (`:462`) now sit at depth one. `executeInstruction`'s own doc comment is worse: some lines keep a tab and some have none (`:522-533`). `node --check` passes, so nothing is broken, but the commit reads as 366 changed lines where 86 are substantive, which is what a reviewer has to wade through, and it will conflict line-for-line with Task 4 in the same file. Re-indent the region back and confirm `git show -w` and `git show` agree in size.
- **R7 (Minor, not Task 3's): an observed flake.** My first run of the suite on this commit failed once at `test/manage-instructions.test.mjs:622`, `assert.equal(retry.status, 0)` with `actual: null` — a `spawnSync` that returned no exit code. Six consecutive runs since were clean. The assertion predates this task (`82dfec7`, Task 2) and the test spawns the real CLI, so this is environmental rather than a regression here. Worth passing `retry.stderr` as the assertion message so the next occurrence is diagnosable rather than a bare `null`.
- Nothing from rounds 0 to 2 has regressed. The one-writer rule still holds (`tools/manage.mjs` has no task-state writes), the gate, the label threading, the supervisor's control copy and the `runBatch` refactor are untouched, and hygiene on `17e1dbd` is clean.

With R6 corrected, I have no outstanding objection to this task's code. The open items are the ones the implementer already names: the live check (step 5) has not been run, and a restored run still cannot be continued by design.

## Addendum — the live-packet minor (`26a8dc9`)

**Verdict: the live-packet change is ADDRESSED as written and the tests pass (624, 0 fail), but two things from round 3 are not what the hand-off says. `17e1dbd` was not amended — `26a8dc9` is a child of it (`git rev-parse 26a8dc9^` returns `17e1dbd`), so the R6 re-indent is still in the tree and still needs fixing. And `liveConfig` has no producer today, so `run.config` on a real live run is still null.**

R6 remains: `lib/manage/instructions.mjs:507` and `:579` still carry `function prepareBatch` and `export function executeInstruction` at one tab of indentation. Nothing in `26a8dc9` touches that file.

**The requested check: `partial` on the live fixture — ADDRESSED for the two positive cases, PARTIAL for the negative one.** `test/manage-packet.test.mjs:129` pins `["tokens", "config"]` when neither is available, and `:135` pins `["tokens"]` after a config is placed beside the run. What is *not* pinned anywhere is that `partial` is absent on a finished packet: `grep partial test/manage-packet.test.mjs` returns only those two assertions and a comment. The production path is right — `summary.partial ?? null` at `lib/manage/packet.mjs:236`, and a finished `summary.json` has no such field — but nothing stops a later writer adding one, and "absent on a finished packet" is half the contract the field states. One line in the existing finished-run test closes it: `assert.equal(packet.run.partial, null)`.

**`tokens`.** `null` on a live run, `summary.tokens ?? 0` on a finished one (`:235`), gated on `summary.live` rather than on the presence of the field, which is the right discriminator: `liveSummary` is the only thing that sets `live`. The reasoning in the comment is sound — `0` is a measurement and "not yet on disk" is not — and it is the manager's cost judgement that the distinction protects.

**`liveConfig` is correct but inert (Minor, worth a line in the report rather than a change).** It looks for `runs/<id>/config.json`, `runs/<id>/arbiter.json`, or an audit line of `type: "config"` (`lib/manage/packet.mjs:196-202`). None of the three has a producer: the supervisor writes no config copy into the run directory, and `grep -rn 'type: *"config"'` over `supervisor.mjs`, `lib/` and `tools/` finds nothing. The test creates `config.json` by hand, so it pins the plumbing rather than a path a real run takes. In practice a live packet will always report `config: null` and `partial: ["tokens", "config"]`, and the stated benefit — that `restore` and `compare` get their config from the packet — does not land yet. That is not a defect: the code is right, the field is honest about being unknown, and `configRefusal` already turns the gap into a clear refusal telling the manager to name `approach.config`. It should be stated as pending a producer rather than as working, and the cheapest producer is the supervisor writing its `configPath` into an audit line at startup, which would also make finished runs agree with live ones.

Nothing else in `26a8dc9` changes behaviour: the diff is `packet.mjs`, its test and one docs line.

---

# Re-review — round 3b (`8c28704`) and run staleness (`c4a2fa2`)

**Verdict: every item ADDRESSED, including R6. No new Critical or Important. Two new Minor findings (R8, R9) and one pin worth adding. Task 3 closes on code from my side, with step 5 still outstanding as the implementer says.** Suite at `HEAD` (`8e6cdf5`, one Task 2 commit past `c4a2fa2`): **630 pass, 0 fail**.

| item | status | where |
|---|---|---|
| `registerRunForTrigger` on live/ended triggers | **ADDRESSED** | `lib/manage/instructions.mjs:91-143`, `tools/manage.mjs:79-85` |
| saved with `expectedVersion`, note after the save | **ADDRESSED** | `lib/manage/instructions.mjs:137-141` |
| R6 re-indent | **ADDRESSED** | `git diff -w 26a8dc9..8c28704` on that file is 45 added, 0 removed; no tab-indented top-level declaration remains |
| retraction-aware `recentInstructions` | **ADDRESSED** | `lib/manage/ledger.mjs:38-48`, `lib/manage/packet.mjs:214-222` |
| stderr on the CLI assertion, `partial` null pin | **ADDRESSED** | `test/manage-instructions.test.mjs`, `test/manage-packet.test.mjs` |
| `run_missing` on an unknown run id | **ADDRESSED** | `lib/manage/instructions.mjs:129-135` |
| `pendingRuns` / `settledRuns` and the fold | **ADDRESSED** | `lib/manage/instructions.mjs:191-227, 698-712`, `lib/manage/task-state.mjs:51-57` |

## The specific checks

**(a) Idempotent both ways, and never from the batch child.** `registerRunForTrigger` returns `null` without touching anything when `live === runs.includes(runId)` (`:126`), so a second live trigger for a registered run and an ended trigger for a run that was never registered both no-op. Pinned at `test/manage-instructions.test.mjs:510` on all four axes: the second packet writes no ledger note and bumps no version, `comparison_ready` for a fork run changes nothing, an unknown trigger kind is ignored, and a trigger with no `runId` is not about a run. The batch child never calls it: `compareReady` calls `assemblePacket` directly (`tools/manage.mjs:307`), and the only call site is `cmdPacket`. That is the right seam — `comparison_ready` is in `ENDED_TRIGGERS`, so routing the child through `cmdPacket` would have made the child a task-state writer again.

**(b) The packet carries the registered version.** `registerRunForTrigger` saves, then `assemblePacket` does its own `loadTask` (`lib/manage/packet.mjs:206`), so `packet.task.stateVersion` — the number the manager echoes as `basedOnStateVersion` — is the one the registration produced. The ordering is explicit and commented at `tools/manage.mjs:79-84`. **Pinned only indirectly**: the unit test validates a `correct` against `loadTask` after registering, which proves the rule but not the CLI's ordering. One assertion in a `cmdPacket`-level test (`packet.task.stateVersion === registered.stateVersion`) would pin the line that actually enforces it, and that line is the whole fix.

**(c) The two folds share the pattern and one save.** `settledRuns` / `pendingRuns` mirror `settledBatches` / `pendingBatches` exactly, down to the `{ why }` tag and the `now` parameter (`:191-227`). Both are folded in the single `setCurrent` the batching path already made, with `activeRuns` and `activeBranches` in one object (`:705`), `expectedVersion` on it, and the `run_ended` / `run_stale` / `batch_cleared` / `batch_stale` notes all after the save (`:709-711`). Every validation now reads the derived list rather than the raw one — `continue` (`:331`), `correct` (`:346`), and `liveWorkRefusal` (`:247`) — which is the property that matters, since the record lags by design. The fold still happens only on the batching path, unchanged from round 2 and consistent with the implementer's standing concern 5.

The liveness rule itself is well judged. `summary.json` is written in `finish()`, so its presence is proof; audit silence past 30 minutes is proof of a dead process, because a live run logs continuously; and a run with no audit file yet is explicitly *not* stale, which is the right call for a run seconds old. All three are pinned (`test/manage-instructions.test.mjs`, the `mkRun` fixture with `ended`, `quietForMs` and `audit` toggles).

**(d) The re-indent is gone.** `git diff -w 26a8dc9..8c28704 -- lib/manage/instructions.mjs` is 45 insertions and 0 deletions against 177/132 without `-w`, so the whitespace change is a pure revert and everything else is new code. `grep -c "^\texport function\|^\tfunction "` on the file is now 0.

**(e) New findings — both Minor, neither blocking.**

- **R8: `options.pendingRuns` is missing, the same asymmetry `pendingBatches` was added to fix.** The packet gives the manager `task.current.activeRuns` verbatim (correct, §2) and `options.pendingBatches` derived, but nothing derived for runs. So a packet can show `activeRuns: ["…"]` for a run whose supervisor died, with `continue` in `verbsAllowed` — `defaultVerbs` (`lib/manage/packet.mjs:158-164`) prunes on budget and trigger kind only, never on liveness — and the instruction the manager then sends is refused by `pendingRuns`. That is exactly the harness-disagrees-with-the-manager case round 2 closed for batches. Fix is one term: `pendingRuns: pendingRuns(task, { runsDir })` beside `pendingBatches` at `lib/manage/packet.mjs:264`. `assemblePacket` would need the runs root, which it can derive from `runDir`'s parent.
- **R9: a deleted run directory leaves a permanently live entry.** `settledRuns`' `catch` treats a `statSync` failure as "not evidence the run is over" (`:214-216`), and the comment says so deliberately. But that `catch` covers two different facts: no audit file inside an existing run directory (genuinely inconclusive, a run seconds old) and no run directory at all (conclusive — nothing will ever write there). In the second case the entry never ends, and every later `restore` and `compare` is refused on behalf of it, which is the unescapable state this whole mechanism exists to prevent. `c4a2fa2`'s `run_missing` guard closes the common cause at registration, so this is now reachable only by a directory removed afterwards — housekeeping on `runs/`, which does happen. Fix: check `fs.existsSync(dir)` before the audit stat and return `{ runId, why: "ended" }` when the directory is gone.

Nothing else changed in a way that weakens earlier rounds. The one-writer rule still holds — `tools/manage.mjs` imports neither `loadTask` nor `saveTask`, and `registerRunForTrigger` is called from the CLI, not the child. The gate, the label threading, the supervisor's control copy, the retraction path and the `runBatch` refactor are untouched. Hygiene on both commits is clean.

**Closing position.** With R8 and R9 taken or explicitly deferred, I have no outstanding objection to Task 3's code. The two open items are the implementer's own and both are correctly stated: step 5, the live compare against a real server, has not been run, and a restored run still cannot be continued because its id only exists after it exits.
