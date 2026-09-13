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

## After the fixes (2026-09-12, worker reserve 2 000, `worker_fetched` needs a delivered record, R2 scored)

| run | attempts | orchestrator chars | worker chars | refused (role) | delivered / budget | oracle | wall s |
|---|---|---|---|---|---|---|---|
| 2026-09-13T02-32-20 | 1 | 2 009 | 1 534 | 1 (orchestrator) | 5 437 / 6 000 | 12/12 | 157 |
| 2026-09-13T02-34-58 | 1 | 2 009 | 1 534 | 2 (orchestrator) | 5 437 / 6 000 | 12/12 | 108 |
| 2026-09-13T02-36-47 | 1 | 2 009 | 1 103 | 2 (orchestrator) | 5 006 / 6 000 | 12/12 | 136 |

All three passed on the first claim: the refusals now land on the orchestrator when it reaches its 4 000-character cap, the worker fetches real records inside the 2 000 reserve, and every finding cites R1 and R4 only, with the mislabelled R2 no longer offered as support. The cause is still filed as `observed` with a reproducing header check, which the oracle accepts by design. Explorer configs were raised afterwards to 16 000 / 5 000 reserved / 2 500 seed; the benchmark stays at 6 000 / 2 000 on purpose.

## Explorer at the raised budget (2026-09-13T03-17-50: 16 000, 5 000 reserved, 2 500 seed)

| | 6 000 budget (01-04-16) | 16 000 budget (03-17-50) |
|---|---|---|
| seed | 1 864 chars, 6 rows | 2 497 chars, 9 rows |
| searches / gets | 2 / 1 | 0 / 2 |
| delivered | 5 316 | 9 459 |
| observations citing memory | 4 of 8 | 5 of 8 |
| oracle | 14/14 | 14/14 |
| wall s | 786 | 942 |

With room to spare the orchestrator never searched: it fetched ten records straight from the seed (two gets, 6 962 characters) and delegated. The extra budget bought more reading, not more finding; all eight observations were again labelled `observed`. The judgement lint added afterwards flags one earlier title ("Feeds are stale …") for a verdict. The run was launched before the retention-policy commit, so its six open questions were retained as promoted and were re-filed as candidates by hand.

## What to change next

1. (done) Reserve part of the budget for workers.
2. (done) `worker_fetched` requires a get that delivered a record.
3. (done) Citing R2 as support fails the benchmark.
4. (done) Search returns 5 rows by default; lint `observed-reads-as-judgement`; retention promotes only observed findings the oracle reproduced, everything else waits as a candidate (`demote` op re-filed the earlier records).
5. Slice 2 (working-context checkpoints and compaction at the spawn boundary) stays next; NVIDIA's SoL-Pi Online Context Compact is a candidate implementation to adapt rather than write from scratch.
