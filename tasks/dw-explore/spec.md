This is an exploration task, not a coding task. You are the data explorer for an oil & gas data warehouse (Texas RRC, New Mexico OCD, Oklahoma OCC). The workspace holds the gold DuckDB (`production_monthly`, `decline_curve_inputs`, `wells`, `completions`), the silver Parquet it was built from, and the layer contracts under `contract/`. Read the workspace README first.

## The question

**What is in this data that a maintainer or an analyst would want to know?** Explore freely — distributions, concentration, trends, outliers, data-quality oddities, cross-state contrasts, anything the contracts imply that the data contradicts. If your prompt carries a MEMORY section with earlier explorations, their titles are ground already covered — go elsewhere — and the `next:` questions after them are open threads earlier runs left: take those as your starting points, and leave new ones for the run after you.

## The deliverable

`src/exploration.json` and `src/exploration.md`:

```json
{
  "scope": "one sentence: what you explored and why",
  "observations": [
    {
      "id": "O1",
      "title": "short, specific",
      "observation": "what the data shows, with the numbers from the result in the text",
      "why_it_matters": "what a maintainer or analyst would do with this",
      "query": "select … from production_monthly where … group by … order by … limit …",
      "result": [["value", 123.0], ["value2", 45.0]],
      "confidence": 0.8
    }
  ],
  "next_questions": ["what to explore next, and why"]
}
```

Rules the host checks mechanically (each observation is graded by **reproduction**):
- at least 5 observations, unique `id`s, distinct titles; `scope` and `next_questions` non-empty;
- `query` is one read-only DuckDB statement against the warehouse tables: starts with `select` or `with`, no `;` except at the end, and none of `attach copy install load pragma create insert update delete drop alter export import read_csv read_parquet read_json glob(`;
- `result` is the rows the query returns, as a list of lists, at most 50 rows (use `limit`), in the order returned (use `order by`); the host re-runs your query read-only with a 10 s limit and the rows must match exactly (numbers within 1e-6, dates as ISO strings, NULL as `null`);
- the `observation` text mentions at least one number that appears in the result (as printed, or rounded);
- `confidence` in [0, 1].

`src/exploration.md` is the same for a person: the scope, each observation with its query and a short table of the result, the next questions. Only `src/` is graded; scratch notes go under `src/notes/`.

Python is available (`uv run --no-project --python 3.13 --with-requirements requirements.txt python …`) with `duckdb`, `pyarrow`, `pandas`. Open the warehouse read-only: `duckdb.connect("data/gold/warehouse.duckdb", read_only=True)`. Explore with anything you like; only the `query` you cite is graded.

## How verification works here

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["query", "<sql>"] }` — the host runs the read-only query and returns the rows exactly as it will compare them — or `{ "id": "<label>", "args": ["observation", "O1"] }` — the host reproduces that observation of the current `src/exploration.json` and says exactly which rule failed. Probe every observation before claiming `kind="done"`; a worker's report that its numbers are right is a claim, not a fact.
