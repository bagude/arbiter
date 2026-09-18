# Whole-branch fix wave — report

Base `2c4294d` on `management`; eight commits, one per finding group, plus a ninth that fixes two
holes found by reviewing this wave itself. Suite after the last one:
**`ℹ tests 756 / ℹ pass 756 / ℹ fail 0`** (738 before; 18 new tests). No network call, nothing on
`127.0.0.1:8080`, staged by explicit path, nothing under `memory/`, `runs/`, `tasks-live/` or
`.env`, no `--amend`.

| finding | commit | what changed |
|---|---|---|
| **C1** checkpoint grammar | `4945531` | `@` → `#` in `INSTRUCT_TOOL.description` and the `restore` row of `manager-system.md`; both now also say a `compare` checkpoint is a capture, never a `ck-` one, and the prompt names `ck-NNNN` concretely. The test extracts every `run:`/`ck-` form **out of both documents** and runs each through `parseCheckpoint` — a test that repeated the grammar by hand would have passed all along. |
| **I1** paused task | `4b69278` | `validateInstruction` refuses every verb but `escalate` when `task.status !== "active"`, with `task_paused` / `task_complete` and the open blockers named. `serve` checks the status once per tick and answers nothing, so a paused task does not spend a manager call to produce a refusal row. Tests on both sides. |
| **I2** symlink containment | `7535594` | `snapshotCheckpoint` calls `findSymlinks(fromDir)` first and throws. Verified the finish-time candidate path: the throw is already caught, the run still writes its summary and exits normally, and the refusal now logs under `type: "manage"` rather than `warn` — no candidate to promote is a management fact. Tested with a real junction; the refusal lands before anything is created, and a source assertion pins the supervisor's log line. |
| **I3** verbsAllowed | `e022770` | `defaultVerbs` drops `restore` and `compare` when `pendingRuns` or `pendingBatches` is non-empty. `parallel: true` is documented in the tool description and the system prompt as a deliberate opt-in with its cost. Test: a live run's packet offers `continue`, `correct`, `escalate` and not the other two. |
| **I4** fresh packet | `ca49164` | `handleTrigger` re-assembles and decides once more, **only** on `stale_version`, bounded to one retry and to what is left of the driver budget (the second `decide` gets the remaining time). Two tests: stale → two packets, two ledger rows, two keys, the second executed; a precondition refusal → no retry, one call. Every refusal already reaches stderr through `serve`'s log, which writes the file and `console.error` together. |
| **I5** budget consumption | `4dfef7f` | The ended-trigger fold in `registerRunForTrigger` reads the run's `summary.json` and spends `wallSec` and `toolCalls` in the same save that removes the run from `activeRuns` — the one transition, so a re-fold cannot double-charge. `summary.toolCalls` is per agent, so the task's figure is their sum. Three tests: charges once, a re-fold does not, a missing summary charges nothing and writes the note. Docs updated so `used` reads as consumption. |
| **I6** one answer per trigger | `2795904` | (a) Every packet records `trigger.index`; `serve` reads `packets/` before answering and skips a trigger that already has one, whoever wrote it. With no explicit index the packet is about the last trigger of its kind, so `cmdPacket` needs no state write. (b) `claimCompareDir` creates `compares/<n>` with an exclusive `mkdirSync` and retries the id on `EEXIST`. Tests: the hand-packet-then-serve sequence from the review, the index rules, and the directory race. |
| **M1–M6** | `eb42926` | `correct.args.message` exempt from the `/acceptance/i` scan; findings as the fourth bounding rung (candidates, then the list); the whole-packet redact round trip guarded and refused by name; `cmdPacket` retries a `StaleVersion` registration once; a relative `playthrough:` criterion must stay under the repo root; the four doc drifts. |
| **I5 + I3, reconciled** | `1a8a118` | Two holes in the wave itself, below. |

## The ninth commit — what the first eight got wrong

**I5 was charging behind the fold, and most runs never fold.** `registerRunForTrigger` returns
early when `live === runs.includes(runId)`, and an ended trigger for a run that was never
registered matches that: a run only reaches the fold if it previously fired
`oracle_failed_repeatedly`, `budget_threshold` or `escalation`. All three of the first tests
registered the run with a live trigger first, so they passed while the review's own scenario —
six runs that end normally, nothing paused — still charged nothing. The charge now hangs off the
ended trigger itself and the ledger row that records it is the once-only guard, so a second ended
trigger for the same run (a `comparison_ready` naming it) charges nothing. Nothing to fold and
nothing to spend writes no task state at all, so a packet in flight is not invalidated for a
no-op. The new test is the ordinary-run case with `activeRuns: []`.

**I3 and `parallel: true` were contradicting each other.** `validateInstruction` checks
`verbsAllowed` before it reads any arg, and no caller on this branch passes an explicit
`verbsAllowed`, so after the prune a `restore` carrying `parallel: true` is refused
`verb_not_allowed` whatever it says — while both documents now taught the flag as the manager's
deliberate opt-in. That is the C1 defect over again: the prompt teaching what the code rejects,
in the same round that fixed C1. Resolved in favour of the ruling's prune: the flag stays as what
it demonstrably is, an operator's bypass for a hand-written instruction (`tools/manage.mjs
execute`, or a packet assembled with an explicit `verbsAllowed`), `liveWorkRefusal` says so where
it reads the flag, and the prompt and the tool description tell the manager the truth — the two
verbs are gone while work is in flight, answer with `correct` or `escalate`, they return in the
next packet. **I3 and the `parallel: true` documentation are reconciled**, which is what the
ruling asked for in one line.

Two smaller repairs in the same commit: the redact-guard test now keys on `bounded`, a field only
the final render carries (keyed on `packetId` it would have fired on any ledger row a future
fixture added), and `serve` exits 3 for a paused task as it already did for a held lock.

## Judgement calls

1. **I2 logs under `manage`, not `warn`, and I changed the supervisor's message.** The ruling said
   to verify the finish-time path catches the throw and "make it so" if not. It already caught it;
   what it did not do was say so in the stream a manage reader looks at. That is a one-line change
   to Task 2's file with its source assertion extended.
2. **I5 clamps instead of throwing.** `spendBudget` throws `BudgetExceeded`, which is right for a
   request and wrong for a measurement: a run that overran the task's ceiling is a fact that has
   already happened, and a throw there would take the ended trigger's packet down with it. The
   charge is clamped to what was left and the overrun is named in the ledger row.
3. **I5 leaves `usd` uncharged.** The ruling named `wallSec` and `toolCalls`. `usd` is still the
   one budget key nothing charges: the manager's own token counts are on every row
   (`manager.usage`) and no price table converts them yet. Said in `manage-1.md`.
4. **I5 distinguishes "no summary" from zero.** A run killed before `finish()` has an unknown
   cost, not a free one; it is charged nothing and the row says why.
5. **I4 retries only `stale_version`, and only once.** Every other refusal repeats by
   construction — a bad checkpoint syntax stays bad — so a retry would spend the pause twice for
   the same answer. The second `decide` inherits the remaining budget, never a fresh one.
6. **M5 applies containment to relative criteria only.** The exploit named is
   `playthrough:../../anything.js`, which is a climb. An absolute criterion names one exact file,
   which is a choice a human wrote out in full, and the existing evidence tests (and any
   out-of-tree playthrough harness) depend on it. Refusing absolute paths would have been a wider
   change than the finding, with test churn to match.
7. **M1 exempts `correct.args.message` and nothing else.** A sibling key on the same `correct` —
   `args.acceptance` — is still refused, and so is every arg of every other verb. The existing
   test that asserted the opposite for a message was updated, and its nested-and-renamed half was
   moved to a `restore` so the "rendered args, not a key list" property stays pinned.
8. **I6(a) records the index on every packet, including `comparison_ready` ones assembled by the
   batch child.** A run with no lifecycle file gets `index: null`, which `answeredTriggers` skips
   — a packet with no index marks nothing, which is the safe direction.
9. **I1's `serve` guard reports `refused: "task_paused"` and returns.** Under `--once` it returns
   immediately rather than polling, so a controller is told at once rather than watching a loop
   that will never answer anything.

10. **A run folded out by `settledRuns` is still uncharged.** A supervisor killed without an
    ended trigger leaves its entry to be folded by a later instruction's `settledRuns` pass, which
    does not read a summary and does not charge. The ruling named the ended-trigger fold, and that
    is what this implements; the killed-run case needs its own decision (charge from whatever
    summary exists, or record the cost as unknown) and is left for the next round.

## Not covered, and why

- **M4 has no test.** The retry fires on a lost compare-and-swap between two processes; the
  executor tests reach the same path through an injected `save`, and `cmdPacket` takes no such
  injection. The behaviour is one `catch` around one call.
- **The `serve` signal handlers** (round 1) are still untested, for the reason given there:
  killing a spawned loop needs either a network call or a `serve` that returns.
- **Item 8 of the review's untested list** (executor crash between the ledger row and the save)
  is unchanged: there is still no reconciliation pass, and this wave did not add one.
