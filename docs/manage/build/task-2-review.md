# Task 2 review — instruction contract, control channel, triggers with pause

Reviewed `82dfec7` and `8914f67` on `management` (parent `97d97a8`). `d271e60` and `6b0fc8c` ignored as instructed. Read-only: no edits, no commits, no runs beyond `npm test`.

**Suite:** `npm test` → `tests 550 / pass 550 / fail 0`. Confirmed, matches the report.

**Verdict — spec compliance: ❌.** One §4 trigger, `milestone_candidate`, is implemented and unit-tested in `lib/manage/triggers.mjs` but has no caller anywhere in the supervisor, so it can never fire. Everything else in §3, §4 and §5 that Task 2 owns is present and matches.

**Verdict — code quality: needs fixes.** Two Critical findings: a refusal row poisons its own idempotency key, and a paused run is still treated as idle by `checkIdle`, which can produce a phantom attempt and a double verdict.

The structural caveat that shapes every severity below: **no test in this package executes any supervisor-side manage code.** The MANAGE block, `pumpControl`, `manageTrigger`, `releasePause`, the two pause sites and `manageBudgetCheck` are pinned only by string matches against `supervisor.mjs`'s source. A green suite here is evidence about the text of the file, not its behaviour. That is why Step 9 is load-bearing, and why findings 2 and 6 could ship green.

---

## Critical

### C1. A refused instruction poisons its own idempotency key

`lib/manage/instructions.mjs:188` writes the refusal row with `instruction: instr`, and `lib/manage/ledger.mjs:19` matches **any** row carrying that key, refused or executed. The duplicate check at `lib/manage/instructions.mjs:126-129` therefore treats a refusal as a prior execution.

Concrete input → wrong outcome. The manager answers packet 17 with key `p17-v41` (spec §3's own example, derived from packet id and state version) and a 600-char rationale. It is refused `precondition`; the task state has not moved and the packet is still open. The manager retries the corrected instruction with the same key. It is refused `duplicate_key`, nothing executes, `executeInstruction` returns the **refusal** row as `ledgerRow`, and `tools/manage.mjs:99` prints `already executed: …`. A valid instruction is silently dropped and the operator is told the opposite of what happened. Key reuse after a refusal is the default path, not an edge case.

Minimal fix, inside Task 2's blast radius, at `lib/manage/instructions.mjs:127`:

```js
const prior = findByKey(taskDir, instr.idempotencyKey);
if (prior?.verified === true) return refuse("duplicate_key", …);
```

The same fix belongs in `executeInstruction`'s duplicate branch at line 176. Changing `findByKey` itself would be cleaner but that function is Task 1's; the lead should route that call.

### C2. A paused run is still "idle", so the nudge can manufacture a second attempt and a double verdict

`CAPS.idleNudgeSec` defaults to 120 (`lib/config.mjs:22`) and `MANAGE.timeoutMs` defaults to 120 000. `checkIdle` (`supervisor.mjs:1800`) has no knowledge of `managePause`. While the verdict is withheld the orchestrator is settled by every host-visible measure, `lastActivity` was last set when its done mail arrived, and nothing during the pause refreshes it.

Concrete input → wrong outcome. Management on, `failThreshold: 1`, the manager is slow or `MANAGE_DECISION_TIMEOUT_MS` is raised above 120 000. At 120 s the orchestrator receives `[SUPERVISOR] You have been idle for 120s with no worker running… or send kind="done" if it is complete.` It sends `done`. `runOracle` runs again (`supervisor.mjs:1599` increments `doneAttempts` unconditionally; the `lastOracleHash` guard lives in `maybeQuiescentOracle`, not here), `manageTrigger` logs `arrived while a … decision is still owed; not paused again`, that verdict is delivered immediately, and the held one is delivered later on release. The orchestrator gets two verdicts for one claim and burns an attempt that the manager was being asked about.

Minimal fix, in `checkIdle` after the `finished` check:

```js
if (managePause) return; // a run holding a manager decision is waiting, not idle
```

`maybeQuiescentOracle` is safe on its own: `supervisor.mjs:1794`'s `hashDir(srcDir) === lastOracleHash` blocks re-entry on an untouched tree, and the tree cannot change while the orchestrator is blocked. The nudge is the only route in.

---

## Important

### I1. `milestone_candidate` is dead code (the spec-compliance ❌)

`decideTrigger`'s first branch (`lib/manage/triggers.mjs:35`) takes `oraclePassed`, and `test/manage-triggers.test.mjs:10` pins it. No caller ever passes it. `runOracle` returns `finish("SUCCESS: oracle passed")` at `supervisor.mjs:1673` with no trigger, and `finish` (`supervisor.mjs:1892`) computes `accepted = /^SUCCESS/.test(reason)` → `decideTrigger({ runEnded: { accepted: true } })` → `null`. So the one trigger that tells a manager a milestone is ready to accept never reaches the ledger.

The tension is worth stating fairly: Step 6's enumerated sites (a)–(e) do not list it, but the brief's Interfaces paragraph names it among the kinds the supervisor emits, and §4's table has it as the first row.

Minimal fix at `supervisor.mjs:1673`:

```js
if (total > 0 && pass === total) {
    if (MANAGE) { const t = decideTrigger({ oraclePassed: true }); if (t) manageTrigger(t.kind, { attempt: doneAttempts, pass, total }, t.pauses, null); }
    return finish("SUCCESS: oracle passed");
}
```

### I2. The `acceptance` gate refuses the escape hatch it recommends

`lib/manage/instructions.mjs:143` tests `/acceptance/i` against `JSON.stringify(args)`, and the refusal text tells the manager to `escalate with wants="criteria_change"` instead. An `escalate` whose `reason` explains *which* acceptance criterion is wrong contains the word and is refused. So is a `correct` message such as "ignore c3, the acceptance criteria for it are covered already". The escalate test at `test/manage-instructions.test.mjs:169` passes only because its fixture reason happens to avoid the word.

This is a brief defect, not an implementer error: Step 1 mandates "any instruction whose args mention `acceptance` → `precondition`", and the implementer followed it exactly. The rule's purpose is that no instruction *writes* acceptance, and free text does not write anything.

Minimal fix: keep the broad scan but exempt the two free-text fields, checking `JSON.stringify({ ...args, reason: undefined, message: undefined })`, or match object keys rather than rendered text.

### I3. A `toolCalls` grant is bounded by nothing (the lead's second question)

Ruling: **the grant must be bounded, and `toolCalls` currently is not.** `wallSec` is correct — `budgetRefusal` (`lib/manage/instructions.mjs:83-85`) refuses a grant above `budgetLeft.wallSec` and `executeInstruction:203` debits it with `spendBudget`, so §1's "budgets are the harness's to enforce" holds for wall time. `toolCalls` is checked for sign only (`instructions.mjs:38`), never compared to anything, never spent, and `pumpControl` raises `CAPS.toolCalls` by it with no ceiling (`supervisor.mjs:1490`). The root cause is a spec mismatch: §3's `continue` grant carries `toolCalls`, §1's budget shape omits it, and `BUDGET_KEYS` (`lib/manage/task-state.mjs:8`) follows §1.

Cheapest correct fix: add `toolCalls` to `BUDGET_KEYS` and handle it in `budgetRefusal` and the `spendBudget` call exactly as `wallSec` is. The within-Task-2 alternative is to refuse a non-zero `toolCalls` grant while no such budget exists.

Related test gap: **the `continue` budget path has no test at all.** Only `restore`'s runs-0 case is pinned (`test/manage-instructions.test.mjs:85`). The one budget check the lead asked about is unverified.

### I4. `failThreshold >= CAPS.doneAttempts` should warn at config time — agreed with the lead

The implementer's concern is correct and I reach the same conclusion. At the last attempt `runOracle` returns through the `doneAttempts >= CAPS.doneAttempts` branch (`supervisor.mjs:1685`), which delivers nothing, so there is no verdict to withhold and `run_ended_without_acceptance` fires instead. A config with `failThreshold: 5` and `doneAttempts: 5` looks like a broken feature.

Ruling: **yes, one `console.error` beside the existing `JEV_ON && !JEV_KEY` warning**, immediately after the MANAGE block at `supervisor.mjs:257`, covering both the unreachable case and a non-positive threshold:

```js
if (MANAGE && MANAGE.failThreshold >= CAPS.doneAttempts) console.error(`[supervisor] manage.failThreshold ${MANAGE.failThreshold} >= caps.doneAttempts ${CAPS.doneAttempts} — the oracle_failed_repeatedly pause can never fire`);
```

Pin it in `test/supervisor-guards.test.mjs` the way the jev warning is pinned.

---

## Minor

- **`test/manage-instructions.test.mjs` misses one precondition case.** The brief's nine refusal codes include `continue` naming a milestone that is not current (`lib/manage/instructions.mjs:35`). The code is there; no test pins it. `compare`'s branch/replicate limits and `escalate`'s `wants` enum are likewise unpinned.
- **Two source assertions are whole-file matches that prove nothing about site.** `test/supervisor-guards.test.mjs` asserts `src.includes("if (managePause) {")` and `src.includes('log({ type: "manage"')` against the entire file rather than a slice. Every other new assertion in that file correctly slices the function it is about (`manageTrigger`, `pumpControl`, `manageBudgetCheck`, `finish`, the two thunks). Slice `manageTrigger` for the first and drop or re-site the second.
- **Two triggers on the tick that ends the run.** `checkCaps` calls `manageBudgetCheck(t)` before the cap tests (`supervisor.mjs:1765`), so the poll that crosses a cap can emit `budget_threshold` and then `run_ended_without_acceptance` from `finish`. Harmless, but it puts a packet request in the ledger for a run that is already over. Moving the call after the cap tests costs nothing.
- **A queued escalation is reported as a timeout.** `supervisor.mjs:944` — when a pause is already open, `manageTrigger` returns false and the route calls `ackEscalation(null, true)`, telling the orchestrator "no decision came back in time" when in fact one was never solicited. The comment argues the case and the outcome is safe; the text is simply not true. A third message, or reusing `escalationAnswered`, would be honest.
- **`ARGS.continue` accepts an array `budgetGrant`.** `instructions.mjs:36-37` — after `?? {}`, `typeof g !== "object"` catches a primitive but not `[]`. One-line `Array.isArray` guard.

---

## The accepted deviations — all three implemented as stated

1. **Key before version.** `lib/manage/instructions.mjs:126` precedes `:131`, argued in a comment at 119-125 and pinned by the order test at `test/manage-instructions.test.mjs:127`, which also checks that a fresh key on a stale version is still stale. Note that C1 is the cost of this ordering being correct but the key lookup being too broad.
2. **A `decision` releases the open pause without matching a packetId.** `supervisor.mjs:1496-1499` logs `entry.packetId` and calls `releasePause` unconditionally. Correct given ruling 5.
3. **`kind="escalate"` gated on `ARBITER_MANAGE`.** `ext/mail-ext.ts:62-68`, set at `supervisor.mjs:614` for the orchestrator's process only. `test/mail-ext-render.test.mjs` passes `ARBITER_MANAGE: ""` explicitly so an ambient value cannot drift the pinned kind list, and asserts both that the kind is absent without it and that the description does not mention escalation. The stable-prefix argument holds.

Also confirmed as asked: the executor never imports the supervisor and the supervisor imports only `decideTrigger` (asserted over the import lines, `test/supervisor-guards.test.mjs`); the ledger row is written before every side effect (`instructions.mjs:199`, pinned by a `ts` comparison); a refusal is a ledger row and a duplicate is not; every verb appends a `decision` entry last; routing, `M.manage.correction`, the mail-ext text and the config pass-through are each pinned by a test; `acceptance` is never written by any instruction, and `saveTask` refuses it independently.

## One concern of the implementer's I would set aside

The correction-ordering concern (report, "asserted structurally, not observed") is wrong in the safe direction. If a `correct` and its `decision` ever did land in separate polls, `pumpControl` stores the correction on the open pause (`supervisor.mjs:1489`) rather than delivering it, and `releasePause` hands it to the held thunk, which delivers it ahead of the verdict. The ordering survives a split batch. No fix needed.

## Hygiene — clean

Nothing under `memory/`, `runs/`, `tasks-live/` or `.env` in the two commits. CRLF throughout, matching the repo. Both commit messages carry the `Co-Authored-By` and `Claude-Session` trailers in the form the surrounding history uses. The working tree's modified `memory/records.jsonl` and three untracked `docs/batch/*.md` files are uncommitted and outside the range.

---

# Re-review — fix round 1 (`14df7cb`, `bce6530`)

**Verdict: all eight findings ADDRESSED. One new Critical introduced by the `toolCalls` budget fix — every pre-existing `task.json`, including the live one at `tasks-live/pathnorm-night/`, now crashes `budgetLeft` with a `TypeError`. Fix that and Task 2 is approved.**

Reviewed `8914f67..bce6530`, ignoring `7cee33f`. `npm test` → `tests 560 / pass 560 / fail 0`, confirmed.

## Finding-by-finding

| finding | status | where |
|---|---|---|
| C1 refusal rows poison their key | ADDRESSED | `lib/manage/ledger.mjs:31`, `lib/manage/instructions.mjs:139` |
| C2 a paused run is still idle | ADDRESSED | `supervisor.mjs:1828`, `supervisor.mjs:1484` |
| I1 `milestone_candidate` never fires | ADDRESSED | `supervisor.mjs:1685-1695`, `supervisor.mjs:1931` |
| I2 acceptance scan refuses its own escape hatch | ADDRESSED | `lib/manage/instructions.mjs:155` |
| I3a `toolCalls` grant unbounded | ADDRESSED, with a regression (below) | `lib/manage/task-state.mjs:14`, `instructions.mjs:85-91` |
| I3b no `continue` budget test | ADDRESSED | `test/manage-instructions.test.mjs:93-117` |
| I4 `failThreshold` warning | ADDRESSED | `supervisor.mjs:258-263` |
| M two whole-file source matches | ADDRESSED | `test/supervisor-guards.test.mjs:309-316, 366-372` |

The three Minors I did not name as required are also fixed: `manageBudgetCheck` now runs after the cap tests (`supervisor.mjs:1791-1793`), the queued escalation no longer claims a timeout (`supervisor.mjs:953`), and `budgetGrant` rejects an array (`instructions.mjs:37`). The remaining precondition cases are pinned at `test/manage-instructions.test.mjs:126-136`.

## The specific checks

**(a) `findByKey({ executedOnly })` — correct.** `lib/manage/ledger.mjs:32` matches the key and, by default, `r.verified === true`. A refused row is skipped and an executed one is found, pinned at `test/manage-ledger.test.mjs:25-31`. Both call sites in `instructions.mjs` (139 and 194) take the default, so the duplicate acknowledgement can only ever return a row that ran. Task 1's rows do carry `verified`: the only writers are `instructions.mjs:205` (`false`) and `:216` (`true`), and `recordOutcome` writes no `instruction` key so it can never match. The two pre-existing ledger tests were updated to write `verified: true` rather than relaxing the check. The end-to-end case — refuse, correct under the same key, execute, then acknowledge a third delivery against the row that executed — is pinned at `test/manage-instructions.test.mjs:184-202`.

**(b) `checkIdle` and `lastActivity` — correct, and the assertions are sliced.** `supervisor.mjs:1828` returns on `managePause` before the readiness test, and `releasePause` refreshes `lastActivity` at `:1484`, so the pause is not charged against `idleNudgeSec` on release. `test/supervisor-guards.test.mjs:330-338` slices `checkIdle` and asserts both the guard and its position ahead of `a.ready && !a.busy`; `:314-316` slices `releasePause` for the refresh. A welcome side effect: `maybeQuiescentOracle` is reached only through `checkIdle`, so the pause now also blocks the quiescence route into `runOracle`.

**(c) `milestone_candidate` and the flag — correct, one trigger per ending.** The pass path is now a block (`supervisor.mjs:1685`) that calls `decideTrigger({ oraclePassed: true })` and sets `milestoneCandidateFired` before `finish("SUCCESS: oracle passed")`. `finish` reads `milestoneCandidateFired ? null : decideTrigger({ runEnded: { reason, accepted: false } })` at `:1931`, so the two readings of one ending cannot both land.

The flag is module-level, set in exactly one place, and **never reset** — which is right, not a gap. A supervisor process is one run; a reset would only be needed if a run could pass its oracle and then continue, and it cannot (`finish` is the next statement). Nothing else reads or writes it.

A run that passes at attempt 3 fires exactly one trigger for its ending: attempts 1 and 2 fail and, at the default threshold of 2, attempt 2 emits `oracle_failed_repeatedly`; attempt 3 passes and emits `milestone_candidate`; `run_ended_without_acceptance` is suppressed. Two triggers over the run, one for the ending. Dropping the `/^SUCCESS/` inference is the stronger half of this change and is argued correctly in the comment: acceptance is an `accept` instruction's act on `task.json`, not something the harness reads out of its own finish reason. Pinned at `test/supervisor-guards.test.mjs:342-356` and `test/manage-triggers.test.mjs:39-49`.

**(d) `toolCalls` in `BUDGET_KEYS` — the convention holds, the grant is bounded, but see the regression.** `budgetRefusal` (`instructions.mjs:85-91`) now loops both halves against `budgetLeft`, and `executeInstruction:220-226` charges both in one `saveTask`, so one instruction still bumps the state version once. The zero-is-unbounded convention carries over unchanged: `budgetShape` defaults the total to 0, `spendBudget`'s `if (b.total && …)` skips the ceiling, `budgetLeft` reports `null`. Pinned at `test/manage-instructions.test.mjs:93-117` (over-budget on each half, spending to the last unit, the second grant measured against what the first left, one version bump) and `:119-123` (an unset key grants freely).

## New Critical

### C3. Adding `toolCalls` to `BUDGET_KEYS` breaks every `task.json` written before this commit

`lib/manage/task-state.mjs:92` reads `task.budget[k].total` for every key in `BUDGET_KEYS`. A task created before `14df7cb` has no `budget.toolCalls`, so `budgetLeft` throws `TypeError: Cannot read properties of undefined (reading 'total')`.

Concrete input → wrong outcome. `tasks-live/pathnorm-night/task.json` exists now, at `stateVersion 1` with one ledger row, and its budget holds only `wallSec`, `runs`, `forkReplicates` and `usd`. So `node tools/manage.mjs packet tasks-live/pathnorm-night <runId> --trigger oracle_failed_repeatedly` throws on the way through `defaultVerbs` (`lib/manage/packet.mjs:145`), and `execute` throws out of `validateInstruction` → `budgetRefusal` → `budgetLeft` for every verb, so an instruction that should be cleanly refused crashes the command instead. That is the task directory Step 9's live check uses. The suite is green because every fixture builds its task through `createTask`, which always writes the full shape.

Minimal fix at `lib/manage/task-state.mjs:91-93`, treating a missing key as unset, which is what it means:

```js
export function budgetLeft(task) {
	return Object.fromEntries(BUDGET_KEYS.map((k) => {
		const b = task.budget?.[k] ?? { total: 0, used: 0 };
		return [k, b.total ? b.total - b.used : null];
	}));
}
```

`spendBudget` needs the same tolerance at `:84-86`, since `budget[k]` is read there too. Alternatively normalise the budget in `loadTask`. Either belongs to Task 1's module, so the lead should route it, but the breakage is this diff's.

## Nothing else new

No other Critical or Important in the range. The escalate ack at `supervisor.mjs:953` now takes the `escalationAnswered` text for a queued escalation, which is the option I offered; it is still not literally true that anyone answered, but the operative content (criteria and budget unchanged, carry on) is, and the trigger is in the lifecycle file either way. Hygiene remains clean: nothing under `memory/`, `runs/`, `tasks-live/` or `.env` in either commit, CRLF consistent, both trailers present.

The caveat from the first round is unchanged and still governs. No test executes supervisor-side manage code; the pause, the release, the nudge suppression and `milestone_candidate` are all pinned by source assertions only. Step 9 remains the first real evidence.

---

# Re-review — fix round 2 (`04074e0`)

**Verdict: C3 ADDRESSED. No new breakage. Task 2 closes on this review, subject to the live check (Step 9).**

`npm test` → `tests 562 / pass 562 / fail 0`, confirmed.

## C3 — a missing budget key now reads as unset

`withEveryBudgetKey` (`lib/manage/task-state.mjs:36-40`) fills every entry in `BUDGET_KEYS` with `{ total: 0, used: 0, ...(budget[k] ?? {}) }`, spread over a copy of whatever the file held. It is applied at all three points that can meet an old shape: `loadTask:68`, `spendBudget:104` and `budgetLeft:119`. Each of the checks you asked for holds.

- **Loads.** `loadTask` returns the parsed task with a normalised budget, so `task.budget.toolCalls` exists whatever the file said.
- **`budgetLeft` returns `null` for it.** The filled entry has `total: 0`, and the zero-is-unbounded convention reads that as uncapped rather than as a ceiling of zero. Pinned at `test/manage-task-state.test.mjs:70`, alongside an assertion that the keys the file did have are untouched.
- **`spendBudget` charges it.** `spendBudget:104` normalises its own input, so `b.total` is `0`, the `if (b.total && …)` ceiling check is skipped, and the spend is recorded. Pinned at `:72`.
- **`assemblePacket` and `validateInstruction` answer instead of throwing.** Both were the crash sites, since both reach `budgetLeft`. `test/manage-task-state.test.mjs:84-99` runs each against the legacy fixture: the packet comes back with `options.budgetLeft.toolCalls === null` and a sane `verbsAllowed`, and an instruction naming a dead run is cleanly refused `precondition` rather than crashing on the way through `budgetRefusal`.

The fixture at `:60-68` is built by creating a task and then deleting `budget.toolCalls` from the file on disk, which is exactly the shape `tasks-live/pathnorm-night/task.json` has. It asserts the key really is absent before the test means anything. That is a reproduction of the live file rather than the live file itself, which is the right call for a test, and the shapes match in the only respect that matters.

## Normalising on read without writing — confirmed

`loadTask:67-70` reads, parses and returns a new object; it performs no write of any kind. The test asserts the file still lacks `toolCalls` after a load (`test/manage-task-state.test.mjs:77`), which is the property worth pinning: a read that rewrote the record would bump `stateVersion` through `saveTask` and refuse a packet already in flight as stale, purely because someone looked at the task. The implementer's argument is correct.

Every mutation does go through `saveTask`. The only writers of `task.json` in the tree are `saveTask:82-84` itself, with its tmp-and-rename, and `createTask`, which ends by calling it. The only callers that change the task are `instructions.mjs:226` (the grant) and `:232` (the escalate blocker), both through `saveTask`. `packet.mjs:153` and `instructions.mjs:190` load without saving. The supervisor never reads or writes the file at all.

Normalising in `spendBudget` and `budgetLeft` as well as `loadTask` is redundant for anything that came through `loadTask` and correct anyway: a task object also reaches them hand-built or from an in-memory copy taken before the key existed, and `test/manage-task-state.test.mjs:80-82` covers exactly that. It also repairs a partial entry, such as a `{ total }` with no `used`, which previously produced `NaN` rather than a crash.

## No new breakage — two cosmetic notes

Neither blocks anything.

- A packet's `task` blob for a legacy task now carries a `toolCalls` budget the file does not have, so §2's "task.json verbatim" is no longer literally true for such a task. The divergence is one unset key, and the manager arguably benefits from seeing every key; worth knowing if a packet is ever diffed against the file.
- `budgetShape:20-24` and `withEveryBudgetKey:36-40` now do nearly the same job, differing only in that the former drops keys outside `BUDGET_KEYS`. `createTask` could call the latter. Purely tidiness.

Everything from the earlier rounds stands as reported. The one caveat that outlives this review is unchanged: no test executes supervisor-side manage code, so the pause, the release, the nudge suppression and `milestone_candidate` remain pinned by source assertions alone, and Step 9 is their first real evidence.

---

# Re-review — round 3, from the live check (`5d6622e`, `b94faf3`)

**Verdict: approved. All five checks pass. No new Critical or Important. One Minor worth acting on before the next live run: a live packet reports `tokens: 0` with no marker saying the figure is unavailable rather than zero.**

Reviewed the working tree at `b94faf3` over `lib/manage/pause.mjs`, `lib/manage/packet.mjs`, `supervisor.mjs` and the three test files. `79f3927`'s `compare.mjs` and batch code ignored as instructed. `npm test` → `tests 620 / pass 620 / fail 0`, confirmed.

The diagnosis is right, and the evidence supports it. `log()` writes the audit line first (`supervisor.mjs:283`) and only then writes to stdout (`:285`), so a console that dies mid-run loses nothing from the record. An unhandled `EPIPE` from that second write is an ordinary process-killing error, and it lands with no `FINISH` row and no summary — which is exactly the shape the first live check left behind. Not a pause bug.

## (a) The pause module and its adapters

`createPause` (`lib/manage/pause.mjs:44`) holds all of it: `open`, `onControl`, `tick`, `isOpen`, plus `kind`/`deadline`/`correction` readers. It touches no file, no timer and no supervisor state, and returns action sets of one fixed shape, so a caller can act on one branch and ignore the rest.

Every case you named is pinned in `test/manage-pause.test.mjs`: a tick at `+0`, `+1` and `+999` against a 1 000 ms limit does nothing (`:18`); a tick at exactly the deadline releases once, marks `defaulted`, and a later tick has nothing left (`:31`); a decision releases and is not a default (`:47`); a correction is held and travels with the release rather than ahead of it (`:58`), while one with no pause open goes at once (`:71`); a second open is refused and logged, and neither the first payload nor its deadline moves (`:87`); and the timeout falls back to 120 000 for each of `undefined`, `null`, `0`, `-1`, `NaN`, `""`, `"soon"` and `{}`, with a configured number honoured and a string from the env override parsed (`:118`). That last one closes the failure it was written for: a `NaN` deadline compares false against every clock, so the pause would never default.

Nothing else holds pause state. The supervisor keeps one `const managePause = createPause(...)` (`supervisor.mjs:1477`) for the whole run, and the three adapters are thin: `manageTrigger` calls `open` and logs what comes back (`:1492-1494`), `pumpControl` feeds `onControl` and `tick` (`:1546-1553`), and `applyPauseActions` performs what either returns (`:1508-1531`). The old `let managePause = null` object and the hand-written deadline arithmetic are gone; `checkIdle` and `finish` now ask `isOpen()`. The one structural note: `manageTrigger` logs `open`'s lines itself instead of routing through `applyPauseActions`. Harmless, since `open` never returns a delivery, but it is a second reader of the module's output.

Creating the pause unconditionally, even when `MANAGE` is null, is safe: nothing can open it, because `manageTrigger` returns before `open` when management is off.

## (b) One guard for every delivery

`deliver()` is the single chokepoint. It holds the only `send(to, { type: "prompt" … })` in the file (`supervisor.mjs:764`), so no prompt reaches an agent without passing the guard at `:733`. Both compaction flushes re-enter `deliver` rather than sending directly (`:1100`, `:1113`), and they suffix the label, so a nudge queued before a pause and flushed during one still matches `^idle nudge` and is still held.

The guard sits after the unknown-agent warning and before both the compaction queue and the send, which `test/supervisor-guards.test.mjs:387-390` pins by index. Which labels are held is the pause module's rule (`SUPPRESSED_WHILE_PAUSED`, `pause.mjs:28`), not a condition restated in the supervisor, and the test asserts the supervisor does not name a label itself (`:395`). `suppressWhilePaused` is unit-tested over the two held labels in the exact strings the call sites pass, and over seven that must go through, including the oracle verdict, a manager correction and compaction (`test/manage-pause.test.mjs:132`).

The two held labels are the right two. The idle nudge is also unreachable during a pause because `checkIdle` returns first, so the guard is belt-and-braces there; the silent-turn nudge (`supervisor.mjs:893`) has no counter and no state, so holding it costs nothing and its own `silent_turn` audit line still records that it happened.

One thing worth stating because it could easily have gone the other way: the held verdict is not caught by its own guard. `release` clears the pause before returning the action, so `isOpen()` is already false when `applyPauseActions` invokes the payload. No self-deadlock.

## (c) The three pinned non-causes

All three are pinned as claimed.

- **The poll is registered at top level.** `test/supervisor-guards.test.mjs:271` matches a whole unindented line rather than a substring, so nesting it inside any block fails the test. Verified independently: the fork block spans `supervisor.mjs:2159-2325` and the interval registrations follow at `:2352-2376`, so a fork run that does not abort reaches the poll exactly as an ordinary run does.
- **The deadline check is outside the control-file branch.** `pumpControl:1552` calls `tick` after the `existsSync` block closes, pinned by an index comparison at `test/supervisor-guards.test.mjs:339`. This matters for the case that cannot be tested any other way: a run nobody ever answers has no `control.jsonl` at all, and that is precisely the run that must default.
- **The wall cap is not behind the idle guard.** `checkCaps` owns it, on its own 5 000 ms interval, and a new test asserts that `checkIdle` neither tests `CAPS.wallSec` nor is the only caller of `checkCaps`, and that `checkCaps` never mentions `managePause` (`test/supervisor-guards.test.mjs:357-370`). A pause nobody answers cannot outlive the run's budget.

Wrapping `pumpControl`'s whole body in `try`/`catch` (`:1541`, `:1556`) is the right call and belongs with these: a throw inside an interval callback takes the process down, and this is the one tick a paused run depends on.

## (d) EPIPE

`supervisor.mjs:266-271` attaches an error listener to both `process.stdout` and `process.stderr`, swallows `EPIPE` and rethrows everything else, so a non-pipe failure still surfaces. It covers stderr as well as stdout, which is more than you asked for and correct for the same reason.

The audit keeps its line: `log()` writes to the audit stream before the console (`:283` then `:285`), and the audit is a file stream, unaffected by a closed pipe. Pinned at `test/supervisor-guards.test.mjs:347-353`. The handler is registered before the audit stream opens and before any `log()` call; the only console writes ahead of it are the two startup `console.error` warnings, which run before anything could have closed a pipe.

## (e) Live packets — PARTIAL on the marker

The mechanism is right. `assemblePacket` no longer requires `summary.json` (`lib/manage/packet.mjs:188`), falling back to `liveSummary`, which recovers elapsed seconds from the last audit line's `t`, mail count from the audit's typed rows, and `doneAttempts` from the count of `oracle-N` directories. `run.status` is `summary.reason ? "finished" : "running"` (`:204`), so a live packet says `running` with `reason: null`. `tools/manage.mjs packet` succeeds against a live run directory, pinned end to end by `test/manage-packet.test.mjs:126` (the CLI, exit 0, `status: "running"` in the written file) and `:100` (the assembled shape, including `wallSec` 34.9 from the audit and every §2 field still present). The fixture really lacks `summary.json` and asserts so first. The finished path still reads the summary and reports `finished` (`:143`).

The Minor: **`liveSummary`'s `live: true` never reaches the packet.** `assemblePacket` builds `run` field by field, so the flag is dropped, and the packet's only signal is `status: "running"`. That is a real signal and it is the §2 field for exactly this, so this is not a defect — but `tokens: 0` then sits in the packet as an ordinary value, and a manager reading a running packet cannot tell "not measurable from disk" from "nothing spent yet". Zero is a legitimate reading of that field. Cheapest fix is `tokens: null` on the live path, or carrying a short `partial: ["tokens"]` next to `status`. There is no cost field in the packet at all, so the concern is `tokens` alone. Also worth knowing: `config` is `null` on a live packet, so the manager is not told which config the run used.

## (f) Nothing new at Critical or Important

Two notes, neither blocking.

- The `ARBITER_FORK_CONTROL` copy in `supervisor.mjs:2172-2184` appears in this diff range but came in with `024933f`, Task 3's restore, not with either round-3 commit. For what it is worth, it reads correctly: fork-only, aborting rather than ignoring a named file that does not exist, copied after the run directory exists and before the `continue` resumes the orchestrator, and it says so out loud when the config has no manage block to read it.
- The assertion that the tick sits outside the control-file branch compares against the literal `"}\n\t\t}"` (`test/supervisor-guards.test.mjs:339`). It works and it checks the right thing, but it will break on any reindentation of that block. An index comparison against `fs.existsSync(controlTail.filePath)` and the loop body would be steadier.

Hygiene clean: nothing under `memory/`, `runs/`, `tasks-live/` or `.env` in the range, CRLF consistent, trailers in the usual form.

The standing caveat finally has a crack in it. Supervisor-side manage code is still pinned by source assertions rather than executed, but the pause *rules* now live in a pure module with real unit tests, which is where the live check's uncertainty mostly sat. What remains unexercised is the wiring: that a trigger opens the pause, that the orchestrator genuinely blocks, and that a control entry written by an executor lands on the next poll.

---

# Re-review — round 4, from live attempt 2 (`8e6cdf5`, `48c2951`)

**Verdict: approved with one Important to fix before attempt 3. All five checks pass on their own terms, but the allow-list's end anchors and the compaction flush's label suffixing interact badly: an allowed delivery that was queued during a compaction is reclassified as "drop" when it is flushed while a pause is open. A manager correction can be silently lost that way.**

`npm test` → `tests 634 / pass 634 / fail 0`, confirmed. `6f67982` ignored as instructed. Hygiene clean: nothing under `memory/`, `runs/`, `tasks-live/` or `.env`, trailers in the usual form.

## Important

### I5. An allowed label that passes through the compaction queue comes back as a dropped one

`ALLOWED_WHILE_PAUSED` (`lib/manage/pause.mjs:34`) anchors four of its five patterns at both ends — `/^oracle verdict$/`, `/^manager correction$/`, `/^escalation (answered|defaulted)$/`, `/^checkpoint request$/`. Only `/^compaction /` is a prefix. Meanwhile both compaction flushes rewrite the label: `deliver("orchestrator", q.text, `${q.why} (queued during compaction)`)` (`supervisor.mjs:1118`, and `:1104` for the failed path). A label that goes into that queue as allowed comes out matching nothing, so `classifyDelivery` falls through both lists and returns `"drop"`.

Concrete sequence, with the correction as the worst case. A manager answers a `budget_threshold` trigger, which does not pause. `applyPauseActions` delivers `M.manage.correction(...)` under the label `manager correction`. The orchestrator is compacting, so `deliver` queues it (`supervisor.mjs:751`). Before the compaction returns, the oracle fails and a pause opens. `onCompactResponse` then flushes, calling `deliver` with `manager correction (queued during compaction)`; the pause is open, the label matches no allow pattern, and the manager's instruction is dropped. The audit says `dropped: manager decision pending`, so it is not invisible, but the manager's one instruction for that packet never reaches the orchestrator and nothing retries it.

The same shape applies to a superseded `oracle verdict` and to an `escalation answered`. The verdict case is less damaging, since a held verdict supersedes it anyway.

The interaction is invisible in the tests because the one allowed label that survives suffixing is the one that was tested: `test/manage-pause.test.mjs:136` checks `compaction done (queued during compaction)` and it passes only because that pattern is prefix-anchored. No test suffixes any of the other four.

Minimal fix, and the one I would take: stop rewriting the label at the two flush sites. Pass `q.why` through unchanged and put the "queued during compaction" fact in the log line instead, which keeps the anchors meaningful and fixes every suffixed allowed label at once. The one-line alternative is to loosen each anchor to `( \(|$)`, but that also admits any future parenthetical and contradicts the test at `test/manage-pause.test.mjs:151`, which deliberately holds `oracle verdict (stale)`.

## (a) The held claim

`handleApproval`'s guard is the first statement in the function (`supervisor.mjs:1434-1447`), ahead of `srcDir`, `decideApproval`, `jevDoneGate` and `hashDir`, and it returns without delivering. `test/supervisor-guards.test.mjs:419-433` slices the function and pins the guard's index below all three, and asserts that the held branch contains no `deliver(` at all. The duplicate is superseded rather than queued, exactly as the ruling says: nothing is added to the pause queue, because the queue lives in `deliver`, which this path never reaches.

`doneAttempts` is incremented inside `runOracle`, which the held branch never calls, so a claim made during a pause now costs no attempt.

One boundary worth naming: `handleApproval` is the only route into the gate for the orchestrator pattern, which is the only pattern management is used with. Two other paths reach `runOracle` directly — `case "solo_done"` in `pumpBus` (`supervisor.mjs:929`) and `maybeQuiescentOracle` (`:1821`). The first is unreachable in the orchestrator pattern, because `routeMail` sends the orchestrator's `done` to `approval`; the second sits behind `checkIdle`, which returns during a pause. So the cover is complete today, and would not be if `manage` were ever enabled on a solo config.

## (b) The allow-list

The inversion is right and the reasoning in the commit message is the correct reading of the live evidence. `classifyDelivery` (`lib/manage/pause.mjs:50`) is the single rule, `suppressWhilePaused` is derived from it, and `deliver`'s guard is the only pause condition in the supervisor.

I enumerated every `why` label `deliver()` is called with in `supervisor.mjs` and classified each by hand. All nineteen are covered and each lands where it should: the verdict, the correction, the two escalation acknowledgements, compaction and the checkpoint request are allowed; the six probe labels, the auto-probe label, the memory acknowledgement, the no-counterpart ack, the jev hold and the relayed `mail #N` queue; the silent-turn and idle nudges drop. `kickoff` drops, which is harmless because it only fires from the ready timer at startup. `test/manage-pause.test.mjs:132-155` enumerates the same list, so the pinning matches the call sites rather than an idea of them.

A new label is held by default, pinned twice (`"some new delivery site"` and `undefined` both classify as drop). The source assertion forbidding per-site conditions is at `test/supervisor-guards.test.mjs:406-410`: it collects every line containing both `deliver(` and `managePause` and requires the list to be empty, and separately requires the memory acknowledgement to go through `deliver`. It is line-scoped, so a condition written on an adjacent line would slip past, but combined with the two "the rule is not restated here" assertions it is enough.

Subject to I5, this check passes.

## (c) The queue

Order is right and pinned on both release paths. `release` (`lib/manage/pause.mjs:154-166`) puts the release action first and the queued items after it, in push order; `test/manage-pause.test.mjs:181-206` pins the kinds as `["release", "queued", "queued"]`, the two labels in production order, and the recipient and text carried verbatim. `test/manage-pause.test.mjs:208-220` pins the same for a decision release and asserts that a pause with nothing held logs no flush line. `applyPauseActions` handles `release` before `queued` and the test pins that index too (`test/supervisor-guards.test.mjs:346`).

Nudges are not queued: `hold` pushes only when `classifyDelivery` says `queue` (`pause.mjs:95`), and the test holds two nudges among four items and asserts the queue length is 2.

Growth is visible rather than bounded, which I think is the right trade: there is no cap, but `deliver` logs one `queued for the release` line per item (`supervisor.mjs:746`) and the release logs the count. A paused orchestrator generates few replies, since held deliveries create no turns. I would leave it.

**PARTIAL on the last sub-check.** A run that ends while paused logs `run ended with a … decision still owed; the held delivery is dropped` (`supervisor.mjs:1984`), which says nothing about the queue. If three replies are waiting, they vanish with no count anywhere. One interpolation of `managePause.queued().length` fixes it.

## (d) The live evidence, run `2026-09-18T05-51-13`

Read from the audit in the `mgmt-live` worktree. Your reading is exactly right, and it changes which fix deserves the credit.

| t (s) | what |
|---|---|
| 14.9 | `memory candidate recorded` delivered — **before** the pause |
| 17.3 | oracle #1 68/70; trigger; pause opens |
| 25.2 | orchestrator re-sends done, "re-send after memory receipt" |
| 25.3 | oracle #2 68/70; second trigger, not paused again; verdict delivered mid-pause |
| 26.1 | silent-turn nudge held — the round-3 fix working |
| 139.2 | default at +121.9 s, held verdict released |

Nothing pre-pause is retroactively affected, and nothing in either commit could be: `deliver`'s guard is conditional on `managePause.isOpen()`, which was false at 14.9 s. The receipt went out legitimately.

So **the allow-list would not have prevented this sequence**. The delivery that gave the orchestrator its turn was the 14.9 s receipt, which was allowed to go and still would be. What the allow-list covers is the same receipt landing a few seconds later, inside the window — and that case is now handled better than by dropping it: `memory candidate recorded` is on the queue list, so it arrives after the release rather than never.

What actually closes the 05-51-13 leak is `handleApproval`'s guard. At 25.2 the re-sent claim now returns without running the gate or the oracle, so there is no attempt 2, no 25.3 verdict, and nothing to deliver mid-pause. Worth noting that `oracle verdict` remains on the allow-list, so the defence against a mid-pause verdict rests entirely on no second oracle running rather than on the delivery rule. Given the route analysis in (a), that holds.

## (e) Nothing else new

I5 above is the only finding. Two smaller observations, neither blocking.

- The flushed replies are relabelled `${why} (held during the pause)` at `supervisor.mjs:1544`. That is safe today because the pause is closed when `applyPauseActions` runs and because every queue pattern is prefix-anchored, so a requeued reply would still classify as `queue`. It is the same suffixing habit as I5, just landing somewhere harmless.
- `manageTrigger` still logs `open`'s lines itself rather than going through `applyPauseActions`, unchanged from round 3 and still harmless.

The standing caveat is now largely retired for the rules and remains for the wiring. Live attempt 2 exercised the trigger, the held nudge, the deadline at exactly +120 s, the release with the held verdict and `milestone_candidate` on the passing attempt. What attempt 3 adds is the decision path: an executor writing `control.jsonl`, the tailer picking it up, and a `correct` landing with the released verdict.
