# Exploration contract — "every observation is a query that reproduces"

The data explorer (task `dw-explore`) does open-ended exploration of the warehouse and reports what it found. There is no ground truth for "interesting", so the oracle checks only that each observation is **reproducible**: the exact read-only query the explorer ran, re-executed by the host against the same warehouse, yields the result the explorer reported. Oracle kind: **grounding**; insight is judged by a person (`tools/verdict.mjs`) and by later runs.

## 1. Inputs (workspace, read-only)

```
data/gold/warehouse.duckdb         production_monthly, decline_curve_inputs, wells, completions   (contract-gold.md)
data/silver/…                      the silver Parquet + manifest                                    (contract-silver.md)
contract/*.md, contract/silver_schema.py
```

## 2. Deliverable

`src/exploration.json` (graded) and `src/exploration.md` (for people; must exist and be non-trivial).

```json
{
  "scope": "one sentence: what was explored and why",
  "observations": [
    {
      "id": "O1",
      "title": "NM oil is concentrated in a handful of wells",
      "observation": "Three of the 40 NM wells account for 61% of cumulative oil …",
      "why_it_matters": "…",
      "query": "select entity_key, round(sum(total_oil_bbl)) oil from production_monthly where state = 'NM' group by 1 order by 2 desc limit 5",
      "result": [["30-025-…", 1234567.0], ["…", 0.0]],
      "confidence": 0.8
    }
  ],
  "next_questions": ["…"]
}
```

## 3. Rules the oracle checks

1. `scope` non-empty; `observations` has at least 5 entries with unique `id`s and distinct `title`s (case-insensitive); `next_questions` is a non-empty list of strings.
2. Each observation has non-empty `title`, `observation`, `why_it_matters`; `confidence` in [0, 1].
3. `query` is one read-only DuckDB statement: it starts with `select` or `with` (case-insensitive, after whitespace), contains no `;` except optionally at the end, and none of `attach`, `copy`, `install`, `load`, `pragma`, `create`, `insert`, `update`, `delete`, `drop`, `alter`, `export`, `import`, `read_csv`, `read_parquet`, `read_json`, `glob(` (the warehouse tables are the surface; silver files are for reading with pyarrow while exploring, not for citing).
4. `result` is a list of rows (each a list) with at most 50 rows, and equals the host's re-execution of `query` against `data/gold/warehouse.duckdb` (read-only, 10 s limit): same row count, same values in order — numbers within 1e-6, dates/timestamps compared as ISO strings, NULL as `null`. Use `order by` for determinism; a query without it is still compared in the order DuckDB returns it, so add one.
5. The `observation` text mentions at least one number that appears in `result` (integer or decimal as printed, or its rounded form), so prose is tied to data.

## 4. Probe

- `["query", "<sql>"]` — run a read-only query (rules in §3.3) and return up to 50 rows, or the error.
- `["observation", "<id>"]` — reproduce one observation of the current `src/exploration.json` and report exactly which rule failed.

## 5. Memory

The verdict's summary ends with `Findings digest: O1 title | O2 title | …`; retention keeps it on the run's episodic record in `repo:data-warehousers`, and the next explorer is told what earlier runs already observed.
