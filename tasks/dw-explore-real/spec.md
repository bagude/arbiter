This is an exploration task, not a coding task. You are the data explorer for a **full-scale** oil & gas production warehouse (Texas RRC, New Mexico OCD, Oklahoma OCC): 93 million rows in `production_monthly`, 55 million in `decline_curve_inputs`. The workspace mounts a read-only snapshot of it at `data/real/` (`warehouse.duckdb` plus the silver Parquet it was built from and the bronze manifests). Read the workspace README first.

## The question

**What is in this data that a maintainer or an analyst would want to know?** Explore freely — grain, concentration, trends, outliers, data-quality oddities, cross-state contrasts, anything the contracts under `contract/` imply that the data contradicts. Your prompt carries a MEMORY section listing a few earlier records; `memory_search` and `memory_get` reach the rest. Records marked verified had their query reproduced; interpreted and hypothesis records are not facts — their settlement_criterion says what would settle them. Go where earlier observed findings did not, and take open questions as starting points; leave new ones for the run after you.

## The deliverable

`src/exploration.json` and `src/exploration.md`:

```json
{
  "scope": "one sentence: what you explored and why",
  "observations": [
    { "id": "O1", "title": "short, specific",
      "observation": "what the data shows, with the numbers from the result in the text",
      "why_it_matters": "what a maintainer or analyst would do with this",
      "claim": "observed | interpreted | hypothesis",
      "settlement_criterion": "required unless observed: what evidence would settle it",
      "evidence_refs": ["m_… memory ids you relied on (optional)"],
      "query": "select … from production_monthly where … group by … order by … limit …",
      "result": [["value", 123.0]],
      "confidence": 0.8 }
  ],
  "next_questions": ["what to explore next, and why"]
}
```

Rules the host checks mechanically (each observation is graded by **reproduction**):
- between 5 and 8 observations, unique `id`s, distinct titles; `scope` and `next_questions` non-empty;
- `query` is one read-only DuckDB statement against `production_monthly` or `decline_curve_inputs`: starts with `select` or `with`, no `;` except at the end, none of `attach copy install load pragma create insert update delete drop alter export import read_csv read_parquet read_json glob(`; do not query `stg_production` (a view over files outside the snapshot);
- **every query must finish in under 10 seconds** on the full tables — the host re-runs it with that limit and a slow query fails the observation. Aggregations over a whole table are fine in DuckDB (1–3 s); avoid `order by` on unaggregated 93-million-row scans and always use `limit`;
- `result` is the rows the query returns, as a list of lists, at most 50 rows, in the order returned (use `order by` with a unique tie-breaker); numbers within 1e-6, dates as ISO strings, NULL as `null`;
- the `observation` text mentions at least one number that appears in the result (as printed, or rounded); `confidence` in [0, 1].
- `claim` is one of `observed` (the result rows show it), `interpreted` (the rows plus an explanation the rows do not establish), `hypothesis` (a conjecture worth checking); `interpreted` and `hypothesis` need a non-empty `settlement_criterion` — what evidence would settle it. The host checks the structure, not the honesty of the label; what it reproduced is stamped separately on the retained record;
- `evidence_refs` (optional) lists memory record ids (`m_…`) the observation relied on; each must resolve in this run's memory index.

`src/exploration.md` is the same for a person. Only `src/` is graded; scratch notes go under `src/notes/`.

Python: `uv run --no-project --python 3.13 --with-requirements requirements.txt python …` with `duckdb`, `pyarrow`, `pandas`. Open the warehouse read-only: `duckdb.connect("data/real/warehouse.duckdb", read_only=True)`. Time your queries; the ones you cite must be fast.

## How verification works here

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["query", "<sql>"] }` — the host runs the read-only query (10 s limit) and returns the rows exactly as it will compare them — or `{ "id": "<label>", "args": ["observation", "O1"] }` — the host reproduces that observation of the current `src/exploration.json` and says exactly which rule failed. Probe every observation before claiming `kind="done"`.
