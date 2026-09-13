# Memory slice 1 — live runs (2026-09-12, branch memory-retrieval)

Search mode replaces the 8 000-character wiki injection with a seeded brief of about 2 000 characters plus `memory_search` / `memory_get` under a per-run delivery budget of 6 000 characters shared by every role and session. Numbers below are from `summary.json` and `memory-calls.jsonl` of each run.

| run | task | mode | seed chars | searches | gets | refused | delivered / budget | oracle | attempts | wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-12T22-33-39 | dw-explore-real | inject | 8 000 | — | — | — | 8 000 | 14/14 | 1 | 769 |
| 2026-09-13T00-53-28 | pathnorm (smoke) | search | 726 | 0 | 0 | 0 | 726 / 6 000 | 70/70 | 1 | 253 |
| 2026-09-13T01-04-16 | dw-explore-real | search | 1 864 | 2 | 1 | 0 | 5 316 / 6 000 | 14/14 | 1 | 786 |
| 2026-09-13T01-17-22 | dw-water-bench 1 | search | 1 894 | 1 | 2 | 3 | 5 955 / 6 000 | 11/11 | 4 | 556 |
| 2026-09-13T01-26-40 | dw-water-bench 2 | search | 1 894 | 1 | 2 | 1 | 5 917 / 6 000 | 11/11 | 1 | 114 |
| 2026-09-13T01-28-34 | dw-water-bench 3 | search | 1 894 | 1 | 2 | 1 | 5 872 / 6 000 | 11/11 | 1 | 142 |

## Explorer: injection versus search

Same oracle result (14/14), same wall time within 2 percent, with 5 316 characters of memory delivered instead of 8 000, of which 1 864 at startup. The orchestrator searched once and fetched five records; the worker searched once on its own (969 characters), attributed to its session in the ledger. Four of the eight observations cite memory ids in `evidence_refs`. All eight observations were labelled `observed`, including "feeds are stale", which reads as an interpretation: the contract checks structure, not honesty.

## Benchmark: the three measurements

Each run rebuilt the fixture store first (552 records; the seed brief shows R1 and the mislabelled R2, never R4).

- **Evidence found.** All three runs cited `m_bench_r4`, the loader-inspection record absent from the seed, so each needed a search and a fetch. Nothing from the incompatible snapshot (R3, R5) was cited.
- **Unresolved interpretation preserved.** All three runs filed `claim: observed` for the cause, each with a header check that reproduces (nine columns, no water column). The oracle accepts that by design: with the header re-read, "the mapped field is absent at the source" is checked, not inferred. Every run also cited `m_bench_r2` ("by source design", labelled observed, backed only by the NULL query) as support. The oracle does not penalise that today; a stricter version would require R2 to be excluded or explicitly flagged as unverified reasoning.
- **Budget held.** All three runs stayed within 6 000 characters, but run 1 shows the cost of a shared budget with no reservation: the orchestrator spent 4 047 characters (one search of 2 009, one get of 2 038) before spawning; the worker's three fetches were refused and its one accepted get delivered 14 characters ("not found"). The oracle's `worker_fetched` check failed three times and the run passed on the fourth done attempt, 556 s instead of about 130 s. Runs 2 and 3 saw the orchestrator spend 3 547 and the worker get through with 431–476 characters.

## What to change next

1. Reserve part of the budget for workers (or charge the seed against a separate allowance): a 6 000 budget with a 1 900 seed leaves 4 100 for everyone, and one orchestrator get of five records can take half of it.
2. `worker_fetched` should require a get that delivered a record, not any get.
3. The benchmark should score citing R2 as support, since that is the mislabelled record the fixture exists to catch.
4. Slice 2 (working-context checkpoints and compaction at the spawn boundary) stays next; NVIDIA's SoL-Pi Online Context Compact is a candidate implementation to adapt rather than write from scratch.
