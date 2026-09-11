# Arbiter backlog

Observed but not planned. Recorded 2026-09-11 at the close of the orchestrator plan (`docs/superpowers/plans/2026-09-11-arbiter-orchestrator.md`). Recommended order: 1 → 2 → 4 → 3 → 5 — nothing else is measurable until the ruler exists, and the isolation gap is the one item that undermines every result.

## From our own runs (evidence-backed)

1. ~~**In-band path guard**~~ — **done 2026-09-11** (`ext/path-guard.ts` on pi's `tool_call` edge, rule in `lib/path-policy.mjs`, workers get a copy under `<workspace>/.pi/extensions/`; denies land in `lifecycle.jsonl` as `guard:path_denied`, audit type `path_denied`, `summary.guardDenies`; `npm run smoke:path-guard`). Background: the hidden oracle was never protected against an agent that looks — observed live in `runs/2026-09-11T20-14-14`. Remaining: the bash rule is syntactic (absolute paths, `..`, home/temp references); it constrains tool arguments, not what a process does — isolation is still the WSL2 sandbox (#19). Every run before this date is "unprotected" in that sense.
2. **Guards extraction** — pull the model-free checks out of `supervisor.mjs` into `lib/guards/*.mjs` (probe-dedupe, silent-turn, bash-timeout, idle-nudge, approval gate, quiescence oracle), each unit-tested, each shipping its redirect message. The final review's three recommended extractions: `lib/workers.mjs` (pure lifecycle reducer + transcript binding — would have caught three fix-wave items), `lib/messages.mjs` (pattern-keyed `[SUPERVISOR]` strings, rendered and asserted like `mail-ext-render.test`), `lib/transcript.mjs` (delegation tree + summary builder).
3. **`tools/gaps.mjs` replay** — re-run existing `runs/*` through candidate guards offline; the first "would this rule have caught it" experiment. Feeds the meta-graph.
4. **`bench` matrix runner** — paired runs (same task, same config, guard on/off) with the KPI (`tools/kpi.mjs`); the ruler for every guard. Should accept LiveCodeBench problems as tasks (see GVS5H below).
5. **Worker watchdogs** — (a) "worker started but no transcript within N s" (an orchestrator blocked in a foreground `subagent` call is invisible to the idle nudge; the run is bounded only by `wallSec`); (b) a worker's bash cannot be aborted in the background flow (`get_subagent_result{wait:true}` only races the wait).
6. **Worker-read guard** (the shunt lesson) — workers spend 16–20 calls reading in 30-line offsets; whole-file read under N lines, grep-first over. Measure with #4.
7. **Worker identity join key** — FIFO binding of lifecycle id ↔ transcript basename is exact only at `maxConcurrent: 1`; a late transcript binds to the next worker at >1. Needs a pi-subagents change or a fingerprint at `started`.
8. **Detached run launcher** — `bin/arbiter-run` using `spawn(..., {detached: true, stdio: 'ignore'})` + pid file, so a controller's harness cannot reap a run (the first Flash run was killed by Claude Code's low-memory guard).
9. **`reportFailingInputs` wiring** — parse TAP `not ok` lines into the verdict when the flag is set. Spec'd, parsed, intentionally deferred.
10. **Nested-dir hygiene** — `hashDir` walks subdirs now; check the oracle copy, probe copy, and `extractRun`'s `ws-builder/src` reader with a nested layout.
11. **Paid-provider worker cost** — cost extraction from child transcripts only proven at $0.
12. **Failed-`subagent` detection** relies on the absence of an `Agent ID:` line (isError is false on "Model not found") — brittle against pi-subagents output changes; pin the package version or add a test fixture.

## From SpecPi

13. **Contract + frozen digest** — the rewriter may not rewrite itself: guards/prompts carry a digest; a run records which digest it ran under, so KPI deltas are attributable.
14. **Signature detectors** — canonical failure signatures (stall, probe-loop, silent turn, claim-without-probe, out-of-workspace path) as named, countable events in `audit.jsonl`.
15. **`gaps.json` meta-graph** — each detected gap → candidate guard → paired-run result; self-improvement gated by evidence, not by the model's self-report.

## From shunt (Spotify)

16. **Redirect-on-deny packaging** — every deny carries "do this instead"; the hook/script/skill triple as the shape for shipping a guard to a model.

## From GVS5H (github.com/slee-persis/GVS5H)

17. **External ruler** — LiveCodeBench-hard as a task source for #4 (their claim: 5× Qwen3.8-27B = 92.4% pass@1 vs Fable 5 90.4%, ~⅕ cost). Caveat: stdin/stdout single-file problems with cheap exact sample tests — transfers to our gate thesis, not directly to our repo-shaped tasks.
18. **Fresh-context workers + shared ledger vs persistent-context resumable workers** — a paired experiment. Our orchestrator never resumed a worker in run 0; it handed state forward in the brief text, which is halfway to their design already.

## From pi-sandbox

19. **WSL2 sandbox, phase two** — bubblewrap profiles bound via worker frontmatter `sandbox:`; native Windows is a no-go.

## From the context-engineering guidance

20. **Single path format + report format** — workers see mixed Windows/POSIX paths in bash; pick one. Worker reports are the orchestrator's only memory of a worker — cap and structure them (the bridge's 1500-char `cap()` is a start, not a format).

## Spec amendments (not code)

- The bridge cannot cap what reaches the orchestrator's context (§4 claim is false).
- No startup peer-range check; no scripted per-pattern live smoke.
- Audit `spawn` carries the description, not the full brief (the brief is in the timeline/transcript).
- `roles.worker.background` only sets the definition's default; the orchestrator's tool call overrides it per spawn.
- §9 placement-only isolation applies to workers and the orchestrator alike (see #1).

## Operational (user's side)

- Provider keys in `~/.pi/agent/auth.json` (`type: "api_key"`) for zai / openai / anthropic before spec §6 runs 2–4.
- Flash-Next run: restart the llama router with only Flash resident and ≥ ~12 GB RAM free before launching `configs/orch-orbit-flash.json`.
- The 9B download + 27B `ctx-size = 65536` before run 5.
