# Harness-text audit — run 2026-09-17T16-47-16 (pathnorm, test-first roster, 27B)

2026-09-17. One run read end to end (orchestrator 38 turns with reasoning, tester, implementer, audit/bus/lifecycle, five oracle results, the task's own files) for every place where text the HARNESS supplied misled an agent. Outcome of the run: five done attempts, 68/70 four times and 69/70 once, always `relative(".", "a")` (and `relative("a", ".")` on the first four). 222 563 tokens, 1 357 s.

Fixes are the minimal text or code change per case; none is a redesign. Cases are ranked by cost.

## 1. A truncated memory search row hid the exact fix, and the budget refused the full text — cost: the run

Orchestrator, turns 24–27 and 32–34. `memory_search` returned `m_8ed2e11cf03a · … Root cause in src/pathnorm.mjs relative(): const segs = (s) => (s` — rows are capped at 200 chars with the header eating most of it (`lib/memory-index.mjs:155`). The stored record continues: *"maps the normalised "." string to ["."] instead of []. Fix: treat "." the same as "/", i.e. segs(".") === []"* — literally the missing fix, for the model the orchestrator already held. It read the fragment as an indictment of the whole helper (*"the segs marker model was identified as the root cause"*) and abandoned the correct model. It never fetched the record: the ledger stood at 4 995 of 9 000 with 4 000 reserved for workers, so `memory_get` had already been refused (*"Work from what you already retrieved."*) and it computed ~5 chars left. At turn 15 it had the correct model and had fixed the `/` half unaided; this row moved it to a raw-split model (oracles 3–4) and then a third model (oracle 5, 69/70). ~19k decoded tokens.

Fix: (i) `lib/memory-index.mjs:155` — give the summary a floor (e.g. `Math.max(120, 200 - head - tail)`) so a row never truncates below the operative clause; (ii) `lib/memory-tools.mjs:40` — when a `memory_get` is refused for budget, name the ids it would have returned and allow a single-record fetch out of the worker reserve when no worker is running.

## 2. The silent-turn nudge delivered after a `done` mail — cost: 2 of the 5 done attempts

Orchestrator, turns 21→22 and 30→31. `lib/messages.mjs:33`: *"Your last turn produced text but called no tool, so nothing happened — no worker was briefed, no probe was run and no mail was sent."* Emitted (`supervisor.mjs:751`) for a text-only turn; it names no turn. Turn 20 was text-only → nudge delivered at 626.8 s → turn 21 sent `done` at 637.0 s → oracle #1 68/70 → the orchestrator read the nudge as "the supervisor says nothing happened" and re-sent → oracle #2 68/70 on byte-identical code. Same shape at 1157.8 s → oracles #3 and #4. Only three distinct code states were ever submitted against a 5-attempt budget; run #5 reached 69/70, so the two wasted claims were two more shots. The nudge also contradicts the tool's own text (`ext/mail-ext.ts:30`: *"the fix is always a fresh probe, never resending the same claim"*).

Fix: suppress the nudge when mail was sent after the triggering turn ended, or append "(If you have sent mail since, ignore this — it refers to an earlier turn.)".

## 3. The oracle verdict prescribes a method that cannot work — ~31.6k decoded tokens

`lib/messages.mjs:93`: *"Your done claim was wrong. Oracle run #1: 68/70 passed. Find what was missed with probes and brief a worker on the fix."* with `reportFailingInputs: false`. The orchestrator worked out, correctly, that probes report actual-vs-its-own-expectation and cannot reveal what the oracle wants (*"Probing gives me no new information about the code!"*), then guessed the reference's segment model twice. Turns 23, 24, 32: ~14% of the run's tokens.

Fix: when failing inputs are not disclosed, say so and prescribe what can work: "Re-derive the spec's under-specified corners — degenerate inputs (`""`, `.`, `/`, trailing separator) for each argument of each function — and brief a worker."

## 4. Probe dedupe described without the srcHash escape — ~11.6k tokens plus weakened coverage

`ext/mail-ext.ts` PROBE_HINT: *"A case whose exact args you already probed against this same, unchanged code is NOT re-executed"* and seeded memory `m_115346867929`. Both omit that the block lifts on a code change (`supervisor.mjs:1147`). The orchestrator ran two manual collision audits over 65- and 25-case probe bodies and replaced spec examples with near-variants (`dirname("../ab")` for `dirname("../a")`, `isAbsolute("x")` for `isAbsolute("")`) so several spec examples were never probed verbatim.

Fix: append "— a block lifts as soon as src/ changes."

## 5. The path guard blocks path-string data on a path-string task — killed the check that would have caught it

Tester turns 5–7 (13 denials), implementer (4 denials). `lib/path-policy.mjs:171/176` judges every fragment of a bash command; a `node -e` body containing the literals `".."`, `"/"`, `"/c/d"` trips it, and the remedy offered ("use a workspace-relative path") is meaningless since nothing was opened. The tester tried twice to run an independent 8-line re-derivation of `relative` against its expectations, was denied both times, and gave up (*"I'll re-derive these by hand instead"*); its hand derivation covered only the brief's cases. The implementer smuggled probe pairs through base64. The blocked command was the independent mechanical check the roster prompt asks for and the one that would have surfaced `segs(".")`.

Fix: in `judgeSegment` skip fragments inside a quoted `node -e` / `--input-type=module` script body.

## 6. The probe description omits the required `fn` field — drained 42% of the memory budget

PROBE_HINT: *"Body must be a JSON array of {"id": "...", "args": [...]} — one entry per call to the target function"*; the pathnorm probe runner requires `fn`. The orchestrator's first act after reading the roster was two searches and a get (3 790 of 9 000 chars, 76% of its own share) purely to recover the format — which is why case 1's fetch was refused. Two prior runs each stored a memory record about the same gap.

Fix: `{"id": "...", "fn": "<exported function name>", "args": [...]}`.

## 7. The tester's own prompt names the failing case, and a sibling clause lets it be dropped silently — the closest miss

`roster/tester.md`: *"for relative(from, to): relative(".", "a"), relative("a", "."), relative("", "a"), and so on"*, and two paragraphs later *"If a rule does not determine the value, leave that case out and name it in your findings rather than guess."* The tester wrote none of the three and named none in its findings. The orchestrator's brief displaced the standing instruction (*"Your brief below is your complete spec — there is no other source"*), and the orchestrator's roster blurb never says the tester carries a degenerate-input mandate, so it never checked for that output.

Fix: make the drop non-silent ("…and list it explicitly under findings as an undetermined case"), and add one clause to the roster blurb: the tester covers each argument's degenerate inputs and reports any it could not derive.

## 8. Roster prompt and brief disagree on the test runner

`roster/tester.md` says `node --test src/__tests__/`; the brief ordered a self-executing script run as `node src/__tests__/pathnorm.test.mjs`; `roster/implementer.md` says to run `node --test src/__tests__/`. A prior run recorded this (`m_01b90404382c`). Latent.

Fix: "run the suite the way the brief specifies", in both roster files.

## 9. Dyad-era workspace text, in two files

`tasks/pathnorm/ws-builder/README.md:5` (*"Your counterpart, `critic`, holds it and can only communicate by mail."*) and `src/pathnorm.mjs:3` (*"Your counterpart holds the specification. Ask them."*). Turn 2 reconciliation, plus an inoculation line in both worker briefs. ~1 turn.

Fix: "You do not have the specification; it comes from whoever briefs you." in both.

## 10. Kickoff names a subagent type the roster does not offer

`lib/messages.mjs:136`: *"start a worker with subagent_type "worker""*; the roster is tester + implementer. Two reconciliation passages, turns 4 and 6.

Fix: "start a worker (the subagent types your prompt's roster lists)".

## 11. Probe results hide actual values when an expectation matched

`supervisor.mjs:1225-1228` prints per-case values only for cases sent without `expect`. The orchestrator was shown `25/25 matched` and then re-read the source to confirm an error-message prefix the probe had verified.

Fix: include the actual line for matched `throws` cases.

## 12. Topology denial, minor

Fired once after a 3-line tester resume; one re-read of a 280-line file (~3.7k tokens). Could say how much changed since the read.

## (f) Why `relative(".", "a")` survived five attempts

It was never named by anything the orchestrator could read. The spec defines `relative` as lexical over normalised segment lists and never says what the segment list of `.` is; no `relative` example has `.` or `/` on either side; the reference returns `[]` for both, documented for neither. The tester's suite had `relative(".", ".")` and five root cases but never `.` against a name. All five probes put `.` on both sides or neither. The orchestrator considered the case twice in reasoning and waved it through without tracing the code, having already briefed the false premise that `.` never occurs after normalisation. The verdicts said only `68/70`, with an impossible remedy (case 3). Model C accidentally fixed `relative("a", ".")`, so oracle #5 scored 69/70 — and **that verdict was never delivered**: `audit.jsonl` shows `Oracle run #5: 69/70 passed.` with no `deliver <- oracle verdict` line before `FINISH: done attempts exhausted (5)`. The one verdict with directional signal never reached the agent.

Fix: deliver the final verdict before terminating on `doneAttempts`.

## (g) Mistimed deliveries

The silent-turn nudge after a `done` (case 2, twice); oracle #2 arriving in the same user block as a memory refusal while the orchestrator was reasoning about #1 (read as a re-send, so a consumed claim went unnoticed; same at #4); a nudge after turn 14 landing after turn 15 had acted; oracle #5 never delivered.

## (h) Tool descriptions and denial texts misread

| text | source | misread as |
|---|---|---|
| `{"id", "args"} … the target function` | PROBE_HINT | `fn` not required (case 6) |
| `already probed … is NOT re-executed` | PROBE_HINT | blocks are permanent (case 4) |
| `never resending the same claim` | `ext/mail-ext.ts:30` | contradicted by the nudge (case 2) |
| `expect … {"throws":"SyntaxError"}` | PROBE_HINT | unsure whether the prefix is checked (case 11) |
| `".." climbs out of the workspace` | `lib/path-policy.mjs:176` | sandbox policy rather than a false positive on string data (case 5) |
| `Find what was missed with probes` | `lib/messages.mjs:93` | an instruction proved impossible, then guessed (case 3) |

## What to do with it

Cases 1–4, 6, 9, 10, 11 and (f) are one- or two-line text or code changes; case 5 is a policy change in the path guard that needs its own test; case 7 is two sentences in the tester prompt and one in the roster blurb; case 8 is two sentences. Together they are one small plan, to run after the fork-runner branch closes. The run's decisions.jsonl and replay files remain valid for the decision-head work; this audit is about what the agents were told, not what they chose.
