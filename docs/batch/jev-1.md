# Jev as a shadow decision head — first replay (2026-09-17)

TypeSafe.ai's Jev (a "System One" model: typed questions against a plain-text state, answers as a choice with a probability per option and a confidence, no text) put in front of the same recorded orchestrator decision points our local 27B head was scored on (`docs/batch/decision-head-1.md`, `-2.md`). Code: `lib/jev.mjs`, `ext/jev-shadow.ts` (live, fire-and-forget at every orchestrator inference), `tools/jev-replay.mjs` (offline over `runs/<id>/requests/`). Rows in `runs/<id>/decisions-jev.jsonl`.

## The API, measured

- `POST /v1/systemone`, Bearer key, one state + several questions per call. 230–330 ms per point regardless of state size; the 27B head takes ~2.4 s, the generative orchestrator ~25 s.
- Input limit: ~30k tokens accepted, ~33k refused with a clean 400 (`max_tokens_exceeded`), nothing silently truncated. Late states of a long run exceed it, so the renderer keeps the system prompt and drops the oldest messages until it fits; on the failing run the last ~15 points were cut to ~82% of their messages. `jev-1.13.0` answered every call.
- Same four questions as the local head, same class descriptions: literal next action over the valid mask, next substantive action over spawn/resume/collect/probe/done, gather vs act, and a reply-outstanding truth value.

## Results

| sample | points | Jev literal | 27B literal | Jev substantive | 27B substantive | heads agree (substantive) | Jev ms |
|---|---|---|---|---|---|---|---|
| six earlier pathnorm runs | 102 (75 substantive) | 58% | 66% | 54/75 = 72% | 59/75 = 79% | 68/75 = 91% | ~250 |
| failing run 16-47-16 | 38 (32) | 45% | 71% | 15/32 = 47% | 21/32 = 66% | 26/32 = 81% | 323 |

Per run, substantive (27B / Jev / heads agree): 14-09-17 5/7, 5/7, 7/7 · 14-14-08 12/14, 12/14, 14/14 · 14-23-08 5/6, 5/6, 6/6 · 14-27-08 13/18, 9/18, 14/18 · 14-43-22 15/17, 14/17, 16/17 · 14-51-39 9/13, 9/13, 11/13.

Gather-vs-act: Jev 56–90% per run (68% on the failing run; 27B 74%). Pending-reply truth value at 0.5: 50–82%.

## What it says

1. **Jev is a slightly weaker predictor of this orchestrator than the 27B head, and a much cheaper one.** Seven points of substantive agreement on the six runs, ten times faster, and it never saw the tool schemas or the chat template the 27B head shares with the orchestrator.
2. **The two heads are the same head.** They agree with each other far more often (81–91%) than either agrees with the record, and they disagree with the record on the same points: both say **probe** at every one of the failing run's wrong done claims (calls 20/21, 29/30, 36/37) and where the orchestrator resumed after memory searches (23/24). Two very different models, given the same state, make the same call the orchestrator did not. That is evidence the disagreement is a property of the state, not of the head.
3. **Where Jev is weak is resume.** On the failing run it picks spawn or probe at low confidence where the orchestrator resumed the tester (8 of 10 resume points); the 27B gets those. A resume is the choice that most depends on remembering what the worker already did, which is exactly what the window cut and a text render lose.
4. **Jev's confidence is honest where the 27B's mode B was not.** On the failing run, conf ≥ 0.9 covers 18% of points at 86% agreement (one false-confident case); over the six runs, five confident-and-wrong in 102. The 27B's thinking mode reached 0.98 mean confidence with no gain in accuracy (`decision-head-1.md`).

## Where this goes

The live shadow (`jev: true` in a config) writes the same rows for every future run at zero cost to the run, so the sample grows without replays. The hybrid the decision-head work pointed at — a cheap head picks the action class when confident, the generative model fills parameters, generation only on the residual — has a candidate for the cheap head that costs 0.3 s and no local compute. Its gate would be conf ≥ 0.9 (18–25% coverage today) rather than the 27B's p ≥ 0.95 (58–69%), unless the resume weakness is fixed by giving it the worker ledger as structured text instead of the raw transcript.

The four uses in order: this shadow (done as measurement; gate not yet flipped) → the tester's expectations (a per-assertion truth value "this expected value follows from the rule quoted", scored against the oracle) → judgment invariants at the tool_call edge ("this brief names the test file", "this done claim cites a probe covering the spec examples") → memory-row re-ranking.
