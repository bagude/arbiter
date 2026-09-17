# Jev on the done claim (2026-09-17)

Question: from the state the orchestrator sent its done claim from, can Jev predict what the hidden acceptance test will say? This is the judgment invariant at the tool edge: a `send_mail kind=done` that a cheap head says will fail is a claim the harness could hold back, or at least tag, before it burns one of five attempts. Tool: `tools/jev-done.mjs`.

## Method

- **Sample.** Every done claim with an oracle verdict in the captured runs: the six earlier pathnorm replay runs, the failing source run, and its fork replicates (claims from the fork's own points only). 17 claims: 6 passed, 11 failed. Pairing is by order through the audit's `[done]` mail lines, since decision and audit clocks have different zeroes.
- **State.** The captured provider request at the done decision, rendered as plain text (system prompt + messages; late states cut to the newest ~80% of messages to fit the ~32k-token window). Nothing about the verdict is in it.
- **Questions.** A truth value "the hidden acceptance test will pass on the current code"; a choice pass / edge (fails on an input the transcript never verified) / other; a truth value "every spec example and degenerate input was verified against the current code before this claim". ~400 ms per claim.

## Result

| | value |
|---|---|
| AUC of the pass truth value | 0.864 |
| flag at passes < 0.5 | caught 6 of 11 failing, 0 false alarms on 6 passing |
| verdict ≠ pass | 6 flagged, all 6 truly failing; every flag was `edge` |
| mean passes: failing vs passing claims | 0.42 vs 0.72 |
| "covered" truth value | AUC 0.65; failing 0.35 vs passing 0.49 |

The three-way verdict is the useful output: when Jev says `edge`, the claim failed, every time. When it says `pass` it is right 6 of 11 times, so a low pass value is a warning, not a verdict. The "covered" question is weaker, which says the transcript does not make coverage legible even to a reader that is looking for it.

**Caveats that matter.** Seventeen claims is small, and they are not independent: five of the failures are the source run's own repeated claims and six are its forks, all on the same missing case (`relative(".", "a")`); the six passes are from six distinct runs. The number to trust is the zero false alarms across six independent passing states plus the perfect precision of `edge`; the recall will move with more data.

## What this buys

A gate at the tool_call edge, `guard:done_check`: on a done mail, ask Jev the three questions (0.4 s, in parallel with nothing the model is waiting for); if the verdict is `edge` with confidence over a threshold, deliver "your claim is likely to fail on an unverified degenerate input; name the inputs you verified for each function, probe the ones you did not, then claim" instead of sending it to the oracle. On this sample it would have saved six of eleven failed attempts and delayed no passing claim. Not yet wired; the live shadow (`jev: true`) records these three answers at every inference from now on, so the sample grows for free.
