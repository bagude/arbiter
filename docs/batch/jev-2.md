# Jev on the tester's expectations (2026-09-17)

Question: given only the specification and one assertion line, can Jev tell a wrong expected value from a right one? Every tester suite this harness produced had at least one expectation contradicting its stated rule (7 of 8 suites in the roster batches), and each costs an implementer round plus a tester resume. Tool: `tools/jev-tests.mjs`.

## Method

- **Sample.** Every captured workspace snapshot of the 18 pathnorm runs with capture (the source run and its forks): 361 snapshots, deduplicated to **261 unique assertion lines** — every assertion a tester ever wrote in those runs, including ones later corrected.
- **Ground truth.** Each suite run against the task's reference implementation (`tasks/pathnorm/oracle/reference.mjs`) through a recording assert shim that never throws, so every assertion gets its own pass/fail. **17 of 261 contradict the reference.** Fourteen are `relative` with the root or `.` as an operand, the trap the whole day's runs turned on; the rest are `basename` with `ext` equal to the name and one `dirname`.
- **Question.** State = the spec (4 KB) + the one assertion line. A truth value, "the expected value is exactly what the rules require", and a three-way choice correct / wrong / undetermined. ~215 ms per assertion, 261 calls.
- **Control.** A second pass with the tester's label argument stripped (the third argument of the eq helper often restates the misconception, e.g. "equals ext, left alone").

## Result

| pass | AUC | flag at noul < 0.5 | at < 0.7 | at < 0.8 | at < 0.9 |
|---|---|---|---|---|---|
| with labels | 0.898 | caught 3/17, false alarms 1/244 | 9 / 10 | 12 / 27 | 15 / 79 |
| labels stripped | 0.895 | caught 4/17, false alarms 2/244 | 11 / 29 | 14 / 60 | 17 / 79 |

(caught / false alarms; 244 correct assertions.)

- **As a ranking it works: AUC 0.90.** Sorting the suite by Jev's truth value puts most wrong expectations near the bottom.
- **As a gate at 0.5 it does not.** Jev is optimistic: wrong expectations sit at 0.4–0.85, correct ones at 0.7–1.0. The three-way verdict flagged 7, of which 5 were truly wrong (precision 0.71, recall 0.29).
- **The labels are not what it reads.** Stripping them moved nothing that matters.
- **The misses are the hard ones.** Expectations written as code, `["..", ""].join("/")`, and the root-relative cases where the spec itself is silent on what the segment list of `/` is (which is why the testers got them wrong too).

## What this buys

A tester that re-derives only its bottom-scoring 15% of assertions (the < 0.7 band, ~40 lines) would catch about two thirds of its wrong expectations for 40 × 0.2 s = 8 s of Jev and one short re-derivation pass, instead of the implementer discovering them one suite run later. That is a cheap invariant to add to the tester's turn: score each assertion, re-derive the low band from the quoted rule, report anything still undetermined. It does not replace the implementer's first suite run; it shortens the loop. Not yet wired in.

Where Jev is blind, the spec is too: a rule that never says what `relative("/", "/x")` is cannot be checked against itself. The right fix there is the audit's case 7 (name the degenerate inputs in the spec or the tester prompt), not a better judge.
