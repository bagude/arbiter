# Roster topology — design

Date: 2026-09-17. Status: approved in discussion, written for implementation. Follows the roster and specialist-memory slice (`docs/superpowers/specs/2026-09-16-roster-and-specialist-memory-design.md`) and the second pathnorm pair (`docs/batch/roster-pathnorm-pair-2.md`).

## Problem

The roster ships an intended order (scout, implementer, tester) that lives nowhere the orchestrator can act on: the Roster section lists specialists and says nothing about sequence. Six roster runs: the scout was never spawned; the tester always ran after the implementer, testing from the same brief the implementer built from, so it shared every omission of the orchestrator's paraphrase. On 2026-09-17 two roster runs failed the oracle on `relative(".", "a")`, a case the spec implies but never lists; the tester's 125 and 165 assertions did not contain it, because nothing had made anyone derive it.

Test-first changes what exists when the implementer starts: a small declarative artifact (the tests) that the orchestrator, which holds the spec, can review before any code is written. Reviewing thirty assertions for a missing case is within the 27B's reach; reviewing an implementation for the same omission has never happened in a run.

## Goals

- Specialists declare what they need and what they produce; the order is derived, not scripted.
- The orchestrator is told the order and the review rule in its stable prefix.
- A guard turns the rule into a nudge the orchestrator feels once, with a way to skip that leaves a record.
- Legacy runs (`use: ["worker"]`) are byte-for-byte unchanged.
- A pathnorm pair can measure it the same evening.

Non-goals: enforcing anything on workers; judging the *content* of a brief (the guard checks the workspace, not prose); persistent topologies across runs; more than one tester or implementer in flight (`workers.max` stays 1).

## Design

### 1. Roster frontmatter: `needs` and `produces`

Two optional keys, comma lists over a fixed vocabulary `ARTIFACTS = api, tests, code, map, review`:

```yaml
name: tester
needs: api
produces: tests
```

| specialist | needs | produces |
|---|---|---|
| scout | — | map |
| tester | api | tests |
| implementer | api, tests | code |
| worker | — | — |

`lib/roster.mjs` `parseRosterFile` validates every entry against `ARTIFACTS` (error names the file and the bad entry), defaults both to `[]`, and returns them on the specialist object. `renderDefinition` does not emit them (pi-subagents ignores unknown keys anyway, but the agent file stays as it is today). `selectSpecialists` additionally rejects a cycle among the selected set's produces→needs edges with a message naming the cycle.

Two kinds of need, by artifact:

- **workspace artifacts** (`tests`, `code`, `map`, `review`): satisfied by files on disk. This slice defines the check for `tests` only: at least one file under `src/__tests__/`. The others are declared for the order but not guard-checked (the guard treats an unknown check as satisfied and says so in its lifecycle line).
- **brief artifacts** (`api`): satisfied by the orchestrator's brief. Prompt-level only; the guard never inspects prose.

### 2. Derived order and the Roster section

`lib/roster.mjs` gains `rosterOrder(specs)`: a topological sort of the selected specialists over produces→needs edges, stable on the config's `use` order for ties. `rosterSection(specs)` renders, after today's per-specialist bullets and before today's trailer, one paragraph when any selected specialist declares a need. Text is generated from the declarations, never from the run, so the prefix is stable within a run:

```
Order for this roster: tester → implementer.
- tester needs the API from your brief (exports and signatures) and produces tests under src/__tests__/.
- implementer needs the API from your brief and tests under src/__tests__/; read the tests against the specification before you brief it, resume the tester for any obligation they miss, and name the test file in the brief.
```

The sentence templates per artifact live in one table in `roster.mjs` (artifact → "needs" phrase, "produces" phrase). The review sentence is attached to any specialist that needs `tests`. A roster with no declared needs renders exactly today's section (the legacy test at `test/orchestrator-prompt.test.mjs:21` keeps passing unchanged).

### 3. The `topology` guard

`ext/guards/topology.ts`, a thin adapter over a pure policy `lib/policies/topology-policy.mjs`, following `pre-spawn-compact.ts` and `lib/policies/*`.

**Configuration.** `guards.topology` in the run config: `"nudge"` | `"enforce"` | `{ mode }`; absent means off. `lib/config.mjs` adds it to the known guard names. The supervisor passes `ARBITER_TOPOLOGY` (JSON: `{ mode, needs: { <specialist>: [artifacts] } }`, built from `CONFIG.workers.specialists`) to every role; the guard returns early when unset. Only the orchestrator emits `subagent` calls, so only it is affected.

**State** (in-process, per orchestrator session): `lastTestsRead` (ms, the latest `read` whose `path` is under `src/__tests__/`, or a `bash` whose `command` mentions `src/__tests__`), and `denied: Set<"<specialist>:<failed>">`.

**On `tool_call` for tool `subagent`** with `input.subagent_type = S` and no `input.resume`:

1. If `S` declares no guard-checked need: pass.
2. If `input.prompt` starts with `topology: skip — ` (em dash or plain hyphen accepted): pass; emit `guard:topology_skipped` with the reason text (first line, 200 chars).
3. Evaluate each guard-checked need. For `tests`: `existsSync(<cwd>/src/__tests__)` with at least one regular file; and `lastTestsRead >= max mtime` of those files (the orchestrator read them after they were last written). Note: in the runs so far every spawn was foreground and `run_in_background` was never set, so "read after the tester wrote" is observable in tool_call order.
4. All satisfied: pass; no event (silence is the common case).
5. Otherwise the verdict is a denial with a reason that names the specialist, the failed check, and the next step, e.g.
   `topology: implementer needs tests, and src/__tests__/ has none. Spawn the tester first with the API (exports and signatures) from the specification, then read src/__tests__/*.test.mjs against the specification, resume the tester for anything missing, and retry this spawn. To proceed without tests, make the first line of the prompt "topology: skip — <reason>".`
   For the read check: `... tests exist but you have not read them since they were written. Read src/__tests__/ against the specification, then retry.`
   - mode `enforce`: deny; emit `guard:topology_denied`.
   - mode `nudge`: `denied` is keyed by `<S>:<failed check>`; if that key is absent: add it, deny, emit `guard:topology_denied`. Else pass and emit `guard:topology_waived` (a repeat of the same failure goes through; a different failure gets its own single nudge, so an implementer-first orchestrator is nudged once for missing tests and once more for unread tests — amended 2026-09-17 after the final review found the single per-specialist nudge was spent on `tests:missing` and the review nudge waived).

The pure policy takes `{ mode, needsFor, input, state, fs: { testsFiles: [{ mtimeMs }] } }` and returns `{ ok, reason?, event?, state' }` so the unit tests never touch a filesystem; the adapter supplies `fs` and the timestamps.

**Ordering.** pi's runner returns the first `block: true`, so `topology.ts` is inserted in `supervisor.mjs`'s `GUARDS` list immediately **before** `pre-spawn-compact.ts`. When both would deny, the orchestrator sees the topology reason, spawns the tester, and the compaction guard then judges that spawn on its own terms.

### 4. Roster prompt bodies

`roster/tester.md`: the module may not be implemented yet; write `src/__tests__/<module>.test.mjs` to the API in the brief; for every rule the brief states, add one assertion per degenerate input it applies to (empty string, a lone `.`, root `/`, a trailing separator, a non-string); run `node --test src/__tests__/` to confirm the file loads; failures against stubs are expected and are not findings; report `done` with the assertion count and the file path, `blocked` only when the file itself cannot load. Keep the "never edit outside `src/__tests__/`" and `remember` rules.

`roster/implementer.md`: add — if the brief names a test file under `src/__tests__/`, run it first, make it pass, and do not edit it; if a test contradicts the brief, say so in the report instead of changing the test.

`prompts/orchestrator.md` is not edited; the Roster section carries the rule.

### 5. Accounting

Events: `guard:topology_denied`, `guard:topology_waived`, `guard:topology_skipped`. `lib/workers.mjs` widens its guard regex from `(denied|rewritten)` to `(denied|rewritten|waived|skipped)`, so `summary.guards.topology` carries all three and the batch table and wiki guard pages see them. `context-trace` already renders any `guard:*` event.

### 6. Experiment

`configs/orch-pathnorm-27b-topology.json`: `use: ["tester", "implementer"]` (the scout stays in `roster/`, not in this arm; zero spawns in six runs), memory search with the widened budgets, `guards: { topology: "nudge" }`. Three runs, compared with the control (`orch-pathnorm-27b.json`) and the current roster+memory config.

| metric | why |
|---|---|
| first-try oracle pass | the outcome that decides wall time on this task |
| test file contains a `relative` case with a `.` operand | the mechanism marker, independent of the clock |
| `guards.topology` counts: denied / waived / skipped | did the nudge fire, and did the orchestrator comply or skip |
| wall, orchestrator output tokens | the cost of the extra round |

Report: `docs/batch/roster-topology.md`.

## Risks and rulings

- **The 27B writes a poor API.** It already writes signatures in every brief today; the tester's need is the same text. If briefs stop carrying signatures, the tester reports `blocked` and the orchestrator hears it.
- **The read check is gameable** (a `read` of the directory listing counts). Accepted: the aim is to make the review the path of least resistance, not to prove it happened. The trace shows what was read.
- **Nudge fires on a non-testable task.** The skip line is in the denial text; the reason is logged; enforce is opt-in.
- **Cost on level-1 tasks.** One extra spawn and a review round before any code. Expected to lose on runs that would have passed first try and to win on the four-of-nine that would not; the pair measures both.
- **Two guards on the same call.** Ruled by list order; documented in `supervisor.mjs` next to the list.
