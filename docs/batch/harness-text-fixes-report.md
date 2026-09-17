# Harness-text fixes — report

Branch `harness-text`, off `probe-match`, in `.worktrees/harness-text`. Twenty-three commits:
nine by case or natural group, three from the first two review rounds, nine from the code
review's five fix rounds, and two follow-ups. Suite green before
each commit. Final `npm test`: **480 pass, 0 fail**. The baseline on this branch was **466**, not the 467 the brief quoted.

Every case in `docs/batch/harness-text-audit-2026-09-17.md` is implemented: 1–12 and (f).
Three rulings were forced by what the code can observe, and three fixes reach one clause
further than their instruction; all are called out below under **Ruling** or **beyond your
wording**. The code review's findings C1, I1, M2 and M5 are addressed in round 1, and C2, C3 and M6
in round 2; see **Review fix round** and **Review fix round 2** at the end. Round 3 replaces the per-spelling patches with the
structural fix, round 4 extends it into template substitutions, and round 5 closes the loop
by refusing the construct — see **Review fix rounds 3–5**. Two follow-ups close the branch: **C5**, older and
wider than this work, and **C6**, a false positive the C5 fix introduced.

---

## Case 1 — truncated memory row, refused memory_get

**Commit** `45413ae` memory: a search row keeps its operative clause, and a refused get names its ids

**Files** `lib/memory-index.mjs`, `lib/memory-tools.mjs`, `test/memory-index.test.mjs`,
`test/memory-tools.test.mjs`

**1(i)** `formatRows` capped the whole row at 200 characters, so a long header left the
summary budget under 90 and cut it mid-expression. The summary now has a floor of 120
characters (`SUMMARY_FLOOR`) and the trailing `.slice(0, 200)` is gone, so a row runs past
200 rather than truncate below the operative clause. Dropping the outer slice is load
bearing: with it, a 120-char floor on a 91-char header would have chopped the summary back
to 109 characters and deleted the `· N ev · date` tail entirely.

**Test added** `formatRows floors the summary at 120 characters however long the header
is` — builds the audit's own record (header 91 chars, over the 80 the brief asked for),
asserts the header is genuinely long, that `instead of []` survives, that the evidence/date
tail is still present, and that the row exceeds 200.
**Test updated** `formatRows and formatRecords respect the character limits` — its
`length <= 200` assertion is kept with a comment saying why it still holds (those fixture
summaries are shorter than the floor, so nothing is padded).

**1(ii)** Two changes in `getTool`:

- A get refused for budget now names the records it would have returned, plus any ids that
  were not found, and says the ids stay valid for a worker brief. `refusal()` takes an
  optional closing `note`; the search refusal text is unchanged.
- When the full reply does not fit, the first record alone is tried against the same cap.
  If that still does not fit, a **single record** is charged against the whole budget
  rather than the orchestrator's share, via `reserveAllowance()`.

**Ruling — how the tool learns a worker is running.** It cannot, cheaply or otherwise.
`lib/memory-tools.mjs` is pure and runs inside whichever process made the call; its only
inputs are `readToolEnv(process.env)` (fixed at process start) and the run's ledger file.
The supervisor knows, but nothing it knows reaches this module. **So I implemented the
id-naming part and keyed the allowance on the reserve being untouched**, as instructed:
`spent(ledger).byRole` has no `worker*` key with a positive spend.

The allowance is additionally gated on the spend still being at or under `capFor(cfg,
role)`. That makes it self-closing: it is only reachable while the orchestrator is inside
its own share, and charging a record puts the spend past that share, so it fires once per
run and cannot be drained one record at a time.

**Test updated** `a worker reserve keeps part of the budget out of the orchestrator's
reach; workers may use all of it` — this one had to change, because it asserted the old
absolute rule. It now pins the new one: the first record past the cap goes through on the
untouched reserve, the second is refused and still says `reserved for workers`, and a
worker still spends past the orchestrator's cap afterwards.
**Tests added** `a get too wide for the budget falls back to its first record`; `a get
refused for budget names the ids it would have returned; a worker's spend closes the
reserve allowance`.

---

## Cases 2, 3, 10 — supervisor message texts

**Commit** `1dee758` messages: the nudge disclaims itself, the failed verdict prescribes a method that works, the kickoff stops naming a subagent type

**Files** `lib/messages.mjs`, `test/messages.test.mjs`

Orchestrator branches only. `lib/messages.mjs`'s own header and `test/messages.test.mjs`'s
both state that dyad and solo stay byte-identical, so neither was touched.

**Case 2 — Ruling: the ordering is not observable at the emit site, so the appended
sentence it is.** The nudge is emitted in `supervisor.mjs` on `message_end`, the moment the
text-only turn ends. `deliver()` sends it immediately with `streamingBehavior: "steer"`,
which lands it during the next turn. At the instant the decision is made, the mail that
would suppress it does not exist yet; there is no queue to re-check it against, and
deferring the nudge to a later boundary is a redesign, not a minimal fix. The orchestrator
copy now ends with `(If you have sent mail since, ignore this — it refers to an earlier
turn.)`. **Test updated** — the exact literal in `test("silent turn")`.

**Case 3** — `oracle.failedVerifier` (orchestrator branch) no longer says "Find what was
missed with probes". It states that the failing inputs are not disclosed and that a probe
only checks the code against the orchestrator's own expectation, then prescribes
re-deriving the specification's under-specified corners: for each argument of each
function, its degenerate inputs.

**Assumption, verified.** The non-disclosure is stated unconditionally. `messages(pattern)`
takes no config and threading `reportFailingInputs` through it would touch the signature and
every call site. It is also simply true: `reportFailingInputs` is parsed in
`lib/config.mjs` and recorded in the summary, but `supervisor.mjs` never reads it. The
verdict is always `pass/total` plus a validator's own `summary` string. **Test updated** —
the pinned literal in `test("oracle verdicts")`.

**Corrected in review** (commit `0ee067a`). The first wording was "Which inputs failed is
not disclosed", which is false for validator tasks: a validator's summary rides in the
verdict, and `tasks/dw-bronze/oracle/validate.mjs` appends `failing: <checks>` — which for
that task *are* the probe args. The text now reads "Beyond that verdict, nothing lists
which inputs failed", true in both oracle shapes with no per-task branching, and the
prescription is unchanged.

**Case 10** — `kickoff.orchestrator` now says `start a worker (the subagent types your
prompt's roster lists)`. **Test updated** — the pinned literal, plus a new
`doesNotMatch(/subagent_type/)`.

**Checked** `test/orchestrator-prompt.test.mjs`: it pins the `{{ROSTER}}` substitution and
`roster/worker.md`'s description, not the kickoff line. Unaffected; its header comment
already describes the kickoff sentence as removed from the prompt.

---

## Cases 4, 6 — PROBE_HINT

**Commit** `ae7a048` mail: the probe hint names the required fn field and says a block lifts on a code change

**File** `ext/mail-ext.ts`

**Case 6** — the body shape is now `{"id": "...", "fn": "<the exported function to call>",
"args": [...]}`. Wording note: the hint is one string shared by every task, and the probe
runners are not uniform — I surveyed all 34 `tasks/*/oracle/probe.mjs`. Most take
`{id, fn, args}` (pathnorm, csv, jsondiff, mdtable, intervals, orbit, decline, every raid
variant); several take `{id, args}` (duration, glob, dw-bronze, dw-gold, dw-silver,
review-guard, run-analysis); bucket and lru take `{id, script}`. So the hint says most
tasks' runners reject a case with no `fn` and a single-function task ignores it, rather
than claiming `fn` is universally required.

**Case 4** — the dedupe sentence now ends `— a block lifts as soon as src/ changes.`

**Pinned copies checked.** No test pins PROBE_HINT; the only other copy of the dedupe
language is `prompts/critic.md:12`, the dyad critic prompt, which the audit did not name.
**Left alone and flagged**: it has the same omission ("will not run again ... instead").
One clause would fix it if you want it in a follow-up.

---

## Case 5 — the path guard and `node -e`

**Commits** `88fec8c` (first version), `420373d` (narrowed to existence), `b570aa4` (the
oracle name rule)

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

**The rule, after two rounds of review.** A quoted string literal inside a
`node … -e|--eval|-p|--print "<body>"` invocation is DATA and is blanked, **unless** it
resolves against the workspace to somewhere out of bounds AND either something is really
there, or it names the hidden directory. Then it is refused. The code between literals is
blanked too; it is JavaScript, not paths.

- **Out of bounds** = outside the workspace, or under the supervisor-owned `.pi`.
- **Names the hidden directory** = contains `oracle`, or a `tasks` segment,
  case-insensitively. A literal that matches but resolves *inside* the workspace is still
  data, so `src/tasks/todo.json` passes.
- **Separator-only literals are always data**: `/`, `\`, `.`, `..`, `./`, `../`, and the
  backslash forms a JS source escape produces. Each resolves somewhere that exists — the
  filesystem root, the workspace's parent — while naming nothing, and they are exactly the
  degenerate inputs a path task is made of.
- **Env indirection and UNC prefixes are put back into the text** rather than blanked,
  because the checks that own them run on the whole segment, not per fragment. This closes
  a hole the first version opened: the shell expands `$HOME` inside a double-quoted body,
  and blanking had hidden it. `node -e "readFileSync('$HOME/x')"` is denied again.

`exists(path)` is an injectable option on `decidePath`, defaulting to a guarded
`fs.existsSync`.

**Why the name rule decides rather than merely exposing the literal.** I checked this before
choosing: `judgeSegment` deliberately reads a POSIX-absolute fragment that does not exist as
path-like data — the `/a/c` JSON-pointer case it was built for — so
`echo "/tasks/pathnorm/oracle"` is **allowed** today. Handing the literal back to it would
not have denied the concatenation. The existence branch still routes through the ordinary
resolve-and-compare, and reuses its wording ("climbs out of the workspace", "is outside the
workspace", "reaches the supervisor-owned .pi directory").

**Why masking still runs before the split, not inside `judgeSegment`.** `decideBash` splits
the command on `/&&|\|\||;|\|/`, which is not quote-aware. A realistic one-liner with a `;`
inside the body arrives at `judgeSegment` already shredded, with its quoting destroyed, and
no in-body span detection there can recover it. The audit's wording ("in `judgeSegment` skip
fragments inside a quoted body") would have passed a hand-written test and still denied the
tester's real command. The pinned test uses a body containing `;` for exactly this reason.
Masking preserves each span's length, so every fragment outside the body keeps its offset.

**Two clauses beyond the instructions**, both closing the same class of hole:

1. `.pi` counts as out of bounds (round 2). Your rule said outside the workspace only, but
   `.pi` is *inside* it, and `PROTECTED_IN_BASH` tests the whole segment rather than a
   fragment, so a blanked literal would have escaped both checks. You confirmed this one.
2. Env indirection and UNC are exposed (round 3), for the same segment-level reason.

**What the policy comment claims, and does not.** It guarantees that a literal spelling an
existing place outside the workspace, or anything under `.pi`, or the hidden directory by
name, is refused. It states plainly that **full runtime assembly still passes** —
`["..","tasks","pathnorm","oracle"].join("/")` is four literals that are each harmless
alone, and so are base64, an env lookup, or a name built a character at a time. Only a
sandbox closes that; a syntactic argument scanner cannot, and never could (the file's own
Scope note). Nor can it follow the spawned process once it runs. Existence is checked at
decision time against the real disk, so `"../x"` is data until something is at `../x` and
denied from then on.

**Test rewritten** `v3 bash: a node -e literal is data unless it names an existing place out
of bounds` — a real temp workspace with a real `../tasks/pathnorm/oracle/run.mjs` and a real
`.pi/agents/worker.md`.

- *Passing*: the tester's real command (a `;` in the body, `..`, `/`, `/c/d`), the
  `--input-type=module` form, `node -p`, all six degenerate literals, `../x`,
  `join("../a", "a/../b")`, `src/tasks/todo.json`, and the documented
  `["..","tasks","pathnorm","oracle"].join("/")`.
- *Denied*: the existing oracle file, the existing oracle directory,
  `.pi/agents/worker.md`, the concatenation in both spellings, a non-existent
  `/tasks/pathnorm/oracle`, a mixed-case `../TASKS/Pathnorm/Oracle/run.mjs`, a
  non-existent `../tasks/glob/oracle`, `cat ../secret`, a `..` after `&&`, a `cd ..`
  before the `node -e`, a redirect to `/c/Users/...`, and `grep -e "../../tasks"` (a `-e`
  that is not node's).
- *Existence, both ways*: `../sibling` passes, then the test creates the directory and the
  same literal is denied.

**Test added** `v3 bash: the node -e existence check is injectable and decides both
branches` — a literal the name rule does not reach (`../secrets`) passing with
`exists: () => false` and denied with an oracle that answers true for that one path; the
name rule denying under `exists: () => false`; and a degenerate literal surviving an
`exists` that says yes to everything.

**Checked by reason, not just by verdict**: the oracle-by-name denials name
`/tasks/pathnorm/oracle` with "is outside the workspace", the existing-file one names
`../tasks/pathnorm/oracle/run.mjs` with "climbs out of the workspace", the `.pi` one names
`.pi/agents/worker.md` with "supervisor-owned", and the `$HOME` one names `$HOME`. None
passes or fails incidentally.

**Verified against the pre-case-5 code**: the commands this allows were all denied by the
original `lib/path-policy.mjs` (fragments `..`, `/c/d`, `../a`, `../x`), so the test is not
vacuous.

**Residual sharp edge**: `/c/d` is a pathnorm degenerate input that the msys rule maps to
`C:\d`. On a machine where `C:\d` exists it would be judged as a path and denied. That
follows from the existence rule as specified; worth knowing, not worth special-casing.

---

## Cases 7, 8 — the tester and implementer prompts

**Commit** `061302f` roster: the tester's degenerate-input mandate is visible to the orchestrator and its drops are loud

**Files** `roster/tester.md`, `roster/implementer.md`, `test/roster.test.mjs`

**Case 7** — the drop is non-silent: "list it explicitly under findings as an undetermined
case, naming the call and the rule that ran out — never guess, and never drop it
silently", and the `findings:` bullet now leads with those cases and says what "no
findings" would mean. The orchestrator-facing blurb is `tester.md`'s frontmatter
`description`, which `rosterSection` renders verbatim, so the clause went there rather than
into `lib/roster.mjs` — that keeps the renderer generic. It gains: "It covers each
argument's degenerate inputs and names, under findings, every such case the brief did not
determine."

**Case 8** — `node --test src/__tests__/` is gone from both. The tester runs "the suite
once, the way the brief specifies"; the implementer runs it "first the way the brief
specifies (one bash call, explicit timeout)". Once/first semantics unchanged.

**Test added** `the shipped tester declares degenerate-input coverage, drops cases out
loud, and neither prompt pins a test command` — pins the description clause, the rendered
`rosterSection` line, both body clauses, and asserts neither body contains `node --test
src/__tests__`. No existing test pinned the real tester description (`test/roster.test.mjs`
uses its own fixture), so this is the first pin on it. The YAML-safety test that round-trips
every shipped description through pi-subagents still passes; the new clause contains no
double quotes.

---

## Case 9 — dyad-era workspace text

**Commit** `2e98f8c` tasks: the builder workspace stops naming a counterpart that may not exist

**Files** 12 `README.md` + 12 module headers, listed below.

**Which tasks carry the sentence** — all twelve, fixed identically: `bucket`, `csv`,
`duration`, `glob`, `intervals`, `jsondiff`, `lru`, `mdtable`, `pathnorm`, `semver`,
`tmpl`, `toposort`. Two modules carried the header twice (`csv.mjs`, `mdtable.mjs`); 26
replacements over 24 files, one line each.

**Why all twelve and not pathnorm alone.** I checked `configs/*.json` first, since under a
dyad run the old sentence is true and load-bearing. Only `dyad-glob-local.json` selects the
dyad pattern; every other config over these tasks is `orchestrator` (`duration` has no
config at all). The replacement is pattern-neutral — the critic briefs by mail in a dyad,
the orchestrator briefs a worker — so it is true in every case. For `glob`, which also has
a solo config, the mail-channel fact it loses here is still carried by its kickoff message
and by `send_mail`'s own tool description.

**Ruling — one clause beyond the audit's wording.** The same line continued "…a hidden
acceptance test that the supervisor runs once `critic` approves your work". Replacing only
the two sentences the audit quoted would have put `critic` straight back into the sentence
the fix removes, one clause later. That clause now reads "once the work is claimed done",
which is true in all three patterns. This is the one place I went past the literal scope;
it is a single phrase and trivially revertible if you disagree. `duration` had a different
ending ("when you declare done") and was left as it was.

**Side effect, checked, pre-existing.** Editing those files moves their seed snapshot id.
`supervisor.mjs:297` computes `snapshotId({ name: "seed:<task>", dir: <task>/ws-builder })`
when the task has no `ws-builder/data` directory, and none of the twelve has one, so all
twelve ids shift — which in `formatRows` would flag older records as `OTHER SNAPSHOT`.

It is not a regression I introduced. `lib/snapshot.mjs` hashes path, **size and mtime**, so
a seed id is checkout-local: `orbit`, which I never touched, already computes
`seed:orbit@0adb017ea0ad` in this worktree against the `seed:orbit@d7003e4d4e1a` stored on
60 of its memory records. `pathnorm` and `glob` are the only other tasks with stored seed
snapshots (2 and 6 records). Worth knowing if anyone depends on seed-snapshot continuity;
it does not hold across worktrees today, edits or no edits.

**Not touched, and why**: `tasks/decline/ws-builder/README.md:13` and
`tasks/intercom-review/ws-builder/README.md:5` carry different, genuinely dyad-specific
text (decline enumerates what the counterpart holds; intercom-review's whole task is the
dyad). Neither is the sentence in the audit, and both need their own judgement.

---

## Case 11 — probe results for matched `throws` cases

**Commit** `ebf3769` supervisor: probe results show the error a matched throws case actually threw

**Files** `supervisor.mjs`, `lib/probe-match.mjs`, `test/probe-match.test.mjs`

Per-case values were printed only for cases sent without `expect` (`withoutExpect`). A new
`matchedThrows` list collects matched cases whose expectation is the `{"throws": "..."}`
shape and prints them under their own heading, which also states that the expectation
checked only that the text *contains* what was named. Matched value cases stay out: for
those, the match is the value.

**Corrected in review** (commit `0ee067a`). Matched cases contributed nothing to a probe
reply before, so every line here is pure growth on a message that has a documented way of
ending a run. A 65-case probe body is real in the audited run, and `PROBE_VALUE_MAX` is
1500, so the first version would have allowed roughly 100KB of matched-throws lines. The
whole line is now capped at 300 characters and the list at 20, with a count of what was
elided — about 7KB worst case. This lands in `M.probe.autoResults` too, where the cases
come from a worker's report rather than from the orchestrator.

The shape test moved into `lib/probe-match.mjs` as an exported `isThrowsExpectation()` and
`matchCase` now uses it, so there is one definition of the shape and it is unit-testable.
The new lines are run through `truncateForMail`; the existing mismatch path leaves a raw
error untruncated, and this file has a live history of an untruncated echo blowing an
agent's context past recovery.

**Test added** `isThrowsExpectation picks out the throws shape and nothing else`, including
a cross-check that the predicate and `matchCase`'s own branch agree on every shape.
**Not covered**: the probe-result assembly is inline in `supervisor.mjs` and has no direct
test to update — the whole `runProbe` path is exercised only by live runs. The predicate is
pinned; the string assembly around it is verified by reading and `node --check` only.

---

## Case 12 — topology denial

**Commit** `8e2e300` topology: the unread denial says how much changed since the read

**Files** `lib/policies/topology-policy.mjs`, `test/topology-policy.test.mjs`

The `tests:unread` reason now carries how many of the files were written since the read and
how many seconds after that read the newest one landed. Bytes are not available: the ext
(`ext/guards/topology.ts`) hands the policy `{mtimeMs}` only, so this is the fallback the
brief allowed. `initialState()` sets `lastTestsRead: 0`, and the common case is
"written, never read" — that branch says "you have not read them at all" rather than
reporting a 56-year gap.

**Test updated** `tests exist but were not read since written…` — adds the new clause to
the pinned reason. **Test added** `tests never read at all: the denial says so instead of
timing from the epoch`. `test/topology-ext.test.mjs` matches a substring that is unchanged
and still passes.

---

## Case (f) — the final verdict on `doneAttempts`

**Commit** `37772ff` supervisor: the last oracle score survives the attempt cap

**File** `supervisor.mjs`

**Ruling: no inference follows, so the score goes into the finish reason and the summary.**
`finish()` writes `summary.json` and `transcript.md`, runs retention, then `killTree`s every
agent process. A `deliver()` immediately before it would push a prompt into a process about
to die — at best a wasted generation, at worst a race with the kill. So:

- the finish reason is now `done attempts exhausted (N); final oracle P/T passed`, which is
  `summary.reason`, the transcript's **Outcome** line and the `FINISH` row in the audit;
- an audit line records the verdict together with the fact that no agent received it:
  `Oracle run #N: P/T passed. Not delivered to any agent: the attempt cap (M) ends the run
  here.`

The reason text deliberately contains no colon: `lib/wiki.mjs:278` renders a run-index entry
as `String(reason).split(":")[0]`, and a colon would truncate it there. `startsWith("SUCCESS")`
— the only place the reason is classified (`lib/memory.mjs`, `tools/batch.mjs`) — is
unaffected.

---

## Review fix round (code review d02524e..b570aa4)

Four commits, one per finding. Suite green before each.

### C1 (Critical, case 5) — `42d0882`

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

The reviewer was right and the finding is serious: all three shapes were **regressions this
branch introduced**, not pre-existing gaps. I reproduced every one against both revisions
before touching anything — five exploit inputs plus an inner-escape variant, allowed on the
branch, denied at `d02524e`.

| shape | cause |
|---|---|
| `node -e "…readFileSync(\\"../oracle/run.mjs\\")"` | `BODY_STRING` had no `\"…\"` alternative |
| the same with `.pi/agents/worker.md` | same |
| `cat node -e "../oracle/run.mjs"` | `NODE_EVAL` not anchored to command position |
| `head -20 node -e "../../../secret.txt"` | same |
| `echo "node -e '" ; cat ../oracle/run.mjs ; echo "'"` | same — a fake body swallowed the real `cat` |

Applied the reviewer's fix: `NODE_EVAL` anchored to a command position with the exec-wrapper
allowance, `BODY_STRING` given a `\"…\"` alternative placed second so it wins over the plain
`"…"` form, and `judgeLiteral` reading `m[1] ?? m[2] ?? m[3] ?? m[4]`. `m[0].length` is
unchanged by both edits, so the span-length preservation the design rests on still holds.

**The wrapper allowance, confirmed load-bearing by measurement.** `d02524e` denies
`timeout 30 node -e '…segs("..")…'` on the fragment `..` — that is exactly the false positive
case 5 exists to remove, and `roster/implementer.md` tells a worker to test "always with an
explicit timeout". A bare anchor would have reintroduced it.

**On the reviewer's caveat**, that the new content group handles `\\` only: I took the
general form rather than pinning the limit. The content is any run of non-quote
non-backslash characters plus any backslash followed by a **non-quote**, which carries an
inner escape while still letting the closing `\"` end the literal. Pinned with
`readFileSync(\\"../oracle\\tmp/run.mjs\\")`, which the doubled-backslash form dropped back
into the blanked branch.

**Test added** `v3 bash: only a node in command position opens a body, and an escaped
literal is still a literal` — all five review inputs plus the inner-escape variant denied;
the six wrapper forms (`timeout 30`, `timeout -k 5 30`, `env FOO=1`, `nice`, `FOO=1`,
`cd src && timeout 30`) passing; `timeout ../oracle/run.mjs node -e "…"` denied on the
wrapper's own argument.

### I1 (Important, case (f)) — `d94ab8c`

**Files** `supervisor.mjs`, `test/supervisor-guards.test.mjs`

Confirmed: `tools/batch.mjs:47` and `tools/fork.mjs:372` both scan `audit.jsonl` with
`/Oracle run #\d+: (\d+\/\d+)/g` — global — so my line's repeated prefix put six scores in
the oracle column of a five-oracle run. Took the reviewer's wording. Verified by replaying
the scan over a simulated capped run: the column returns to
`68/70, 68/70, 68/70, 68/70, 69/70`.

Pinned in `test/supervisor-guards.test.mjs`, which already asserts against the supervisor's
source: the line must not carry the prefix, must not interpolate the verdict, must not match
the pattern the two tools scan with, and the verdict must still be logged as its own entry.

### M2 — `acc3bfb`

One clause in `lib/memory-index.mjs`'s `formatRows` comment: the summary is still capped at
`max(SUMMARY_FLOOR, 200 - head - tail)` and never exceeds 200 on its own, the **header** is
the part that is now unbounded, the worst realistic row is about 270 characters, and the run
budget is unaffected because rows are charged at delivery by length.

### M5 — `e8544ef`

One clause in `PROBE_HINT`: `tasks/bucket` and `tasks/lru` take `{id, script}`, a JS body
evaluated with the module's export in scope — no `fn` **and no `args`**, which neither the
old text nor my `fn` hedge covered. The hint now names that shape and points at the one
authority that is always right for the task in hand, the probe runner's own header comment.

### M1, M3, M4 — noted, no change

M1: the matched-throws bound is ~8 KB rather than the ~7 KB I wrote, because
`truncateForMail` appends its own ~100-character tail. The bound is real; only my number was
off. M3: a long-header search can now be refused where it was previously delivered and
truncated — accepted, and the refusal is informative as of case 1(ii). M4: case 12's
never-read clause reads as a self-correction; cosmetic.

---

## Review fix round 2 (re-review b570aa4..e8544ef)

Two commits, one per finding. Suite green before each. Both findings were real and both were
regressions the case-5 work introduced: I reproduced all twelve shapes against branch head
and against `d02524e` before touching anything, and every one was allowed at head and denied
at the baseline.

### C2 — `df548b7`

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

The largest hole in the case-5 work. `judgeLiteral` tested the literal's SOURCE text; node
opens its VALUE, after JavaScript decodes the escapes. Any escape that changes a character
defeated the name check and the existence check at once.

`decodeJs` now decodes the literal and both spellings are judged, the stricter verdict
winning. The collapsed source has to stay in, exactly as the reviewer said: the `"\\"`
degenerate input resolves, as raw source, to the drive root, which exists and is outside the
workspace, so judging the decoded value alone would deny a legitimate pathnorm case.

**Two shapes beyond the review's list, same family, which the proposed `decodeJs` would not
have closed:**

- **legacy octal** — `'../\157racle/run.mjs'`. `node -e` runs in sloppy mode, where `\157`
  is `o`. The proposed table would have mapped `\1` through its identity branch to `1`.
- **line continuation** — a backslash before a line terminator contributes nothing to the
  value.

Both are handled. Eight spellings are pinned denied, and the backslash degenerate input, the
separator-only literals, a tab escape, literal dollar text and a workspace path are pinned
passing.

### C3 and M6 — `0c05366`

The wrapper allowance accepted a bare word, which is a command NAME, so it handed the body
straight back to it — `cat -e` and `head -e` are real flags. Applied the reviewer's tightened
regex: an argument may be option-like, a duration or an assignment, nothing else.

The allowance itself stays and is still load-bearing, which I re-measured rather than assumed:
`d02524e` denies `timeout 30 node -e '…segs("..")…'` on the fragment `..`.

M6 was a one-liner, so I did it: the anchor accepts a backtick and the flag accepts a joined
`=`, so `node --eval="…"` and a backticked substitution are masked. ANSI-C quoting
(`node -e ` followed by `$` and a quoted body) is deliberately left unmasked and now says so in the comment — its
shell-level escapes are a second decoding layer the policy does not model, and leaving it
unmasked is a false positive, never an escape. Pinned as such.

---

## Review fix round 3 — the structural fix, per your ruling

**Commit** `69f4d26` path guard: a span the matcher does not recognise is judged, never erased

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

**The invariant, now stated in the policy comment.** A span the matcher does not recognise is
JUDGED, never erased. A code span is still blanked for the splitter's benefit, but every
path-ish fragment in it is judged first, over both its raw and its decoded spelling, with the
stricter verdict winning. The exemptions inside a body are unchanged: the separator-only
degenerate literals, and anything resolving inside the workspace under the existence and name
rules already ruled.

This ends a family rather than patching a spelling. C1 cause 2, C2 and the line-continuation
shape were three faces of one mistake — blanking an unrecognised span is fail-OPEN — and each
read the hidden oracle.

**A correction I owe you: the false positive was not a UNC prefix.** That was my
mis-description in the round-2 message, carried into your ruling. Measured: `UNC` never fires
on it. A bare `//` resolves to the drive root, which exists and is outside the workspace,
exactly as a lone `/` does — which is why `/` was already in `SEPARATOR_ONLY`.

So the fix is that existing exemption applied to the token that needed it: a run of
separators is separator-only. **No UNC shape rule was needed and none was added**, and no
fourth rule either — this sits inside the exemption your ruling already granted, which is why
I did not stop. If you would still rather have the UNC shape rule as belt and braces, say so;
it is not load-bearing for any case I can produce.

**Verified against branch head, all pinned:**

| set | result |
|---|---|
| five unrecognised-span shapes | all deny |
| twelve realistic one-liners, including the line comment that exposed this | all pass |
| C1, C2, C3 matrices | unchanged, all correct |
| six invocation forms (M6) | masking unchanged |
| full suite | 478 pass, 0 fail |

**Still passing, and meant to**, both now named in the policy comment: a path assembled at
runtime across several expressions, since no fragment of it names anything out of bounds on
its own; and ANSI-C quoting, left unmasked and therefore fail-closed.

---

## Review fix round 4 — template substitutions

**Commit** `5b531af` path guard: a template substitution does not hide a path

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

`BODY_STRING` matched a template literal whole, substitutions included, and handed it to
`judgeLiteral` as one path string. Three consequences, one cause: the braces glued onto the
following `..` so the span resolved back inside the workspace and both the existence and the
name rule fell through; a substitution that was the whole path was never judged on its own;
and a substitution placed inside the name split it, so no piece spelled anything out of
bounds.

Applied the review's fix. `CODE_FRAGMENT` excludes `$`, `{` and `}`, since a substitution's
braces are code punctuation rather than path characters. A literal containing `${` is routed
to the same code-span judging every other unrecognised span gets, and judged once more with
the substitutions elided, which is what closes a split name.

**One departure from the snippet, which closes a live shape.** The elided spelling is judged
in **both** spellings, as every other literal is, not raw only. A substitution splitting the
name AND an escape spelling one of its characters is one shape, not two:
``../ora${""}\u0063le/run.mjs`` reads the oracle otherwise, and was denied at `d02524e`.

T2, S1 and that combination are regressions this branch introduced. T1, T3 and S2 were allowed
at `d02524e` too, but the invariant now claims them, so they are pinned with the rest.

**Also pinned, as pre-existing rather than fixed:** review M7, where a substitution followed
by a separator reads as shell env indirection and is denied although it opens nothing.
Verified identical at `d02524e` and at head, so its status is recorded rather than drifting.

**Verified unchanged:** the twelve realistic one-liners, the five unrecognised-span shapes,
the C1, C2 and C3 matrices, and the six invocation forms.

---

## Review fix round 5 — the loop closes

**Commit** `4e7dd3d` path guard: a template substitution inside a node -e body is refused, not elided

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

**The ruling, and why it is the right shape.** Eliding `${…}` closed six shapes and left
three open, all of which spell `../oracle/run.mjs` and all of which were denied at
`d02524e`: `${[].join\`\`}`, where a backtick re-enters the template, and two nested-brace
spellings. A substitution is a nesting grammar, so any single-level pattern is fail-open
somewhere. Short of a JavaScript tokenizer, refusing the construct is the only rule that
fails closed, and a worker that needs interpolation in a one-liner can concatenate.

A template literal inside a `node -e` body containing `${` is now denied outright, with a
reason that names the remedy: *"Template substitutions are not judged inside a node -e body;
write the path as a plain string literal or build it outside -e."* Deliberately not
`deny()`'s `REDIRECT`, whose "use a workspace-relative path" is the wrong remedy when nothing
was opened and the path may be perfectly fine; `ext/path-guard.ts` already builds a verdict
this way for its read-only mounts.

The elision is gone. C4's `CODE_FRAGMENT` change stays, unrecognised spans still route to
`scanCodeSpan`, and plain literals are still judged in both spellings.

**Only a real template.** The rule keys on `BODY_STRING`'s backtick alternative. A quoted
`'${d}/x'` interpolates nothing, so its value is its source, which the ordinary judging
already handles correctly.

**The twelve one-liners: none uses a substitution, so none is affected.** Checked rather than
assumed — all twelve still pass.

**Pinned:** the three open shapes and T1–T4, S1, S2 all denied by the rule; the reason text
itself; plain templates, tagged templates and `String.raw` unchanged; a quoted `${…}`
unaffected. Also pinned as pre-existing and verified identical at `d02524e`: review M7, where
a `${…}` followed by a separator in **any** literal reads as shell env indirection and is
denied although it opens nothing. That one is recorded, not fixed.

**Known-open after this commit**, by design and stated in the policy comment:

- a path assembled at runtime across several expressions — base64, an env lookup, a joined
  array. No syntactic scanner reaches it; the sandbox does.
- ANSI-C quoting, `node -e $'…'`, left unmasked and therefore fail-closed. A false positive,
  never an escape.
- review M7, above: pre-existing, cosmetic in effect, denies a command that opens nothing.

---

## Follow-up C5 — a shell expansion glues onto the dot-dot

**Commit** `25f3225` path guard: a shell expansion does not glue the dot-dot away

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

**Not a case-5 regression, and wider than the mask.** A shell parameter expansion vanishes
before the command runs, so the guard reads text the runtime never sees and the leftover glues
onto the following `..`. The span then resolves back inside the workspace and falls through.
`cat "$q../oracle/run.mjs"` reads the oracle with **no `node -e` anywhere**. Reproduced at
both revisions before fixing: all eleven shapes are allowed at `d02524e` as well, so this has
been open since the guard shipped. It is the same mistake as a template substitution one layer
down — JavaScript punctuation absorbing the `..`, now shell punctuation doing it.

**Two halves, because the family has two**, both judging the spelling with expansions elided:
the construct, not the spelling, as in round 5.

- `judgeSegment`, which covers every bash command: a fragment whose elided form still climbs
  out or reaches `.pi` is denied.
- `judgeLiteral`, because a blanked literal never reaches `judgeSegment`: a literal carrying
  an expansion is refused when the body is **double-quoted**, the only place the shell
  expands. In a single-quoted body `$` is literal and there is nothing to do. `shellExpands`
  is threaded from `maskEvalBodies`, which already has the outer quote.

**Ordering is load-bearing in the second half.** `ENV_BARE` and `ENV_INDIRECTION` keep their
cases and their better fragment, so `node -e "readFileSync('$HOME/x')"` still denies naming
`$HOME` rather than the whole literal. Pinned.

| set | result |
|---|---|
| N1–N4, N6 and P1–P6 | all deny |
| the control `cat ../oracle/run.mjs` | still denies |
| **45 ordinary commands vs `d02524e`** | **0 verdict changes** |
| the twelve one-liners | unchanged |
| C1, C2, C4 and the round-5 matrices | unchanged |
| full suite | 480 pass, 0 fail |

The drift check matters more here than in earlier rounds: the first half sits in
`judgeSegment`, so it sees every bash command, not only a `node -e` body.

**Known and accepted (review M8).** A double-quoted body containing `$5`, `$#`, `$*` or
`${name}` now denies. In every one of those bash really does mangle the literal before node
sees it, so the worker's test was already silently broken — the denial is a true statement and
its message names the fix. Worth watching for `tasks/tmpl`, where `render('${name}', d)` is
exactly what a worker would write and would silently get an empty template today.
`node -e "console.log(/a$/.test('a'))"` is unaffected: a `$` before a non-name character is
not an expansion.

---

## Follow-up C6 — the expansion check's own false positive

**Commit** `52d4946` path guard: the expansion check skips a spelling that elides to a leading separator

**Files** `lib/path-policy.mjs`, `test/path-policy.test.mjs`

**Mine, from C5.** The elided spelling drops the variable *and its segment*, so when the
variable is the first thing in the fragment what is left begins with a separator and
`path.resolve` reads it as absolute — comparing a path the shell never builds.
`d=src; cat "$d/../README.md"` elides to `/../README.md`, resolves to `C:\README.md` and
denied, while the shell builds `<root>/README.md`.

That is review R9, documented in this very file and *"seen live in every dw-bronze run"*.
Denying work that opens nothing is the exact harm case 5 was opened for, so shipping a new
instance of it in the commit that closed the last bypass would have been the wrong trade.

**Why it slipped through.** The C5 commit's own false-positive tripwire list —
`echo $PATH`, `s=src; ls $s/`, the `for` loop, the trailing-`$` regex — had no case with a
`..` *after* the variable. The pins now do, in both separator spellings.

**The fix is one condition:** skip the elided check when the elided spelling begins with a
separator.

**What it costs, measured rather than asserted.** It stops the elision reaching an empty bound
expansion, `d=; cat "$d/../oracle/run.mjs"`. An empty expansion always leaves a leading
separator, so that spelling is always **absolute**: it can name something at the drive root,
never the workspace's sibling and never `.pi`, both of which need a relative `../` — which is
exactly the case the condition does not skip. Written directly,
`cat "/../oracle/run.mjs"` still denies, and that is pinned.

| set | result |
|---|---|
| B1–B4, both separator spellings | allowed again |
| B6 (variable not in the first segment) | never affected |
| B5 (`$d/../../../secret.txt`) | still denied, by the ordinary fragment rule |
| N1–N4, N6, P1–P6, both controls | still denied |
| 45 ordinary commands vs `d02524e` | still 0 verdict changes |
| twelve one-liners, C1, C2, C4, round-5 matrices | unchanged |
| full suite | 480 pass, 0 fail |

---

## Process notes

- Twenty-three commits, suite green before each. Nothing under `memory/` or `runs/` was staged;
  every `git add` named explicit paths.
- Line endings preserved throughout: every file in the tree is CRLF on disk with
  `core.autocrlf=true`, and `git diff --numstat` showed one-for-one line counts on every
  commit (24 files at `1 1` or `2 2` for case 9, for instance), never a whole-file rewrite.
- `npm test`: **466 → 480**, 0 fail. Fourteen tests added, six updated in place (none
  deleted): the memory-index row-limit test, the worker-reserve test, three pinned message
  literals, the topology unread reason, and the case 5 test, rewritten when the rule
  narrowed.
- No supervisor run, fork, or llama contact at any point. The only executions were
  `npm test`, `node --check`, `node --test <file>`, and six scratch scripts under `%TEMP%`:
  record sizing, the old-policy denial check, the case 9 replacement, two reason-by-reason
  checks of the path guard's denials, and the check of what `judgeSegment` does with a
  non-existent absolute path — which is what decided the design of the name rule.

## Open items, for you

1. `prompts/critic.md:12` repeats case 4's probe-dedupe omission for the dyad critic. Out
   of the audit's scope; one clause would fix it.
2. Case 5's remaining gap, by design and stated in the policy comment: a path assembled
   fully at runtime is not seen. `["..","tasks","pathnorm","oracle"].join("/")` passes,
   because each literal is harmless alone; so would base64 or an env lookup. The
   two-literal concatenation you asked about is now denied. Only a sandbox closes the rest.
3. Case 9's extra clause (`once the work is claimed done`) went past the audit's literal
   wording, as did two clauses in case 5 (`.pi` as out of bounds, which you confirmed, and
   exposing env-indirection and UNC literals). All three are called out in place.
4. The seeded memory record `m_115346867929` named in case 4 also omits the srcHash escape.
   It lives under a memory store, which I was told not to stage, so it is untouched.
5. Seed snapshot ids are mtime-based and therefore checkout-local (see case 9). Every
   stored `seed:*` record in `memory/records.jsonl` is already on a different id than this
   worktree computes. If seed-snapshot continuity is supposed to mean anything, hashing
   content instead of mtime would be the fix, and it is not part of this batch.
