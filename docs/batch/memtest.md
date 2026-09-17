# memtest — does specialist memory retrieval actually work?

2026-09-17. Two runs of `configs/orch-memtest-27b.json` on the 27B, one `implementer`, memory mode `search`, fixture store at `tasks/memtest/store` (the real ledger is never touched).

## What the test does

`canary()` must return a token that exists in exactly two places on disk: the hidden oracle, and the **body** of one `agent:implementer` memory record. It is absent from `spec.md`, from the workspace `README.md` and `src/`, and from every record **summary** — so the seeded brief, which renders summaries into the system prompt, cannot leak it. Finding the search row is not enough; only a `memory_get` reveals it. The token is high-entropy and the oracle asserts exact equality, so a guess cannot pass (verified: correct token 3/3, decoy 2/3, stub fails).

A decoy token sits in `agent:tester`, a scope this config does not select — the negative control for scope filtering.

The orchestrator holds the same memory tools and the same scopes, so it cannot be prevented from doing the lookup itself without a code change. The spec asks it plainly not to, and the lifecycle records which agent made each call, so the result is informative either way.

| run | outcome | oracle | wall | tool calls | probes | done |
|---|---|---|---|---|---|---|
| 2026-09-17T00-45-51 | CAP: tool calls 120 | — | 529.9 s | 120 | 79 | 0 |
| 2026-09-17T00-58-19 | SUCCESS | 3/3 | 49.5 s | 19 | 1 | 1 |

## Result: retrieval works, on both runs

| check | run 1 | run 2 |
|---|---|---|
| retrieval done by the **worker**, not the orchestrator | 2 search + 2 get, worker role | 2 search + 2 get, worker roles; **zero** orchestrator memory calls |
| correct token in `canary()` | yes, from probe 1 onward | yes |
| decoy (out-of-scope `agent:tester`) never appeared | yes | yes |
| path guard held (token came from memory, not from reading the oracle file) | 3 denials | 1 denial |
| `remember` written, correctly scoped | 1 line → `agent:implementer` | 1 line → `agent:implementer` |
| retention filed it; real ledger untouched | yes; 0 memtest records in `memory/records.jsonl` | yes |
| oracle pass | never ran (capped) | **3/3** |

Run 2's seeded brief contained **zero** records (`injected: []`), which closes the last leak path: the token could not have arrived through the prompt. Every byte of it came through a tool call.

The worker's own remembered lesson, run 2: *"memory_search("canary token") surfaced row m_d54634c011a6 whose summary deliberately omits the token; memory_get on that id returns the record body containing the exact token to return."* That is the correct lesson, unprompted.

## Cross-run retrieval

Run 2 searched `"earlier memtest run lesson"` and fetched two run-1 candidates (`m_14802ec9c322`, `m_41503873316e`), so candidates written by one run are reachable by the next. That much is measured directly from run 2's lifecycle.

Run 1's `agent:implementer` lesson (`m_02825dab78bf`) ranked **second** for that same query — but measured against the *current* 16-record index, not the run-1-only revision run 2 actually searched. So read it as "in scope and well-ranked," not as a reconstruction of what run 2 saw. Either way the worker chose to fetch two other rows, which is worker judgment rather than a retrieval failure.

## Run 1 capped on a defect in the test harness, not in memory

The probe runner I wrote for this task had two bugs, both mine:

1. A heredoc collapsed the `\\` in the Windows path normaliser to `\`, leaving an unterminated regex. Every probe crashed with a `SyntaxError`.
2. It required an `fn` field, but the orchestrator sends `{id, args}` when a task has only one function.

So every probe returned no parseable result, the done gate correctly refused a claim with no successful probe, and the orchestrator retried until the tool-call cap — reasonable behaviour throughout. Fixed in `74c5452`; the runner is now exercised against the exact payload the orchestrator actually sent, plus a named `fn`, a wrong `fn`, and the unimplemented stub.

**Process lesson:** I verified the oracle discriminated before running, but not the probe runner. Both are host-side code an agent cannot fix; both deserve a dry run.

## A memory-hygiene event, on run 1

The orchestrator wrote candidates correctly diagnosing the probe bug, down to the line number. Once fixed, those records were false. They were tombstoned with the reason naming the fixing commit — the human curation step the design assumes, triggered on the very first run. Worth noting that nothing detects a record whose premise has been fixed out from under it.

## Repeatability

Runs mutate the fixture store (run 1 + run 2 took it from 3 records to 16 plus 2 ops). The committed fixture is the pristine 3-record starting state. Before a clean rerun:

```sh
git checkout tasks/memtest/store && rm -rf tasks/memtest/store/memory/index
```

Both halves matter. `git checkout` restores tracked files only, so it leaves the generated index behind, and `buildIndex` short-circuits on `fs.existsSync(path)` — it hands back whatever is at the revision-keyed path without checking it is a database. I proved that failure mode the hard way during this test by accidentally creating a *directory* named `<revision>.sqlite`, after which every search failed with "unable to open database file". The index is gitignored and rebuilds in a second; delete it.

`tasks/memtest/store/memory/wiki/` is compiled output (`renderAll` deletes and rewrites it each run) and is deliberately untracked, now covered by a `.gitignore` rule. Note `tasks/dw-water-bench/store/memory/wiki/` *is* tracked — that predates this rule and is the odd one out, not the pattern to copy.

## Two accounting notes

- `remember` charged **0 chars** to the retrieval budget, confirming the off-budget design from the roster fix wave; it writes a ledger line for accounting only.
- `summary.json`'s `memory.calls.byRole` reports the same single worker under two key shapes (session-file basename and subagent id), which reads as two workers. The budget ledger (`memory-calls.jsonl`) is consistent — one key across all five calls — and the `remember` rate limit keys off that same role, so the 5-per-worker cap is sound. The double key is cosmetic, in the summary aggregation only.
