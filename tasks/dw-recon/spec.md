This is a reconciliation task, not a coding task. You are the health check for an oil & gas data warehouse (Texas RRC, New Mexico OCD, Oklahoma OCC; bronze → silver → gold). The workspace holds one complete pipeline state — bronze pulls with manifests, silver Parquet with a manifest, the gold DuckDB — and the three layer contracts under `contract/`. Read the workspace README first.

## The deliverable

`src/health.json` and `src/health.md`: a health report whose every number is checkable and whose findings say what a maintainer should know — what landed and when, what is fresh or stale, where layers disagree, what was dropped, what is missing and why.

```json
{
  "report_of": "2026-02-11",
  "generated_at": "2026-09-12T16:40:00Z",
  "kpi": {
    "TX": {
      "bronze": { "pull_date": "2026-02-11", "landed_at": "…Z", "files": 4, "bytes": 0, "records": 0 },
      "silver": { "wells": { "rows": 0, "with_production": 0 }, "production": { "rows": 0, "first_month": null, "last_month": null, "freshness_months": null, "entities": 0, "gap_months": 0 }, "dropped": { "wells.truncated_api": 0 } },
      "gold": { "production_monthly": { "rows": 0 }, "decline_curve_inputs": { "rows": 0 }, "wells": { "rows": 0 }, "parity": true }
    },
    "NM": { "…same shape as TX…" },
    "OK": { "bronze": { "…" }, "silver": { "wells": { "rows": 0, "with_production": 0 }, "completions": { "rows": 0 }, "dropped": {} }, "gold": { "wells": { "rows": 0 }, "completions": { "rows": 0 }, "parity": true } }
  },
  "findings": [
    { "id": "F1", "severity": "error", "layer": "bronze", "state": "TX", "title": "…", "description": "…",
      "evidence": [ { "file": "data/bronze/tx/2026-02-11/manifest.json", "quote": "an exact substring of at least 12 characters" }, { "kpi": "TX.silver.production.rows" } ] }
  ]
}
```

### KPI definitions (the host recomputes every one; they must match exactly)

Per state: `bronze.pull_date` = the pull directory name; `bronze.landed_at` = the manifest's `pulled_at`; `bronze.files` = number of manifest `files` entries; `bronze.bytes` = their `bytes` summed; `bronze.records` = their `records` summed over entries that have one. `silver.<table>.rows` = `data/silver/manifest.json` `rows[table][state]` (`wells` and `production` for TX/NM; `wells` and `completions` for OK); `silver.dropped` = `manifest.dropped[state]` (an object, `{}` if none). For TX/NM production from the state's parquet file: `first_month`/`last_month` = min/max `production_date` as `YYYY-MM-DD` (null when empty); `freshness_months` = `(pull_year*12+pull_month) − (last_year*12+last_month)` (null when empty); `entities` = distinct `(entity_type, api_number, lease_number, district)`; `gap_months` = Σ over entities of (months from first to last date inclusive − rows). `silver.wells.with_production` = distinct wells `api_number` that appear in the production rows (0 for OK). `gold.<table>.rows` = rows in `warehouse.duckdb` where `state` is this state, for `production_monthly`, `decline_curve_inputs`, `wells` (TX/NM) or `wells`, `completions` (OK); `gold.parity` = true iff gold `wells` rows equal silver `wells` rows and gold `production_monthly` (or `completions`) rows equal the silver counterpart. Integers stay integers. No other keys.

Read parquet with `pyarrow.parquet.ParquetFile(path).read()` (not the dataset API: `state` is both a column and a partition name). Read DuckDB with `duckdb.connect(path, read_only=True)`.

### Since the last report (the host checks this exactly)

Add a top-level `since_last`. If your prompt's MEMORY section has no line of the form `[[runs/<id>]] KPI digest: {…}` for `dw-recon`, set `"since_last": null`. Otherwise take the **newest** such line and set

```json
"since_last": { "run": "<that run id>", "previous": { …that JSON object, copied verbatim… },
                "changed": { "<STATE>.<key>": { "from": <previous value>, "to": <your value> } }, "unchanged": <count> }
```

where the keys compared are exactly those of the compact digest per state (`pull_date, landed_at, files, records, wells, production_rows` or `completions_rows`, `last_month, freshness_months, parity`), `changed` lists every key whose value differs between that digest and your KPI block, and `unchanged` counts the keys that are equal. Say in `health.md` what changed since that report, or that nothing did.

### Findings (the host checks grounding, not insight)

At least 3, unique ids, `severity ∈ {info, warn, error}`, `layer ∈ {bronze, silver, gold, cross}`, `state ∈ {TX, NM, OK, null}`, non-empty title and description, ≥ 1 evidence each. Evidence is either `{ "file", "quote" }` — a text file under `data/` or `contract/` (`.json .md .py .dsv .csv .txt .xml`) and a substring of at least 12 characters that appears **verbatim** in it — or `{ "kpi": "<STATE>.<path>" }` naming a key of the KPI block (e.g. `NM.silver.production.freshness_months`). Parquet and DuckDB cannot be quoted; cite the manifest, a contract, a raw file, or a KPI instead. A finding about something missing still cites something that exists.

`src/health.md` is the same report for a person: a short status line per state, the KPI table, the findings. Only `src/` is graded; scratch notes go under `src/notes/`.

## How verification works here

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["kpi", "TX"] }` — returns the host's own KPI block for that state, so you can check every number before claiming — or `{ "id": "<label>", "args": ["finding", "F1"] }` — returns whether that finding of the current `src/health.json` is grounded and exactly which rule failed. Probe every state's KPIs and every finding before `kind="done"`.
