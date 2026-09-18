# Task 4 review — checkpoints and evidence-tied acceptance

Reviewed: `17bb6a0` and `d0d45da` on `management` (range `6f67982..d0d45da`, excluding `c96d127` and the two docs commits). Read-only; `npm test` run once.

**Spec compliance: ✅**, with one recorded deviation from a global constraint (finding I-3, ledger row before side effects).
**Code quality: needs fixes** — three Important findings, each a one-line change. Nothing blocks the merge of the acceptance semantics themselves.

`npm test`: `ℹ tests 682 / ℹ pass 682 / ℹ fail 0`. Confirmed, not taken from the report.

---

## Findings

### Critical

None.

### Important

**I-1. A throw inside `checkEvidence` escapes with no refusal and no ledger row.**
`lib/manage/instructions.mjs:557` calls `spec.check(...)` with no try/catch, and `executeInstruction` calls `validateInstruction` at line 687, *before* its own `try {` at 730. So any exception raised while verifying evidence breaks the contract's invariant that a refusal is always a ledger row: no row, no refusal code, a stack trace out of `tools/manage.mjs`.

Three inputs that throw today:

- A truncated `checkpoints/ck-0001/manifest.json` — `readManifest` (`lib/manage/checkpoint.mjs:76`) does a bare `JSON.parse`.
- An `oracle:` criterion whose evidence names a *live* run: `finalWorkspaceOf` falls back to `runs/.ws-<id>/ws-builder`, and `workspaceHash` walks a tree the running agent is mutating. `readFileSync` raises ENOENT between the walk and the read (`lib/tree-hash.mjs:30`).
- A `playthrough:` criterion when the checkpoint directory is read-only — `mkdirSync`/`writeFileSync` at `lib/manage/evidence.mjs:189-193`.

Minimal fix: wrap the `spec.check` call in try/catch and turn a throw into `refuse("precondition", err.message)`.

**I-2. `artifact:` containment is defeated by a symlink.**
`checkArtifact` (`lib/manage/evidence.mjs:120-123`) resolves the path and correctly refuses one that escapes the checkpoint, but `existsSync`, `statSync` and `readFileSync` all follow links. `cpSync` copies symlinks verbatim (`dereference` defaults to false), and `treeHash` counts only `e.isFile()`, so a symlink is invisible to the tree hash and the `oracle:` tie-back is unaffected.

Input → wrong outcome: a builder that cannot produce `docs/a.md` plants `docs/a.md -> /etc/passwd` in the workspace. The candidate carries the link, `artifact:docs/a.md:nonempty` passes, and the milestone is accepted on a file the run never produced. Ranked Important because this repo's own path-guard history treats the builder workspace as adversarial.

Minimal fix: `fs.realpathSync(target)` and re-apply the containment test, or `lstatSync` and refuse a symlink outright.

**I-3. The playthrough script runs before any ledger row exists, and against the checkpoint itself.**
Two halves, same line (`lib/manage/evidence.mjs:185`):

- *Ordering.* Deviation #2 (verify inside `ARGS.accept.check`) is well argued for the refusal shape, but the global constraint is "ledger row before side effects", and a `playthrough:` criterion spawns a child process before anything is written. A ten-minute playthrough killed at minute five leaves a partial evidence log in the checkpoint and nothing anywhere saying an acceptance was attempted. Minimal fix that keeps deviation #2: append a non-instruction `{ kind: "evidence_check", milestone, checkpoint }` row before the criteria loop. It is not an instruction row, so no retraction path is needed.
- *Handle.* The script is handed `ckDir` itself. A playthrough that is not strictly read-only (a build step, a save file, a `node_modules`) rewrites an accepted checkpoint that Task 5 will restore from. Minimal fix: spawn against a temp copy of the checkpoint; leave the log write where it is.

Note for Task 5: restore must exclude `manifest.json` and `evidence/` from what it copies into a workspace. Nothing in Task 4 breaks — the manifest is written *after* the hash is taken, so it was never inside `manifest.treeHash`, and §6 requires the log attached.

### Minor

**M-1. `review:human` has no way to be produced.** It is the one §6 kind a human must write, and there is no `manage.mjs review` subcommand. The only path is hand-appending to an append-only `ledger.jsonl` with the right `seq`, `kind`, `criterion`, `checkpoint`, `by`, `signed` shape; the test does it with `appendLedger` from inside the suite. Compounding: the row must name the exact `ck-` id, so a review signed against `cand-r1` is void after `promoteCandidate` renames it, and the CLI's own list → promote → accept order encourages signing first. Not in the brief's CLI list, so Minor.

**M-2. `promoteCandidate`'s candidate predicate is unanchored.** `isCandidateId = /^cand-.+/` (`lib/manage/checkpoint.mjs:31`) accepts `cand-../../x`, which `checkpointDir` then joins into a traversal and `renameSync` moves. Operator-typed input only — no manager reaches it, and `accept` gates on the fully anchored `/^ck-\d+$/`. Fix: `/^cand-[A-Za-z0-9._-]+$/`.

**M-3. A workspace with a root `manifest.json` or an `evidence/` directory is clobbered by the snapshot.** No guard, no test. Cheap to refuse in `snapshotCheckpoint`.

**M-4. `accept` requires a non-empty `evidence` list even for a milestone whose criteria are all `artifact:` or `review:`,** where run ids are never read (`lib/manage/instructions.mjs:412`). The playthrough test has to pass `evidence: ["r1"]` for a run that does not exist. Harmless, slightly dishonest.

---

## Verified against the brief's eight checks

**(1) `checkEvidence` per kind.**
- `oracle:` — requires a run whose `summary.task` yields the criterion's dir (`oracleDirOfRun`, `lib/manage/evidence.mjs:82`), whose **last** verdict from `audit.jsonl` has `pass === total` **and** `total > 0`, and whose final workspace hashes to the manifest's `treeHash`. Evidence from a different task is blocked by the `summary.task` match, and the refusal says which task the run actually ran. A run whose oracle passed on an earlier workspace cannot arise: a passing oracle calls `finish()` immediately (`supervisor.mjs:1766-1775`), and the capped-run line was deliberately reworded so it cannot match the `Oracle run #N: p/t` regex a second time. `0/0` is correctly not a pass.
- `playthrough:` — injectable `spawn`, `PLAYTHROUGH_TIMEOUT_MS` of 10 minutes, log written whatever the exit code, `r.error` and signal both handled. See I-3 for the two defects.
- `artifact:` — all four validators present and correct, including an invalid `grep=` regex refused rather than thrown. Traversal outside the checkpoint refused on the resolved path. See I-2 for the symlink hole.
- `review:` — requires `signed === true` strictly, a matching `criterion` and `checkpoint`, a non-empty `by`, and subtracts retracted rows via `reversedSeqs`. Anything other than `review:human` refused.

**(2) `accept`.** Refusal names the first failing criterion with its id, its check string and the reason, and later criteria are not evaluated. `task.json` is byte-identical after a refusal (pinned at `test/manage-instructions.test.mjs:854`). Success is exactly one `save` with `expectedVersion`, one version bump, milestone → `accepted` with checkpoint/timestamp/artefacts, next **pending** milestone in the task's own order → `active`, `current` moved, `status: "complete"` when none is left. A `cand-` checkpoint is refused with the promote command; a non-current or non-active milestone is refused by name. `accept` is pruned from `verbsAllowed` everywhere but `milestone_candidate` and `comparison_ready` (`lib/manage/packet.mjs:149`), unchanged from Task 1.

**(3) Immutability.** No path in `accept` writes `acceptance`: the save spreads the loaded task, and `saveTask` re-checks the hash both against the criteria and against the persisted file (`lib/manage/task-state.mjs:109,113`). The rendered-args `acceptance` scan still runs for every non-`escalate` verb.

**(4) Finish-time candidate.** Gated on `MANAGE?.taskDir`, sits at `supervisor.mjs:2186` — after `summary.json` at line 2077 and after the archive block — in its own try/catch that only logs. Writes `cand-<runId>`, never a `ck-` id, never `task.json`; a source assertion pins that the supervisor never mentions `promoteCandidate`. The startup audit line is `log({ type: "config", msg: CONFIG.configPath })` at line 302, which is exactly the shape `liveConfig` reads (`lib/manage/packet.mjs:203`, `line?.msg`). The supervisor writes no `runs/<id>/config.json` or `arbiter.json`, so the audit line is the *only* source `liveConfig` can use for a live run — the commit message's justification holds.

**(5) Tree hash.** The `cpSync` filter and `treeHash(_, SKIP_PI)` agree: regular files only, symlinks in neither, `.pi` subtrees dropped whole by both. The manifest is written after the hash is taken, so it is not in its own digest. Pinned at `test/manage-checkpoint.test.mjs:50`. The candidate being cut from the mount-filtered archive (deviation #1) is what makes the hash equal for a mounted run; that reasoning is correct.

**(6) CLI.** `accept`, `checkpoint promote`, `checkpoint list` all present, all driven end to end by a real subprocess in `test/manage-instructions.test.mjs:951`, including the exit-3 refusal and the duplicate acknowledgement. The synthetic idempotency key omitting the state version (deviation #4) is right for the reason given.

**(7) Test quality.** Behaviour, not presence. All three of the brief's named pins exist: a hash mismatch refused with both hashes in the reason, a passing oracle on the wrong tree refused, and `task.json` byte-identical after a refusal. Also pinned: `0/0` is not a pass, a failing last verdict beats an earlier passing one, a playthrough spawned exactly once per instruction, and an unknown check kind refused rather than ignored.

**(8) Hygiene.** The two commits touch 11 files, all under `lib/`, `test/`, `tools/` and `supervisor.mjs`. Nothing under `memory/`, `runs/`, `tasks-live/`, `.superpowers/` or `.env`. All new files are LF. Per the brief, the `17bb6a0` trailer is not reported here.

## Deviations judged

Deviations 1, 2, 4, 5 and 6 are sound and well argued. Deviation 3 is not a deviation at all: §1's own example shows `"evidence": ["oracle:runs/…/oracle-1"]`, artefact-shaped, so the implementation matches the spec and the brief's wording was the looser of the two. The report's own flagged gaps (`checkpointRefusal` still answering for `ck-`, the `accepted` ledger row after the save, `accept` spending no budget, the candidate untested live) are all accurate and correctly deferred.

---

# Re-review — fix round 1 and Task 4b

Reviewed: `b03104f`, `2c1cbae`, `ee39ca8` (range `d0d45da..ee39ca8`). Read-only; `npm test` run once.

**Verdict: all six round-1 findings ADDRESSED. Task 4b needs one fix** — a new Important (N-1): a restore from an accepted checkpoint does not require its config to enable management, and `ARBITER_WS_SOURCE` is MANAGE-gated, so the run silently starts from the task's seed and still reports a run id as if it were a restore.

`npm test`: `ℹ tests 695 / ℹ pass 695 / ℹ fail 0`. Confirmed.

## Round-1 findings

| finding | status | where |
|---|---|---|
| I-1 throw in `checkEvidence` escapes with no row | **ADDRESSED** | `lib/manage/instructions.mjs:600` |
| I-2 `artifact:` follows symlinks | **ADDRESSED** | `lib/manage/evidence.mjs:112,116` |
| I-3a playthrough spawns before any ledger row | **ADDRESSED** | `lib/manage/instructions.mjs:460` |
| I-3b playthrough handed the checkpoint itself | **ADDRESSED** | `lib/manage/evidence.mjs:201-213` |
| M-1 `review:human` has no producer | **ADDRESSED** | `tools/manage.mjs:190` |
| M-2 `isCandidateId` unanchored | **ADDRESSED** | `lib/manage/checkpoint.mjs:34` |
| M-3 root `manifest.json`/`evidence` clobbered | **ADDRESSED** | `lib/manage/checkpoint.mjs:73` |
| M-4 `evidence` demanded when nothing reads it | **ADDRESSED** | `lib/manage/instructions.mjs:418-423` |

**(a)** The per-verb check is wrapped and a throw becomes `precondition: "<verb> could not be verified: …"` with a ledger row. Pinned on a truncated `manifest.json`, asserting the code, the reason, `ledgerRow.verified === false` and a byte-identical `task.json`. The catch is the right shape: it converts rather than swallowing, and the message reaches the manager.

**(b)** `lstatSync` in a try, a symlink refused by name before any read, and `!st.isFile()` still refusing a directory. The test drives all three validators through the link and asserts a real file is unaffected; the junction fallback is the right call on Windows, and `t.skip` fires only when neither can be made.

**(c)** Both halves. The `evidence_check` row goes down after the checkpoint-exists check and before the criteria loop, carrying the milestone, the checkpoint, the criteria and the offered run ids; the test pins `row.seq < out.ledgerRow.seq` on a refused accept, which is the ordering that matters. The playthrough copies to `os.tmpdir()` with `manifest.json` and `evidence` filtered out, and the copy is removed in a `finally` whose own failure is swallowed. The test's spawn stub writes into what it is handed, then asserts the checkpoint is untouched and the temp directory is gone. `spawnSync` is synchronous, so the `finally` cannot race the child.

**(e)** `review` refuses a `cand-` id, a criterion whose check is not `review:`, an unknown criterion and a checkpoint not on disk, and the test then feeds the row it writes back through a real `accept`.

One nit on M-4: `evidence` is still in `ARGS.accept.required`, so a programmatic caller must pass `evidence: []` explicitly rather than omitting it. The CLI defaults it, so only a hand-written instruction file hits this.

One nit on I-1: the comment above the new catch ends "nothing here has written anything yet", which stopped being true when the `evidence_check` row moved inside `check`. Worth a word change so the next reader does not rely on it.

## Task 4b

**(d)** `ARBITER_WS_SOURCE` is read in one block at `supervisor.mjs:283`, MANAGE-gated, `exit(2)` when it names nothing, and the copy at line 404 is a third arm of the existing fork/seed branch with `CHECKPOINT_OWN` filtered out. `summary.wsSource` records it. The guards test pins the gate, the exit, the filter expression and that the variable is mentioned in exactly three places, all inside its block.

The executor requires `approach.config` and refuses `approach.message` and `approach.firstAction` for a `ck-` restore, each with a reason that says where the dropped thing would have gone. `checkpointRefusal` now takes `{ taskDir, allowCk }`: `restore` allows an accepted checkpoint and checks the directory exists, `compare` refuses one and says why. Budget is `runs: 1` and no replicate, pinned in both directions — a fork budget of zero does not refuse, and the run budget is what runs out. The batch child branches on `spec.wsSource`, never reaches the fork runner, and the outcome row carries the new run id; `ee39ca8` fills in a bounded `failed` tail when there is no id. `defaultRestoreRun` clearing the three fork variables is the right defensive move.

### New findings

**N-1 (Important). A `ck-` restore does not require a config with a `manage` block, and without one the run starts from the seed.**
`configRefusal` (`lib/manage/instructions.mjs:296-316`) only parses the config and checks `manage.enabled` when a message has to be delivered (`needsControl`). A `ck-` restore refuses `approach.message` outright, so that branch never fires and the named config is never inspected. But `WS_SOURCE` is MANAGE-gated (`supervisor.mjs:285-289`): with no manage block the supervisor prints one stderr line and copies the task's seed instead.

Input → wrong outcome: `restore { checkpoint: "ck-0007", approach: { config: "configs/orch-pathnorm-27b.json" } }`, the same config without its manage block. The executor accepts it, spends a run, the supervisor starts from the seed, the run produces an id, `runOnce` returns code 0, and the outcome row is indistinguishable from a real restore — `failed` is attached only when there is no run id. The manager reads "restored from ck-0007" and is looking at a fresh start. `summary.wsSource` is the only record that says otherwise, and no packet field carries it. The test fixture `forkFixture({ manage: false })` already builds exactly this config.

Minimal fix: in the `ck-` branch at `lib/manage/instructions.mjs:391`, parse the resolved config and refuse `cfg?.manage?.enabled !== true`, in the same shape as line 314.

**N-2 (Minor). The config a `ck-` restore names is not tied to the checkpoint's task.** `WS_SOURCE` replaces the workspace, but the oracle, the mounts and the spec still come from the config's `task`. A config for another task runs that task's oracle against the restored tree and wastes the run. It cannot produce a false acceptance, because `accept` re-derives the oracle dir from `summary.task`. The manifest records `runId` but not the task, so the cheap fix is to record it at snapshot time and compare.

**N-3 (Minor, pre-existing). `runOnce` identifies the new run by diffing the runs directory before and after.** That is now the sole source of the restore's `runId` in its outcome row. A concurrent run finishing in the same window attributes the wrong id. `liveWorkRefusal` makes that unlikely for manager-started work, not impossible for a hand-started run.

**N-4 (Minor). A restore copies symlinks and junctions out of the checkpoint into the fresh workspace verbatim.** The `CHECKPOINT_OWN` filter drops only the manifest and the evidence directory, and `cpSync` does not dereference. I-2 closed this for artifact evidence but not for restore, so a link planted in run 1 is present in run 2's workspace and is invisible to the tree hash. Same fix shape: refuse or skip links in the restore copy.

**N-5 (nit).** `tools/manage.mjs:190` takes `--by` without checking it is a string, so a bare `--by` can sign a row with whatever `splitArgs` yields for a valueless flag.

### Hygiene

The three commits touch 9 distinct files, all under `lib/`, `test/`, `tools/` and `supervisor.mjs`. Nothing under `memory/`, `runs/`, `tasks-live/`, `.superpowers/` or `.env`. All LF. Trailers on all three name Claude Fable 5.1.
