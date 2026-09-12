# Arbiter backlog

Observed but not planned. Recorded 2026-09-11 at the close of the orchestrator plan (`docs/superpowers/plans/2026-09-11-arbiter-orchestrator.md`). Recommended order: 1 → 2 → 4 → 3 → 5 — nothing else is measurable until the ruler exists, and the isolation gap is the one item that undermines every result.

## From our own runs (evidence-backed)

1. ~~**In-band path guard**~~ — **done 2026-09-11** (`ext/path-guard.ts` on pi's `tool_call` edge, rule in `lib/path-policy.mjs`, workers get a copy under `<workspace>/.pi/extensions/`; denies land in `lifecycle.jsonl` as `guard:path_denied`, audit type `path_denied`, `summary.guardDenies`; `npm run smoke:path-guard`). Background: the hidden oracle was never protected against an agent that looks — observed live in `runs/2026-09-11T20-14-14`. Remaining: the bash rule is syntactic (absolute paths, `..`, home/temp references); it constrains tool arguments, not what a process does — isolation is still the WSL2 sandbox (#19). Every run before this date is "unprotected" in that sense.
2. **Guards, split by where they belong.** Rule: *hooks decide; the supervisor measures and rules.* A check about one agent's own tool call goes on pi's `tool_call`/`tool_result` edge (earlier, cheaper, reaches workers); anything cross-agent, anything that needs authority the model's process cannot hold (oracle, approval gate, caps, wall-clock), and the ledger stay in the supervisor.
   - **2a. Guards as hooks** — `ext/guards/*.ts` + `lib/policies/*.mjs` on the path-guard pattern, with a small shared kit (deny-with-redirect, input rewrite, `guard:<name>_denied|_rewritten` report to the lifecycle file so the console/KPI count every guard alike). In value order: (i) ~~**bash-timeout injection**~~ — **done 2026-09-11** (`ext/guard-kit.ts` + `ext/guards/bash-timeout.ts` + `lib/policies/bash-timeout.mjs`; injects `caps.bashTimeoutSec` via `ARBITER_BASH_TIMEOUT_SEC`, clamps at 600 s; reports `guard:bash_timeout_rewritten`; `summary.guards` counts every guard by name/kind/role; `npm run smoke:guards`). The supervisor's `checkBashTimeout()` stays as the fallback — its `bash_timeout` audit count should now be zero in every run, which is the measurement. (ii) ~~probe dedupe into `ext/mail-ext.ts`~~ — **withdrawn 2026-09-11**: the dedupe is a by-product of the supervisor's result cache (args + src hash → prior result line); the extension never sees results, so an in-band copy could only block the all-repeats case one round trip earlier and never echo the prior answer. By the §2 rule a probe is a request to the ruler and deduping it is ruling — it stays in `runProbe`. (iii) **worker-read guard** (#6) — **parked**: the orbit run showed 6 partial reads across four agents, mostly `offset → end` on a 206-line file (sensible, not waste); the "30-line offsets" pattern was one Flash worker in the killed run. Build it only when a run shows it and #4 can measure it.
   - ~~**2b. Supervisor reducers**~~ — **done 2026-09-11**: `lib/workers.mjs` (lifecycle reducer + transcript binding, replayed against both real lifecycle files in `test/workers.test.mjs`), `lib/messages.mjs` (every `[SUPERVISOR]` text keyed by situation; dyad/solo pinned to their exact historical literals, orchestrator texts asserted role-free), `lib/transcript.mjs` (`buildSummary` + `renderTranscript` from fixtures). `supervisor.mjs` 1380 → 1115 lines; no behaviour change.
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

## From billion-context-pi (pi.dev/packages/billion-context-pi, v0.1.67)

21. **Context-edge guards** — the package hooks pi's `context` event (before every LLM call) and lets the model compress/decompress ranges of its own history, persisting state in a sidecar next to the session transcript; claims ~150–200K active tokens over billions cumulative. Same idea as our guards on a different edge: a policy on memory instead of on actions. Not needed by the orchestrator pattern (nobody's context grows), would have helped the dyad builder on orbit (1.1M fresh tokens re-reading history). Model-driven forgetting is a self-report confound unless its decisions are logged (they are) and measured with #4. If tried: load via `-e`/workspace copy like the guards, never a global install (workers would pick it up, parents would not).
    **Reviewed 2026-09-12 — not loaded.** The bundle self-updates by default (`npm install` of whatever the author publishes next, mid-run), ships its own subagent system, rewrites every tool result (200 KB cap), can block tool calls, drops thinking blocks and truncates at 95% on its own, and disables pi's compaction — five policies on three edges, unlogged. Instead, the piece with evidence behind it was rebuilt as our own guard: **`ext/guards/context-diet.ts`** (opt-in via `guards.context_diet`; drops prior-step thinking, ages large old tool results into stubs; reports counts). Measured by the paired configs `dyad-glob-local.json` vs `dyad-glob-local-diet.json` — **first pair (2026-09-12, 27B, 1500 s cap, N=1, both capped without success):** fresh input per assistant turn 13,947 → 6,303 (−55%); total fresh input 767K → 290K (−62%); cache reads 1.31M → 567K; probes 2 → 3; tool calls 49 → 40; turns 55 → 46; output tokens 109K → 142K (+30%); 489 thinking blocks dropped over 44 calls, 0 results aged (the glob files are under 1,500 chars). Reading: the diet cuts the cost of every step by more than half, but the model generated ~30% more output per run — plausibly re-reasoning what it can no longer see — which is why fewer turns fit in the same wall clock. Success-based comparison needs the 6000 s cap. Runs: `runs/2026-09-12T00-56-28` (baseline), `runs/2026-09-12T01-21-29` (diet). Not built: model-driven `compress` (self-report), the result cap (#2 above, cheap when a run shows the need), the repetition guard (#14 first as a count).

## Memory (built 2026-09-12 — first slice)

22. **Arbiter memory** — `memory/records.jsonl` (append-only; records + `promote`/`tombstone` ops, folded on read; committed) and `memory/<scope>.md` projections. RETAIN: the supervisor writes evidence-backed records at `finish()` for every run (episodic outcome with oracle scores; a procedural "delegation that passed" record on success); agents can send `kind="memory"` mail, stored as `source: agent` candidates. Governance: supervisor/oracle records auto-promote only with oracle evidence; a writer never promotes its own record; `node tools/memory.mjs promote|tombstone|list|retain|render|project`. RECALL: opt-in `"memory": true | { budgetChars }` — a budgeted, keyword-scored projection of promoted records for `global` + `task:<name>` appended to every role's prompt at launch; `summary.memory.injected` lists the ids. Off by default so paired runs stay comparable. Borrowed shapes: pi-memory (readable store), pi-persistent-intelligence (evidence + promotion + tombstones), pi-memctx (budgeted projection), path-memory (scopes). **First paired run (2026-09-12, orbit, 27B orchestrator, memory on vs `runs/2026-09-11T21-35-14`):** both SUCCESS 48/48 on the first claim; with memory the orchestrator reused the injected split exactly (stages 1–2 / 3–4 / 5), made fewer calls of its own (21 vs 32 tool calls, 9 vs 12 probes, 10 vs 20 mails) but the run was slower overall (1195 s vs 1086 s; first spawn 201 s vs 186 s; worker 1 took 310 s vs 143 s). N=1: no measurable benefit yet, and the split may simply be orbit's natural seam. Run: `runs/2026-09-12T02-53-04`. Retention then wrote a second, near-duplicate procedural record — consolidation (merge duplicates, keep the evidence union) is the next memory need. Next slices, each with a paired run: consolidation; per-turn retrieval on the `context` edge (the memctx gateway as a guard), semantic search only if keyword scoring proves insufficient, and the harness's own meta-graph (`gaps.json`, #15) as records with guard-digest evidence.

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
