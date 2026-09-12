Build the **gold layer** of an oil & gas data warehouse: a DuckDB file of analysis-ready tables derived from trusted silver Parquet (Texas, New Mexico, Oklahoma). The workspace holds `data/silver/` (three tables, Hive-partitioned by state; schemas in `contract/silver_schema.py`) and `data/reference/OG_COUNTY_CYCLE.dsv` (the Texas RRC's own monthly county rollup). Read the workspace README first.

## Deliverable

`src/gold.py`, runnable as

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/gold.py --silver data/silver --out data/gold/warehouse.duckdb --county-cycle data/reference/OG_COUNTY_CYCLE.dsv
```

Reads only `data/`; writes only the output file (and its `.wal`); exits 0; `duckdb` + `pyarrow` (`pandas` allowed); at most 300 code lines; under 20 s. Only `src/` is graded. Read the silver Parquet with `hive_partitioning = false` — `state` is already a column inside every file.

## Contract (this is what the hidden oracle checks)

Four tables in `warehouse.duckdb`: `production_monthly`, `decline_curve_inputs`, `wells`, `completions`. Column order and types matter. An *entity* is `(entity_key, state)`; "ordered" means by `production_date` ascending.

### `production_monthly` — one row per silver `production` row

Columns, in order: `entity_key, state, entity_type, api_number, lease_number, district, well_name, operator, county, field_name, basin, well_type, well_status, latitude, longitude, production_date, production_year, production_month, reported_month_index, calendar_months_on_production, vintage, initial_gor, total_oil_bbl, total_gas_mcf, oil_bbl, condensate_bbl, gas_mcf, casinghead_gas_mcf, water_bbl, days_produced, cumulative_oil_bbl, cumulative_gas_mcf, cumulative_water_bbl, source_file, ingested_at`

| column | definition |
|---|---|
| entity_key (VARCHAR) | `api_number` for `entity_type = 'well'`; `'TX-LEASE:' \|\| district \|\| '-' \|\| lease_number` for `'lease'` |
| production_year, production_month (INTEGER) | from `production_date` |
| total_oil_bbl (DOUBLE) | `oil_bbl + condensate_bbl` with a NULL part counted as 0, but **NULL when both are NULL** |
| total_gas_mcf (DOUBLE) | `gas_mcf + casinghead_gas_mcf`, same rule |
| reported_month_index (INTEGER) | 1-based rank of the row within its entity, ordered |
| calendar_months_on_production (INTEGER) | `(year*12+month) − (first_year*12+first_month) + 1`, *first* = the entity's earliest `production_date` |
| vintage (INTEGER) | year of the entity's earliest `production_date` with `total_oil_bbl > 0 or total_gas_mcf > 0`; NULL if none |
| initial_gor (DOUBLE) | `round(peak_gas / peak_oil * 1000, 1)`, `peak_*` = max `total_*` over the entity; NULL when `peak_oil` is NULL or 0 |
| cumulative_oil_bbl, cumulative_gas_mcf, cumulative_water_bbl (DOUBLE) | running sum of `total_oil_bbl` / `total_gas_mcf` / `water_bbl` over the entity, ordered, rows unbounded preceding to current; NULLs add nothing and an all-NULL prefix is NULL |
| all others | copied from silver, same types |

### `decline_curve_inputs` — producing well-months

Rows: production rows with `entity_type = 'well'`, `api_number` not NULL, and (`total_oil_bbl > 0` or `total_gas_mcf > 0`). Columns, in order: `entity_key, api_number, state, well_name, operator, county, field_name, basin, well_type, well_status, latitude, longitude, production_date, production_year, production_month, months_on_production, total_oil_bbl, total_gas_mcf, water_bbl, days_produced, initial_oil_rate, initial_gas_rate, oil_rate_pct_of_initial, cumulative_oil, cumulative_gas, cumulative_water`.

- `months_on_production` (INTEGER): 1-based rank among the well's producing rows, ordered.
- `initial_oil_rate`, `initial_gas_rate` (DOUBLE): the well's first producing row's `total_oil_bbl` / `total_gas_mcf`.
- `oil_rate_pct_of_initial` (DOUBLE): `round(total_oil_bbl / initial_oil_rate * 100, 2)`; NULL when `initial_oil_rate` is NULL or 0.
- `cumulative_oil`, `cumulative_gas`, `cumulative_water` (DOUBLE): running sums over the producing rows, ordered.

### `wells`, `completions`

The silver tables copied unchanged (columns, types, rows).

### Assertions (each must hold on your database)

1. no NULL `entity_key`; 2. `entity_key` matches the rule above for every row; 3. no negative volumes; 4. no `production_date` after today; 5. `production_monthly` has exactly the silver rows (same count, every gold row has its silver row); 6. per entity `reported_month_index` = 1..n; 7. `calendar_months_on_production ≥ 1`; 8. per state, `sum(total_oil_bbl)` and `sum(total_gas_mcf)` equal the same sums over silver (±0.01); 9. every `decline_curve_inputs` row is a silver well row and per well `months_on_production` = 1..n; 10. `wells`/`completions` row counts equal silver's.

### County reconciliation (TX)

For every `(COUNTY_NO, CYCLE_YEAR, CYCLE_MONTH)` in `OG_COUNTY_CYCLE.dsv` (`}`-delimited, latin-1), the sums of `oil_bbl, gas_mcf, condensate_bbl, casinghead_gas_mcf` over TX rows with that `COUNTY_NAME` must equal `CNTY_OIL_PROD_VOL, CNTY_GAS_PROD_VOL, CNTY_COND_PROD_VOL, CNTY_CSGD_PROD_VOL`. With no TX production rows in this pull the check is recorded as not applicable.

### The oracle's checks

Per table: present; columns and types identical; row count; every row equal to an independent reference build from the same silver (matched on key — `production_monthly`: `(entity_key, state, production_date)`; `decline_curve_inputs`: `(api_number, state, production_date)`; `wells`: `(state, api_number)`; `completions`: `(state, api_number, completion_no, row_no)`; all columns except `ingested_at`; doubles within 1e-6). Then the ten assertions on your database and the county reconciliation. Plus: ≤ 300 code lines; no network/process modules.

## Verification channel

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["<table>"] }` and returns the oracle's pass/total for that table with the exact failing checks and sample differences. Probe every table before claiming `kind="done"`.
