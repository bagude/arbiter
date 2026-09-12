# Gold contract — "the SQL says what silver says"

Gold is a DuckDB file built from oracle-passed silver (docs/dw/contract-silver.md) by definitions that can be recomputed independently. The oracle recomputes every table from the same silver with its own SQL, compares, runs the data-quality assertions, and reconciles against an independent rollup.

## 1. Storage and inputs

```
data/gold/warehouse.duckdb        tables: production_monthly, decline_curve_inputs, wells, completions
```

Inputs: `data/silver/` (the three silver tables, Hive-partitioned by state) and `data/reference/OG_COUNTY_CYCLE.dsv` (the RRC's own monthly county rollup, straight from bronze; an independent check on TX totals).

## 2. `production_monthly` — one row per silver production row

Columns, in order:

`entity_key, state, entity_type, api_number, lease_number, district, well_name, operator, county, field_name, basin, well_type, well_status, latitude, longitude, production_date, production_year, production_month, reported_month_index, calendar_months_on_production, vintage, initial_gor, total_oil_bbl, total_gas_mcf, oil_bbl, condensate_bbl, gas_mcf, casinghead_gas_mcf, water_bbl, days_produced, cumulative_oil_bbl, cumulative_gas_mcf, cumulative_water_bbl, source_file, ingested_at`

Definitions (an *entity* is `(entity_key, state)`; "ordered" means by `production_date` ascending):

| column | definition |
|---|---|
| entity_key | `api_number` when `entity_type = 'well'`; `'TX-LEASE:' || district || '-' || lease_number` when `'lease'` |
| production_year / production_month | integer year / month of `production_date` |
| total_oil_bbl | `oil_bbl + condensate_bbl` treating a NULL part as 0, **NULL when both parts are NULL** |
| total_gas_mcf | `gas_mcf + casinghead_gas_mcf`, same rule |
| reported_month_index | 1-based rank of the row within its entity, ordered (`row_number`) |
| calendar_months_on_production | `(year*12+month) - (first_year*12+first_month) + 1`, where *first* is the entity's earliest `production_date` |
| vintage | year of the entity's earliest `production_date` whose `total_oil_bbl > 0 or total_gas_mcf > 0`; NULL if none |
| initial_gor | `round(peak_gas / peak_oil * 1000, 1)` where `peak_*` = max `total_*` over the entity; NULL when `peak_oil` is NULL or 0 |
| cumulative_oil_bbl / cumulative_gas_mcf / cumulative_water_bbl | running sum of `total_oil_bbl` / `total_gas_mcf` / `water_bbl` over the entity, ordered, rows unbounded preceding to current (NULLs contribute nothing; a prefix with only NULLs is NULL) |
| everything else | copied from silver |

## 3. `decline_curve_inputs` — producing well-months only

Rows: production rows with `entity_type = 'well'`, `api_number` not NULL and (`total_oil_bbl > 0` or `total_gas_mcf > 0`). Columns:

`entity_key, api_number, state, well_name, operator, county, field_name, basin, well_type, well_status, latitude, longitude, production_date, production_year, production_month, months_on_production, total_oil_bbl, total_gas_mcf, water_bbl, days_produced, initial_oil_rate, initial_gas_rate, oil_rate_pct_of_initial, cumulative_oil, cumulative_gas, cumulative_water`

- `months_on_production`: 1-based rank of the row among the well's producing rows, ordered.
- `initial_oil_rate` / `initial_gas_rate`: `total_oil_bbl` / `total_gas_mcf` of the well's first producing row.
- `oil_rate_pct_of_initial`: `round(total_oil_bbl / initial_oil_rate * 100, 2)`; NULL when `initial_oil_rate` is NULL or 0.
- `cumulative_oil` / `cumulative_gas` / `cumulative_water`: running sums over the producing rows, ordered.

## 4. `wells`, `completions`

Copied from silver unchanged (same columns, same rows).

## 5. Data-quality assertions (each must return zero rows)

1. `production_monthly.entity_key` is never NULL.
2. Well rows have `entity_key = api_number`; lease rows have `entity_key = 'TX-LEASE:' || district || '-' || lease_number`.
3. No negative `oil_bbl, gas_mcf, condensate_bbl, casinghead_gas_mcf, water_bbl`.
4. No `production_date` after today.
5. Every `production_monthly` row has a silver row with the same `(entity_key, state, production_date)`, and vice versa (row counts equal).
6. Per entity, `reported_month_index` runs 1..n with n = the entity's row count.
7. `calendar_months_on_production ≥ 1`.
8. Per state, `sum(total_oil_bbl)` and `sum(total_gas_mcf)` equal the same sums computed from silver (tolerance 0.01).
9. Every `decline_curve_inputs` row corresponds to a silver well row with `api_number` set; per well, `months_on_production` runs 1..n.
10. `wells` and `completions` equal their silver tables.

## 6. Reconciliation with the RRC county rollup (TX)

For every `(COUNTY_NO, CYCLE_YEAR, CYCLE_MONTH)` in `OG_COUNTY_CYCLE.dsv`, the sums of `oil_bbl, gas_mcf, condensate_bbl, casinghead_gas_mcf` over TX `production_monthly` rows whose `county` is that county's `COUNTY_NAME` must equal `CNTY_OIL_PROD_VOL, CNTY_GAS_PROD_VOL, CNTY_COND_PROD_VOL, CNTY_CSGD_PROD_VOL`. Checked only when TX production rows exist; with an empty TX production table the oracle records the check as *not applicable*.

## 7. Interface (task `dw-gold`)

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/gold.py --silver data/silver --out data/gold/warehouse.duckdb --county-cycle data/reference/OG_COUNTY_CYCLE.dsv
```

Reads only `data/`; writes only the output file (and its `.wal`); `duckdb` + `pyarrow` (+ `pandas`); ≤ 300 code lines; under 20 s.

## 8. Oracle checks

Per table: present; columns and types as listed; row count; every row equal to the reference build from the same silver (matched on the table's key — `production_monthly`: `(entity_key, state, production_date)`; `decline_curve_inputs`: `(api_number, state, production_date)`; `wells`: `(state, api_number)`; `completions`: `(state, api_number, completion_no, row_no)` — all columns except `ingested_at`, floats within 1e-6). Then the ten assertions on the candidate database, and the county reconciliation.
