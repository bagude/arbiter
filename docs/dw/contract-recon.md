# Reconciliation contract — "the pipeline's health, with every number checkable"

The reconciliation agent (task `dw-recon`) runs ad hoc over a pipeline state — bronze pulls, silver tables, the gold warehouse — and writes a health report. Its numbers are mechanical and the oracle recomputes every one of them; its findings are judgment, and the oracle only checks that each rests on something real (a file and a verbatim quote, or a KPI it restates). Oracle kind: **grounding**.

## 1. Inputs (workspace, read-only)

```
data/bronze/<state>/<pull_date>/manifest.json + files    (contract-bronze.md)
data/silver/<table>/state=<XX>/*.parquet, data/silver/manifest.json   (contract-silver.md)
data/gold/warehouse.duckdb                               (contract-gold.md)
contract/*.md, contract/silver_schema.py
```

## 2. Deliverable

`src/health.json` (graded) and `src/health.md` (the same report for people; not graded beyond existing and being non-empty).

```json
{
  "report_of": "2026-02-11",
  "generated_at": "2026-09-12T16:40:00Z",
  "kpi": { "TX": { … }, "NM": { … }, "OK": { … } },
  "findings": [
    { "id": "F1", "severity": "error", "layer": "bronze", "state": "TX",
      "title": "TX pull has no production table",
      "description": "…",
      "evidence": [ { "file": "data/bronze/tx/2026-02-11/manifest.json", "quote": "\"path\": \"OG_COUNTY_CYCLE.dsv\"" },
                    { "kpi": "TX.silver.production.rows" } ] }
  ]
}
```

## 3. KPI block — per state, exactly these keys

| key | definition |
|---|---|
| `bronze.pull_date` | the pull directory name |
| `bronze.landed_at` | `manifest.pulled_at` |
| `bronze.files` | number of entries in `manifest.files` |
| `bronze.bytes` | sum of `bytes` over entries |
| `bronze.records` | sum of `records` over entries that have one |
| `silver.<table>.rows` | `data/silver/manifest.json` `rows[table][state]` for each table the state has (`wells`, `production` for TX/NM, `completions` for OK) |
| `silver.dropped` | `manifest.dropped[state]` (object; `{}` when nothing was dropped) |
| `silver.production.first_month` / `last_month` | min / max `production_date` in the state's production file, `YYYY-MM-DD`; `null` when the file is empty (TX/NM only) |
| `silver.production.freshness_months` | `(pull_year*12 + pull_month) − (last_year*12 + last_month)`; `null` when `last_month` is null |
| `silver.production.entities` | distinct `(entity_type, api_number, lease_number, district)` in the production file |
| `silver.production.gap_months` | over entities: Σ (`calendar span` − `reported months`) where span = months from the entity's first to last `production_date` inclusive |
| `silver.wells.with_production` | wells (by `api_number`) that appear in the state's production rows |
| `gold.<table>.rows` | rows in `warehouse.duckdb` for the state: `production_monthly`, `decline_curve_inputs` (TX/NM), `wells`, `completions` (OK) |
| `gold.parity` | `true` iff `gold.production_monthly.rows == silver.production.rows` and `gold.wells.rows == silver.wells.rows` (and `completions` for OK) |

Integers are integers; dates are strings; nothing else appears in the block. The oracle compares the block to its own computation key by key.

## 4. Findings

- At least 3, unique `id`s, `severity ∈ {info, warn, error}`, `layer ∈ {bronze, silver, gold, cross}`, `state ∈ {TX, NM, OK, null}`, non-empty `title` and `description`.
- Each has ≥ 1 evidence entry; every entry is valid:
  - `{ "file", "quote" }` — `file` is a text file under `data/` or `contract/` (`.json`, `.md`, `.py`, `.dsv`, `.csv`, `.txt`, `.xml`) and `quote` (≥ 12 characters) occurs verbatim in it;
  - `{ "kpi" }` — a dotted path into the KPI block (`<STATE>.bronze.records`, `<STATE>.silver.production.rows`, …) that exists.
- A finding that says "X is missing" must still point at something that exists (the manifest that lacks it, the contract that requires it, the KPI that is 0).

## 5. Oracle checks

1. `src/health.json` parses; `report_of` equals the pull date; `generated_at` is UTC `…Z`.
2. The KPI block equals the oracle's recomputation for every state and key (missing, extra or differing keys are each a failure, reported by path).
3. Findings: the rules in §4, each checked and reported by finding id.
4. `src/health.md` exists and is non-empty.

## 6. Probe

`kind="probe"` with `args: ["kpi", "<STATE>"]` returns the oracle's KPI block for that state (so the report's numbers can be checked before claiming); `args: ["finding", "<id>"]` returns the grounding result for one finding of the current `src/health.json`.

## 7. Memory

Each run's oracle verdict carries a one-line KPI digest (landed dates, rows, freshness) that retention stores in `repo:data-warehousers`, so later runs recall the landing history and can report what changed.
