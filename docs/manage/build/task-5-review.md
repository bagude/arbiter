# Task 5 review — the manager driver and the packet replay harness

Reviewed: `baba8cd`, `57130bf` (implementer) and `dbc16da` (controller) on `management`, range
`7dcd081..dbc16da`. Read-only; `npm test` run once; no network call, nothing touched on
`127.0.0.1:8080`. The `claude-api` skill was loaded offline to settle the request-shape and
model-id questions the report marked unverified.

**Spec compliance: ✅** for §3, §5 and §7 — the instruction is the contract object, it goes
through the same `executeInstruction` as a hand-written one, acceptance stays immutable, the
default is a zero-grant `continue` recorded as a row, and `replay` writes
`replays/<model>-<ts>.jsonl` scored per recorded packet. One §4 gap: the driver's decision
timeout has no headroom against the supervisor's (I-1).

**Code quality: needs fixes** — one Critical, four Important. The Critical and I-2 both mean the
first live manager would record a ledger of defaults rather than decisions, so both should land
before step 4 is run.

`npm test`: `ℹ tests 715 / ℹ pass 715 / ℹ fail 0`. Confirmed by running it, not taken from the
report (699 before, 16 new — the count and the delta both check out).

---

## Findings

### Critical

**C-1. `max_tokens: 1024` against a model whose thinking is on by default: the manager can hit
the cap before it emits the `instruct` call, and every packet silently defaults.**

`lib/manage/manager.mjs:32` sets `MAX_DECISION_TOKENS = 1024`, used at `manager.mjs:92`, and
`requestBody` sends no `thinking` and no `output_config` (`manager.mjs:89-98`). The comment at
line 31 justifies the number from the size of the *answer* ("a verb, a small args object and
≤ 500 characters of rationale"), which would be right if the answer were all that counted
against the cap.

The `claude-api` skill's thinking table is explicit that `claude-opus-5` "Runs **adaptive**
(thinking is on by default — unlike Opus 4.8/4.7)" when `thinking` is omitted, and that thinking
tokens are billed and counted like any other output. Its Common Pitfalls section names this exact
failure: "Don't lowball `max_tokens` — hitting the cap truncates output mid-thought."

Input → wrong outcome: any packet at the §2 size bound (≤ 32k tokens, with a failure pattern the
system prompt tells the manager to read before answering). The model thinks, crosses 1024 output
tokens, the response comes back `stop_reason: "max_tokens"` with no `tool_use` block, `toolUseOf`
returns null (`manager.mjs:218`), and `decide` defaults to `continue` with a zero grant. HTTP 200,
no error, a ledger row that says `no instruct call (stop_reason "max_tokens")`. The dataset §7
exists to build is then labelled by the harness, not by the manager, and the report's own success
criterion for step 4 ("record every packet and instruction") is met with nothing in it.

The implementer's stated Concern is that forced `tool_choice` is incompatible with thinking and
will 400. That is the wrong worry for this model — see I-2 — and it displaced the right one.

Minimal fix: raise `MAX_DECISION_TOKENS` to 4096 and change nothing else. The cap is the whole
bug. Do **not** reach for `output_config: { effort: "low" }` to hold the thinking down — §7 wants
the first live manager to be the most capable model available "so the dataset is labelled by good
decisions", and its opening line is that continue-vs-change-approach "requires reading the failure
pattern"; the skill's own guidance is a minimum of `high` for intelligence-sensitive work.
Omitting `output_config` runs the default `high`, which is what this should be. Do not send
`thinking: { type: "disabled" }` either: the skill documents two failure modes for that on Opus 5,
one of which is the model writing a tool call into visible text instead of a `tool_use` block —
which lands in exactly the same default.

Marked Critical because it is silent, it fires on the common case rather than an edge, and it
defeats the purpose of the task. Predicted from the skill's documented model behaviour, not
observed live — the first live packet's row settles it either way.

### Important

**I-1. The driver's decision timeout equals the supervisor's deadline, so a manager that answers
at all late is answering a pause that already closed.**

`lib/manage/manager.mjs:35` is `MANAGE_DECISION_TIMEOUT_MS` or 120 000. `supervisor.mjs:254-258`
is the same env var, else `manage.timeoutMs` from the config, else 120 000, and
`supervisor.mjs:1568` builds the pause from it. The supervisor's clock starts at
`managePause.open(kind, Date.now(), pending)` (`supervisor.mjs:1583`), the same instant the
lifecycle event the serve loop is watching for is written.

Everything the driver does sits inside that window and is not accounted for: up to `pollMs`
(2 000 ms, `manager.mjs:485`) to notice the event, packet assembly, `decide` itself, the
executor's control-file append, and then up to 2 000 ms more for `setInterval(pumpControl, 2000)`
(`supervisor.mjs:2506`) to read it. Worst case the default arrives at roughly T+124 s against a
deadline of T+120 s.

Input → wrong outcome: an `oracle_failed_repeatedly` pause and a manager that takes 118 s. The
supervisor has already defaulted and closed the pause, so `managePause.onControl` takes the
no-pause branch: the `decision` entry is logged and discarded (`lib/manage/pause.mjs`, the
`type === "decision"` arm), and the `correct` entry falls through to `out.deliver.push(...)` and
is handed to the orchestrator as a bare prompt — after the withheld verdict has already gone out.
§4 requires the verdict "delivered together with any `correct` message"; this is the two arriving
separately, in the wrong order, with the correction answering a question the orchestrator has
already moved past.

The two deadlines also cannot be aligned by configuration. Set the env var and they are identical
with zero headroom; set only `manage.timeoutMs` to 300 000 and the driver still defaults at
120 000, early and for no reason. The only safe setting today is a per-process env var that
`docs/batch/manage-1.md` §4 does not mention.

Minimal fix: give the driver its own budget derived from the supervisor's — default
`DEFAULT_TIMEOUT_MS` to a fraction (0.75 is ample) of the same 120 000, or read a separate
`MANAGE_DRIVER_TIMEOUT_MS` and document it in `manage-1.md` §4.

**I-2. Forced `tool_choice` is rejected outright on the Fable and Mythos family, and the driver
passes `--model` through unvalidated.**

`requestBody` always sends `tool_choice: { type: "tool", name: "instruct" }`
(`lib/manage/manager.mjs:96`), and `cmdDecide`/`cmdReplay`/`cmdServe` pass `flags.model` straight
down (`tools/manage.mjs:551,567,585`).

The `claude-api` skill settles the report's Concern in both directions. For `claude-opus-5`,
forced tool use is not restricted — the concern about thinking and forced tools does not apply,
and the default model is fine. For `claude-fable-5-1` and `claude-mythos-5-1` it is a documented
hard 400: "`tool_choice: {type: "any"}` and `{type: "tool", name: ...}` return a 400", on
`count_tokens` and Batches too.

Input → wrong outcome: `tools/manage.mjs serve <taskDir> --model claude-fable-5-1`, which is the
model this repo's own commit trailers name. Every packet 400s, `decide` defaults on each one
(`manager.mjs:211`), and the loop runs to completion writing a ledger of zero-grant `continue`s
with `manager.error` set. Nothing stops it and nothing says the model was the problem until
someone reads the rows.

Minimal fix: in `requestBody`, send `tool_choice: { type: "auto" }` plus a one-line "call the
`instruct` tool" instruction for model ids matching `/^claude-(fable|mythos)-/`, or refuse those
ids in `cmdDecide`/`cmdReplay`/`cmdServe` with a message naming the reason. The tool already has
`required: ["verb","args","rationale"]`; adding `strict: true` would keep the arguments
schema-valid under `auto`.

While there: the brief and the plan both name `claude-haiku-4-5-20251001` for the replay pass.
The skill's model table is unambiguous — "Use only the exact model ID strings from the table —
they are complete as-is; never append date suffixes" — and lists `claude-haiku-4-5`. Report
deviation 6 is correct, and `docs/batch/manage-1.md` §5 already uses the undated form. (This
session's own environment note gives the dated id; the skill is the authority the plan pointed
the implementer at, and it is the one the API validates against.)

**I-3. A restart between `execute` and the state write re-answers the trigger, and two serve
loops answer it simultaneously — both of which launch a `restore` or `compare` twice.**

`serve` writes the pointer after `handleTrigger` returns (`lib/manage/manager.mjs:513-514`), and
`serve.state.json` is read and written with no lock (`manager.mjs:436-443`).

The doc comment at `manager.mjs:479-481` says the re-answer is harmless because "the packet id
would collide anyway (`writePacket` creates exclusively)". That is not what happens.
`nextPacketId` is `max(existing) + 1` (`lib/manage/packet.mjs:133-142`), so a re-answer gets a
*fresh* id, `writePacket`'s `wx` flag never fires, and `fillInstruction` derives
`p<newId>-v<version>` — a different idempotency key for the same decision. The run is already
registered by then, so the state version has not moved to catch it either.

Two inputs → wrong outcome:

- Ctrl-C or a crash in the window between the executor returning and the pointer being written.
  On restart the trigger is answered again.
- An operator starts a second loop. The report itself says the live step "will need `--run`",
  which is exactly the invitation to run a second `serve` beside one already going. Both read the
  same `handled` count, both answer, two packets, two keys.

Either way a `restore` or a `compare` launches twice, against §3's "a `restore` or `compare` can
never launch twice". For `continue` with a zero grant it is only a duplicate row.

Minimal fix, and the direction matters: make the pointer advance *before* the executor rather
than after — write `state.handled` immediately after `writePacket` inside `handleTrigger`, so the
durable packet is the marker. A crash after that point then *skips* the trigger, and the
supervisor defaults it, which §4 already defines as the correct degradation. Skipping a decision
is the cheap failure; launching a batch twice is not. An `O_EXCL` lock file beside
`serve.state.json`, released on exit, closes the two-loop half.

**I-4. A thrown handler advances the pointer, and for a pausing trigger that costs the full
supervisor deadline.**

`manager.mjs:508-514`: the catch logs, and `state.handled` is set to `i + 1` regardless.

The brief asked whether skipping is right or whether it loses a pausing trigger that then
defaults in the supervisor. It loses it. `assemblePacket` is the throwing path (a run directory
that moved, a truncated record), and for `oracle_failed_repeatedly` or `escalation` the
orchestrator is blocked on a withheld delivery. Nothing will ever answer that packet, so the run
sits until `managePause.tick` fires at 120 s. With I-1 unfixed that is a 120 s stall per thrown
handler, not a graceful degrade, and the report's wording ("logged and its trigger pointer still
advances") understates it.

Not-retrying is still the right call — a retry loop on a permanently broken run directory is
worse. Minimal fix is to say so where it costs something: log the stall explicitly ("trigger N
skipped; the run will default after the supervisor's deadline") so the serve log names the 120 s
rather than leaving it to be inferred from a timestamp gap.

### Minor

**M-1. `readApiKey`'s `.env` regex keeps surrounding quotes.** `tools/manage.mjs:519` matches
`^ANTHROPIC_API_KEY=(\S+)`. A `.env` line written as `ANTHROPIC_API_KEY="sk-ant-..."` yields a key
with both quotes attached, which 401s, and the 401 arrives as a defaulted packet rather than as
an operator error. Fix: strip matching quotes from the capture. (The key itself is handled
correctly everywhere else — see the safety section below.)

**M-2. No retry on 429 or 529.** `decide` treats every non-2xx the same (`manager.mjs:209-211`).
One transient rate-limit answer burns the whole decision window on a packet a retry would have
answered. Writing against raw `fetch` rather than the SDK is what gives this up — the SDKs retry
408/409/429/5xx twice by default. Couple the fix to I-1: shrink the driver's timeout and one
retry fits inside the supervisor's deadline.

**M-3. `decide` discards `body.usage`, so §5's `manager: { model, ms, usd }` has no `usd`
source.** `manager.mjs:183` builds `{ model, ms, error? }` and the response body is dropped after
`toolUseOf` at line 218. `usd` is a declared budget key (`lib/manage/task-state.mjs:14`) and
nothing in `lib/manage/` charges it, so the manager's own spend is invisible and that budget can
never bind. Fix is one line: keep `usage` on the `manager` object so a later `usd` derivation has
something to read.

**M-4. `runTriggersName` re-reads and JSON-parses every run's `lifecycle.jsonl` on every tick.**
`manager.mjs:420` puts it in front of the memo, and the memo caches positives only — by design,
correctly reasoned in the comment above it, but that means every *non*-matching run is re-scanned
every 2 s. `triggerEvents` parses the whole file (`manager.mjs:431-432`). This repo's `runs/`
holds 184 directories and 1.7 MB of lifecycle files today, and both numbers only grow.
Commit `57130bf` exists precisely to stop this scan being repeated; `dbc16da` then added a
heavier check ahead of it. Against the 120 s window of I-1 it is currently noise, but it is the
wrong direction. Fix: memoise negatives keyed on the lifecycle file's `mtimeMs` and `size`.

**M-5. An event with no `kind` becomes a `run_ended_without_acceptance` trigger.**
`manager.mjs:454`. A malformed or future event silently acquires a trigger kind that changes
`verbsAllowed` and what the packet means. Refusing it (and letting I-4's skip path log it) is
more honest than guessing.

**M-6. `serve --once` with no trigger never returns.** `maxTicks` defaults to `Infinity`
(`manager.mjs:486`) and `once` is only checked inside the per-trigger loop (line 515), so `--once`
means "wait forever for exactly one trigger" with no deadline and no way to bound it from the
CLI. Defensible as intended, but a controller driving one decision by hand has no timeout.

**M-7. `agrees` ignores the checkpoint for `accept` although `decisionShape` records it.**
`manager.mjs:256` puts `checkpoint` on the shape for `restore`, `compare` *and* `accept`;
`manager.mjs:266` compares it for `restore` and `compare` only. Two `accept`s of different
checkpoints score as agreement. Harmless while `accept` is rare in the ledger, and the row still
carries both shapes, so a replay can be rescored.

**M-8. The `splitArgs` change has no test and applies to every existing command.**
`tools/manage.mjs:45-66`, deviation 4. The reasoning is right for `serve --once --model m`, but
there is no test anywhere in `test/` for `splitArgs` (grep: zero hits), and the new rule silently
converts any flag whose value begins with `--` into a switch *and* drops the value on the floor
as neither flag nor positional. No current command passes such a value, as the report says, so
this is about the missing pin rather than a live bug.

**M-9. The key-leak assertion at `test/manage-manager.test.mjs:168` does not bite.** It asserts
the key is absent from the instruction after a 400 whose body never contained the key, so it
passes with the `redact` call removed from `errorText` entirely. The redaction path is real and
correct (see below) but this test is not what verifies it. A body containing the key would make
it bite.

**M-10. A defaulted decision's recorded instruction is not exactly the §3 contract object.**
`defaultInstruction` attaches `defaulted` and `error` (`manager.mjs:134`), `handleTrigger`
strips only `manager` (`manager.mjs:465`), and `executeInstruction` records `instruction: instr`
verbatim (`lib/manage/instructions.mjs:790`). `validateInstruction` tolerates the extra fields —
it checks named fields and never rejects unknown ones — so nothing breaks, and the brief's own
interface spells out `defaulted: true` on the instruction. Flagged only because report deviation
1 claims "the recorded instruction stays exactly the contract object", which holds for a model
answer and not for a default.

---

## Safety of the API path — verified clean

I looked for the key on every path the brief names, and found none.

- It exists in exactly two places: `readApiKey` returns it (`tools/manage.mjs:514-523`) and
  `decide` puts it in one header (`manager.mjs:194`). `readApiKey` prints nothing;
  `requireApiKey` prints only the absence. `decide` never reads the environment, which is what
  makes the offline tests possible.
- No error string is built from the request. `manager.mjs:203` uses `err.message`,
  `manager.mjs:211` the response body text, `manager.mjs:215` the JSON parse error — the request
  object, its headers and `init` are never stringified anywhere.
- `errorText` (`manager.mjs:140`) runs `redact` then collapses whitespace then clips to 300. An
  Anthropic key would be caught by `redact`'s `sk-[A-Za-z0-9_-]{16,}` arm (`lib/jev.mjs:260`)
  even if a body somehow echoed it, and by the `KEY_WORDS` assignment arm in a JSON body.
- `serve`'s log writes only the lines `handleTrigger` composes plus `errorText(err.stack)`
  (`manager.mjs:490-494, 511`). `cmdDecide` prints the instruction and the `manager` object,
  neither of which holds it.
- A replay row carries no key-adjacent field but `error` (`manager.mjs:332`), which is the same
  `errorText`-redacted string, so the written `replays/*.jsonl` is covered by the clause above
  rather than by a separate path.
- The request body is the packet and nothing else (`manager.mjs:94`): no workspace path, no
  oracle, no transcript beyond what `assemblePacket` already bounded.
- Packet redaction survives into the request. `lib/manage/packet.mjs` redacts at extraction
  (lines 65, 76, 127) and again over the whole rendered packet (line 299) before it is written,
  and `decide` re-serialises the file as read. Nothing in the driver un-redacts or re-derives a
  field from a raw source.

Two other things the brief asked about are right:

- **Control-entry order.** `correct` is appended at `lib/manage/instructions.mjs:836` and
  `decision` at line 910. That order is what lets `pause.onControl` stash the correction and
  release it with the withheld verdict, per §4. Correct in the code, unpinned in the tests.
- **`handleTrigger` ignores `event.data.pauses`** (`manager.mjs:454` reads only `kind` and
  `detail`). That is right: the `decision` entry the executor writes is what releases the pause,
  so the driver has no reason to know it was paused.

---

## Report vs code

Every deviation the report lists is present as described, and the reasoning holds in all six:

| # | claim | verdict |
|---|---|---|
| 1 | `manager` is a ledger-row field, not an instruction field | present (`instructions.mjs:786-790`, `manager.mjs:465`); the "stays exactly the contract object" half is true for a model answer, not for a default — M-10 |
| 2 | `serve` cannot discover runs by the lifecycle event | **superseded by `dbc16da`**, which added `taskDir` to the event and `runTriggersName` to admission; the report predates it and the fix is the one it recommended |
| 3 | answered triggers are durable in `serve.state.json` | present, with the window and the concurrency hole of I-3 |
| 4 | `splitArgs` treats flag-then-flag as a switch | present; untested — M-8 |
| 5 | tests written after the implementation | true, and the bite check is the right one; see Untested below for what is still uncovered |
| 6 | `claude-haiku-4-5`, not the dated id | **correct, and now verified against the `claude-api` skill** — see I-2 |

The report's Concerns are accurate except the first, which is inverted: forced `tool_choice` is
fine on `claude-opus-5` and fatal on the Fable/Mythos family (I-2), and the real request-shape
risk is `max_tokens` against default-on thinking (C-1). The other four Concerns — the defaulted
`continue` being free only for a live run, nothing pruning `serve.state.json`/`serve.log`, the
thrown handler advancing the pointer, and replay scoring agreement rather than outcome quality —
are all accurate and correctly scoped.

Nothing is present that the report does not mention. `dbc16da`'s three-file change is the one
thing in the range the report could not have covered, and it is small, tested in both directions,
and its supervisor edit is a single field addition with its source assertion updated.

Hygiene: the three commits touch 7 distinct files, all under `lib/`, `tools/`, `test/`, `docs/`
and `supervisor.mjs`. Nothing under `memory/`, `runs/`, `tasks-live/`, `.superpowers/` or `.env`.
`docs/batch/manage-1.md` is honestly marked as a skeleton with every section flagged as not run.

---

## Untested behaviours

The 16 tests are behavioural rather than presence checks, and the bite check the report describes
is the right one. What has no test:

1. **`readApiKey`** — no test at all. Not the `.env` parse (M-1), not the env-var precedence, not
   that it prints nothing.
2. **`splitArgs`** — no test anywhere in the suite, before or after the change (M-8).
3. **The CLI subcommands.** Task 4 drove `accept`, `promote` and `list` through a real subprocess;
   `decide`, `replay` and `serve` have no equivalent. `--execute` and the exit codes are
   unexercised.
4. **Control-entry ordering.** `test/manage-manager.test.mjs:289-291` asserts the `correct` and
   `decision` entries both exist, never that `correct` comes first — and §4's "delivered together
   with the verdict" rests entirely on that order.
5. **A crash between execute and the pointer write, and two concurrent loops** (I-3). The
   "a second serve does not answer the same trigger twice" test at line 300 covers only the
   clean path.
6. **A throwing handler** (I-4). Nothing constructs a run directory that makes `assemblePacket`
   throw, so neither the log line nor the pointer advance is pinned.
7. **Multi-tick polling and the memo.** Every serve test passes `maxTicks: 1`, so the `sleep`
   path, the per-tick state re-read and `configCache` are never executed.
8. **`--once` with no trigger** (M-6) — nothing pins what it does when nothing arrives.
9. **Timeout headroom** (I-1). The timeout test uses 50 ms in isolation; nothing relates the
   driver's deadline to the supervisor's.
10. **`stop_reason: "max_tokens"` and `"refusal"` responses** (C-1). The no-tool-call test uses
    `end_turn`; both of the shapes a live Opus 5 call actually produces on failure are unmodelled.
11. **The redaction path in `errorText`** — M-9: the one assertion aimed at it passes without it.

---

# Re-review — fix round 1

Reviewed: `477fa92` and `2f82914` on `management` (range `dbc16da..2f82914`; `4239baa` in the
range is docs-only and out of scope). Read-only; `npm test` run once; no network, nothing on
`127.0.0.1:8080`.

**Verdict: all fifteen findings ADDRESSED as ruled** (M-6 left by ruling). The round is careful
work — every fix is the ruling rather than a reinterpretation of it, and the comments say *why*
rather than *what*. **Four new findings**, one Important and three Minor, and the Important one
lands squarely in the territory this round was fixing: a bare `--timeout` gives the driver a 1 ms
budget and every packet defaults, slipping past the guard written for exactly that.

`npm test`: `ℹ tests 736 / ℹ pass 736 / ℹ fail 0`. Confirmed by running it (715 before, 21 new).

## Round-1 findings

| finding | status | where |
|---|---|---|
| C-1 output cap vs default-on thinking | **ADDRESSED** | `lib/manage/manager.mjs:42` |
| I-1 no timeout headroom | **ADDRESSED** | `lib/manage/manager.mjs:50-72`, `tools/manage.mjs:562-574`, `docs/batch/manage-1.md` §4 |
| I-2 forced tool_choice on fable/mythos | **ADDRESSED** | `lib/manage/manager.mjs:46-48`, `tools/manage.mjs:543-558` |
| I-3 re-answer window and two loops | **ADDRESSED** | `lib/manage/manager.mjs:116-121, 123-179, 213`, `tools/manage.mjs` cmdServe |
| I-4 thrown handler's silent cost | **ADDRESSED** | `lib/manage/manager.mjs`, the two log lines in serve's catch |
| M-1 `.env` quotes | **ADDRESSED** | `tools/manage.mjs:516-531` |
| M-2 no retry on 429/529 | **ADDRESSED** | `lib/manage/manager.mjs:74-80` and the attempt loop in `decide` |
| M-3 `usage` discarded | **ADDRESSED** | `lib/manage/manager.mjs`, `manager({ usage: body?.usage ?? null })` |
| M-4 lifecycle re-scan every tick | **ADDRESSED** | `lib/manage/manager.mjs:59-95` |
| M-5 invented trigger kind | **ADDRESSED** | `lib/manage/manager.mjs:200-204` |
| M-6 `--once` waits forever | **not addressed, by ruling** | — |
| M-7 `agrees` ignored accept's checkpoint | **ADDRESSED** | `lib/manage/manager.mjs:345` |
| M-8 `splitArgs` unpinned | **ADDRESSED** | new test, six cases including flag-then-flag |
| M-9 vacuous key-leak assert | **ADDRESSED** | the 401 body now echoes the key and the test asserts `REDACTED`; it fails if `redact` is removed |
| M-10 report wording | **ADDRESSED** | report corrected |
| control-entry order | **ADDRESSED** | test asserts `correct` precedes `decision` by file position |
| `readApiKey` untested | **ADDRESSED** | env precedence, `.env`, quoted, lone quote, absent, `ARBITER_DOTENV`, CLI exit 2 |

Details worth recording on the four biggest:

**C-1.** 4096, and nothing about thinking or effort was added — which is the point. The comment at
`manager.mjs:31-41` now states the mechanism (thinking counts against `max_tokens`, the cap is hit
before the `instruct` block, the response is a 200 with no tool block), so the number cannot be
"tidied" back down by the next reader. A `stop_reason: "max_tokens"` response is modelled in a
test.

**I-1.** `supervisorDeadlineMs` reads the supervisor's own env var the same way `supervisor.mjs:254`
does, so the two agree by construction rather than by coincidence, and `driverTimeoutMs` is 0.75
of it. Both are pure over `env` and both are tested, including that the default is *strictly*
inside the supervisor's deadline. The `manage-1.md` §4 paragraph explains why the difference is
not slack, which is the part an operator would otherwise "fix".

**I-2.** Refused in both places and in the right order: `decide` returns the default before any
request is built, and the CLI exits 2 *before* `requireApiKey`, so a typo never reaches for a key.
The plan's dated haiku id is corrected with a parenthetical saying why
(`docs/superpowers/plans/2026-09-18-management-interface.md:396`). No `tool_choice: auto` fallback,
per the ruling.

**I-3.** `marked()` is called at `manager.mjs:213`, immediately after `writePacket` and before
`decide`. That is the direction that matters, and the comment at 189-197 gets the reasoning exactly
right, including the detail my round-1 finding turned on (`nextPacketId` is max + 1, so the
exclusive create never fires). The crash window the ruling asked about — between `writePacket` and
the pointer write — is now **benign**: nothing has executed at that point, so a restart re-answers
a trigger whose instruction never ran, and the only cost is an orphan packet file and a gap in the
numbering. The skip path marks the trigger too, so a permanently broken run directory is not
retried every two seconds.

## New findings

### Important

**N-1. A bare `--timeout` is read as a 1 ms budget, and every packet defaults.**

`tools/manage.mjs:566-574`. `splitArgs` yields `true` for a flag followed by another flag or by
nothing — pinned by this round's own new test (`splitArgs(["--trigger"])` gives
`{ trigger: true }`). `timeoutFlag` then does `Number(flags.timeout ?? "")`, and `Number(true)` is
`1`, which passes the `raw > 0` guard untouched.

Verified by running it, not inferred:

```
$ node -e '...splitArgs(["dir","--once","--timeout"])...'
{"once":true,"timeout":true} Number(flags.timeout)= 1 passes >0 guard: true
```

Input to wrong outcome: `tools/manage.mjs serve <taskDir> --once --timeout`, or any ordering that
leaves `--timeout` last or before another flag. `decide` gets `timeoutMs: 1`, `withTimeout` fires
on the first tick, and every packet comes back as a zero-grant `continue` with
`no manager answer within 1 ms`. This is C-1's and I-2's failure mode — a ledger labelled by the
harness — reached through the flag this round added to prevent mistimed budgets, and it slips past
the guard written for it: `--timeout 0` exits 2 (tested), `--timeout` alone does not.

Minimal fix, in `timeoutFlag`:

```js
if (flags.timeout != null && (typeof flags.timeout !== "string" || !(raw > 0))) { /* exit 2 */ }
```

Two siblings belong in the same fix, both Minor on their own. A bare `--model` yields the string
`"true"`, which `UNSUPPORTED_MODEL` does not match, so it reaches the API as a model id and 400s.
A bare `--run` puts the boolean `true` into `adopt`, and `runsForTask`'s closing filter calls
`path.join(runsDir, true)`, which throws a `TypeError` out of `serve` — loud rather than silent,
and the `finally` still releases the lock, but it is a stack trace where a usage error belongs.
A `typeof !== "string"` check on each of the three value-taking flags covers all of it.

### Minor

**N-2. Two loops can both take over one stale lock and both believe they hold it.**

`lib/manage/manager.mjs:151-167`. The takeover reads the owner, finds the pid dead, then unlinks —
with no check that the file it deletes is still the one it read.

Interleaving: A and B both fail `wx` with `EEXIST`, both read stale owner P, both find
`pidAlive(P)` false. A unlinks and its retry `wx` succeeds, so A holds the lock. B then unlinks —
deleting **A's** lock, not P's — and its own retry `wx` succeeds. Both loops now serve the same
task, which is the two-process double-launch the lock exists to prevent.

Narrow: it needs a stale lock on disk plus two loops starting within the same few milliseconds,
and the new signal handlers make a stale lock rarer than it was. Ranked Minor for reachability,
but the consequence class is the one §3 forbids absolutely, so it is worth the three lines: after
the takeover `wx` succeeds, re-read the file and confirm it names this pid; refuse if not.

**N-3. Windows pid reuse defeats the takeover, and `startedAt` is written but never read.**

`lib/manage/manager.mjs:127-135, 150`. To answer the ruling's question directly: liveness is
`process.kill(pid, 0)`, which does work on Windows — Node implements signal 0 there, a dead pid
raises `ESRCH`, and `pidAlive` correctly reads that as not-alive (treating `EPERM` as alive is also
right). The mechanism is sound.

The residual is pid recycling, which Windows does aggressively. The paths the new `SIGINT` /
`SIGTERM` / `exit` handlers do not cover — `taskkill /F`, an OOM kill, power loss — leave the lock
behind, and an unrelated process that later inherits the pid reads as the live owner. `serve` then
exits 3 for ever until someone deletes `serve.lock` by hand. Loud and recoverable rather than
silent, hence Minor. `startedAt` is already in the payload and is the field that would close it:
refuse a takeover only while the lock is younger than the supervisor's deadline, or compare it
against the owner process's own start time.

**N-4. `ARBITER_DOTENV` is documented only in a code comment.** `tools/manage.mjs:517-519`. It is a
new operator-visible env var and judgement call 4 argues for it on its own merits, which I agree
with — it belongs in `docs/batch/manage-1.md` §4 beside the two timeout variables, not only at its
definition.

## Judgement calls

All seven are sound. Three worth a sentence each:

1. **Transport errors not retried.** Correct. An `ECONNREFUSED` or a DNS failure is the one class a
   second identical request half a second later is least likely to answer, and the budget is
   better spent letting the default land while the supervisor's pause is still open.
2. **The lock released from the CLI rather than from `serve`.** The reasoning is right (`exit`
   handlers do not run on a signal, and Ctrl-C is how a loop is actually stopped) and the code is
   safe where it matters: `releaseServeLock` deletes only a lock naming this pid, so the refused
   loop's own `exit` handler cannot delete the live owner's. The double release on a signal
   (`process.exit(130)` re-entering the `exit` handler) is a no-op. `serve`'s own `finally` still
   covers the return and the throw, including the `once` return.
3. **`MIN_ATTEMPT_MS`.** Right, and the boundary test (a 400 ms budget with a 300 ms delay does not
   retry) is the one that makes it mean something.

To answer the ruling's third question: **the retry cannot push a late decision past the
supervisor's deadline.** `decide` computes `deadline = started + timeoutMs` once, and every attempt
takes `remaining` as both its race bound and its `AbortSignal.timeout`, so the whole call —
attempt, sleep, retry — is bounded by the 90 000 ms driver budget. That leaves 30 000 ms of the
supervisor's 120 000 ms for the 2 s poll, packet assembly, the control append and the supervisor's
own 2 s control poll. Comfortable.

## Still untested

The report's own three are accurate (the signal and exit handlers, `--timeout` end to end through
`replay`, multi-tick polling). Add: the bare-flag forms of `--timeout`, `--model` and `--run`
(N-1), and the lock takeover race (N-2), which is hard to exercise with two real processes but
cheap to pin at the `acquireServeLock` level with an injected pid.
