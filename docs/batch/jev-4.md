# Jev re-ranking memory_search rows (2026-09-17)

Question: given the query and the index's top-10 rows, does Jev put the record the orchestrator wanted higher than bm25 did? Tool: `tools/jev-memory.mjs`.

## Method

- **Labels.** Every orchestrator `memory_search` across 149 recorded runs, with the ids it fetched by `memory_get` within the next few calls as the click. 35 distinct (task, query) pairs, 16 with a click. Of those, only **8** have the clicked record inside the current index's top-10 (the other eight clicked records are not in the folded ledger any more, or were shown by an older index), and the click can only judge rows that were shown, so the comparison is within the top-10.
- **Re-ranking.** One call per query: the query and the ten rows (id, scope, kind, claim, summary) as the state; one truth value per row, "this row is what the person who typed the query is looking for". Rows re-sorted by that value, ties broken by the FTS order. 140–340 ms per query.

## Result

| | FTS | Jev |
|---|---|---|
| MRR (8 queries) | 0.466 | 0.492 |
| hits@1 | 2 | 2 |
| hits@3 | 5 | 5 |
| Jev better / worse / same | | 4 / 2 / 2 |

Inconclusive. Eight queries with a click label that is itself a product of the FTS order cannot separate the two rankings. The moves are small in both directions (7→4, 3→2, 4→3 up; 2→4, 6→10 down).

## What would settle it

Not clicks. The cases that mattered today are the ones where the right record was **not** what the orchestrator fetched: the failing run searched "oracle acceptance passed relative root slash" and the record holding the fix was shown but truncated (audit case 1). A labelled set of (query, the record that would have changed the run) can be built by hand from the batch docs, about twenty pairs across pathnorm, raid-gear and the data-warehousers tasks, and the right measure is whether Jev's ordering puts that record on the first screen. Until then, the memory fixes that pay are the ones already in the harness-text branch: the row floor and the informative refusal. Parked.
