# Fork runner — design (draft, not yet built)

Date: 2026-09-17. Status: design agreed in discussion; the build follows `docs/batch/decision-head-2.md`. Question it exists to answer: **when does another observation pay for itself before committing to an otherwise predictable action?**

## Why

The substantive decision head (`tools/decision-replay.mjs --substantive`) predicts the orchestrator's next state-changing action at 84%, and at 93% when confident. Its confident misses are five states of one shape: the head would resume or declare now, the recorded orchestrator probed or read once more first. The record cannot say which side was right, because both branches were never observed from the same state. The fork runner observes them.

## Inputs a fork restores

Every orchestrator inference in a captured run has (`ext/replay-capture.ts`):

- `runs/<id>/requests/NNNN.json` — the exact provider payload: system prompt, every message and tool result observed so far, tool schemas, sampler settings. **This is the canonical cognitive state.** The orchestrator in a fork is initialised from this body, never reconstructed from the session log; the log is a fallback and a cross-check.
- `runs/<id>/requests/NNNN-ws/` — the whole workspace (minus `.pi/`) at that instant, with a tree hash.
- `runs/<id>/decisions.jsonl` — the harness state at that point: workers spawned and completed, background spawns outstanding, probes sent, done attempts, pending replies.
- The workers' session files, for a fork at a point with a live worker (pi-subagents resumes by session id).

Restoration re-seeds the supervisor's own counters (probe number, done attempts, mail sequence, pending-reply state) from the record, installs the workspace snapshot into a fresh workspace, and starts the orchestrator with the captured payload as its history. Same server, same quant, same sampler settings as recorded.

## Branches

For a decision point where the record shows `gather → … → substantive action S` and the head confidently says `S` now:

- **G (gather)**: no intervention. The orchestrator continues from the restored state.
- **A-natural**: force only the *action class* the head chose. The model generates the action's parameters from the pre-gather state. This estimates the total value of the information the gather step would have produced.
- **A-oracle**: force the action class *and* the parameters the recorded orchestrator eventually used after gathering. A sensitivity test: holding the eventual action fixed, was the gather step still worth its cost? It leaks post-gather information by design and is labelled as such.

The forcing mechanism is a one-shot guard on the orchestrator's first `tool_call` after the fork: it rewrites the call to the chosen class's tool (and, for A-oracle, its recorded parameters), reports `guard:fork_forced`, and then registers nothing further. Everything after the first call is the model's own.

## Validation gates, before the twelve forks

1. **Null fork.** Restore several recorded states and intervene in nothing. The restored branch must reproduce the next recorded transition at the rate the sampler settings allow. If it cannot, no counterfactual from this runner is trustworthy. Run this first and report the reproduction rate.
2. **Whole-workspace snapshot.** Done (`ext/replay-capture.ts`): every file under the workspace except `.pi/`, which the path guard denies reads of anyway; tree hash recorded.
3. **Replicates.** The orchestrator runs at the model's default temperature, so one G against one A can be sampling noise. Three replicates per branch per fork, minimum, for the five frontier states. Report the spread, not just the means.

## Measurements per fork and branch

- final oracle score, and whether the first oracle attempt passed
- number of subsequent probes; number of worker resumes / repair rounds
- decode tokens and wall time to completion
- whether the eventual substantive action differed from the record (class), and whether its parameters differed
- whether information produced by the gather step (in G) is referenced later: search the later briefs and mails for content that first appeared in that gather step's tool result
- the causal chain of each branch (`lib/causal-links.mjs`), for reading, not for scoring

## The twelve candidates

From `docs/batch/decision-head-1.md` and `-2.md`, on the six captured pathnorm runs: the five frontier states (probe-vs-resume 14-27-08 #7, #8, 14-43-22 #8; done-vs-probe 14-27-08 #19; probe-vs-done 14-43-22 #18) and the seven horizon-only misses where the head named the next substantive action one read early (14-09-17 #4, 14-14-08 #5, 14-23-08 #5, #7, 14-51-39 #4, #15, 14-43-22 #13).

## Non-goals

Forking worker decisions; forking across server restarts or model changes; any conclusion from a single replicate.
