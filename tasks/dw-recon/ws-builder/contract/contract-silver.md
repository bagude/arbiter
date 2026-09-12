# Silver contract — "canonical, complete, true to the raw"

Silver is three Parquet tables derived from a bronze pull (docs/dw/contract-bronze.md) by rules that a reader can check against the raw files. The schemas and every code table live in `silver_schema.py` (shipped in the workspace and used verbatim by the oracle). Expected values in the oracle come from an independent minimal reader over the same bronze plus hand-traced labels — never from the pipeline being replaced.

## 1. Storage

```
data/silver/<table>/state=<XX>/<xx>_<table>.parquet     table ∈ {wells, production, completions}
data/silver/manifest.json
```

- One file per (table, state); the schema is **exactly** the PyArrow schema in `silver_schema.py` (names, order, types, nullability). `state` is stored as a plain string column inside the file as well as in the partition name.
- Tables present per state: `wells` for TX, NM, OK; `production` for TX, NM (an empty file with the schema when the state has no production source in the pull, e.g. TX without `OG_LEASE_CYCLE.dsv`); `completions` for OK.
- Row order inside a file is unspecified; the oracle sorts by key.
- `ingested_at` is lineage only (UTC timestamp of the run) and is never compared. `source_file` is the bronze-relative path the row came from.

`manifest.json`:

```json
{ "rows": { "wells": { "TX": 231, "NM": 40, "OK": 1980 }, "production": { "TX": 0, "NM": 9334 }, "completions": { "OK": 964 } },
  "dropped": { "TX": { "wells.truncated_api": 57, "wells.duplicate_api": 1 }, "NM": { "production.amended_duplicates": 5, "production.days_out_of_range": 12 }, "OK": {} } }
```

Every drop reason below is counted here; a reason with zero drops may be omitted.

## 2. Common rules

- **API number**: `SS-CCC-WWWWW` (state code, county code, well number), digits only.
- **Text**: stripped of leading/trailing whitespace, internal runs of whitespace collapsed to one space, upper-cased; empty → NULL. Applies to `well_name`, `operator`, `county`, `field_name`, `formation_*`, `well_number`, `otc_prod_unit_no`.
- **NULL vs zero**: NULL = not reported / not applicable; 0 = reported as zero. Never turn a reported 0 into NULL or a missing value into 0.
- **Codes not in a table** map to `OTHER` (well_type, well_status) or NULL (basin, county-from-FIPS). Tables are in `silver_schema.py`; they are exhaustive for the seed.
- **Dates**: `date32`; `production_date` is the first day of the month.

## 3. `wells` — one row per well from the ArcGIS well master

Columns: `state, api_number, well_name, operator, county, well_type, well_status, latitude, longitude, source_file, ingested_at`.

| | TX (`wells/wells_batch_*.json`, attrs `API, GIS_LAT83, GIS_LONG83`) | NM (attrs `id, name, ogrid_name, county, type, status, latitude, longitude`) | OK (attrs `api, well_name, operator, county, welltype, wellstatus, sh_lat, sh_lon`) |
|---|---|---|---|
| api_number | digits of `API`: 8 digits `CCCWWWWW` → `42-CCC-WWWWW`; 10 digits starting `42` → `42-CCC-WWWWW`; anything else → drop, reason `wells.truncated_api` | `id` must match `30-\d{3}-\d{5}`, else drop `wells.malformed_api` | `api` as an integer with exactly 10 digits starting `35` → `35-CCC-WWWWW`, else drop `wells.malformed_api` |
| well_name | NULL | `name` | `well_name` |
| operator | NULL | `ogrid_name` | `operator` |
| county | `COUNTY_NAME` of any `OG_WELL_COMPLETION` row whose `API_COUNTY_CODE`+`API_UNIQUE_NO` equals the API; NULL if none | `county` | `county` |
| well_type | from `OIL_GAS_CODE` of the well's `OG_WELL_COMPLETION` rows: all `O` → `OIL`, all `G` → `GAS`, mixed → `OTHER`, no rows → NULL | `NM_WELL_TYPE[type]` | `OK_WELL_TYPE[welltype]`; NULL welltype → NULL |
| well_status | NULL (`WELL_14B2_STATUS_CODE` is an extension flag, not a status) | `NM_WELL_STATUS` by prefix (`Active`, `Plugged…`, `Temporary Abandonment…`) | `OK_WELL_STATUS[wellstatus]` |
| latitude / longitude | `GIS_LAT83` / `GIS_LONG83` | `latitude` / `longitude` | `sh_lat` / `sh_lon` |
| source_file | the page file, e.g. `wells/wells_batch_0001.json` | same | same |

Duplicates on `(state, api_number)`: keep the **first** occurrence in page order (page number, then feature order), count the rest as `wells.duplicate_api`.

## 4. `production` — one row per (entity, month)

Columns (23): `state, entity_type, api_number, lease_number, district, well_name, operator, county, field_name, basin, well_type, well_status, latitude, longitude, production_date, oil_bbl, gas_mcf, condensate_bbl, casinghead_gas_mcf, water_bbl, days_produced, source_file, ingested_at`.

### NM — from `production/wcproduction/wcproduction.xml` (one record per well, pool, month, product kind)

1. Read every `<wcproduction>` record. Fields used: `api_cnty_cde, api_well_idn, pool_idn, prodn_yr, prodn_mth, ogrid_cde, prd_knd_cde, prod_amt, prodn_day_num, mod_dte`. `prd_knd_cde` is stripped (`"O "` → `O`).
2. **Amendments**: records sharing `(api, pool_idn, prodn_yr, prodn_mth, kind)` are the same fact re-filed; keep the one with the greatest `mod_dte` (string order; tie → the later one in file order) and count the others as `production.amended_duplicates`.
3. Records with `prodn_mth` outside 1–12 or `prodn_yr` outside 1900–2100 are dropped: `production.invalid_month`. Records whose kind is not `O`, `G`, `W`, `C` are dropped: `production.unknown_kind`.
4. **Row key** = `(api_number, production_date)`; `api_number = 30-{api_cnty_cde:03d}-{api_well_idn:05d}`. A well-month with records in several pools is **one row**; volumes are summed across pools per kind:
   `oil_bbl = Σ O`, `gas_mcf = Σ G`, `water_bbl = Σ W`, `condensate_bbl = Σ C`; a kind with no surviving record that month → NULL (not 0). `casinghead_gas_mcf` = NULL always.
5. `days_produced` = max of `prodn_day_num` over the month's surviving records with `0 ≤ prodn_day_num ≤ 31`; values outside that range are ignored and counted as `production.days_out_of_range`; NULL if none valid.
6. `field_name` = `pool_nam` (from `production/pool/pool.xml`, text-normalised) of the **dominant pool**: the pool with the largest `O + G + C` that month, tie → lowest `pool_idn`. NULL if the pool is not in `pool.xml`.
7. `operator` = `ogrid_nam` (from `production/ogrid/ogrid.xml`) of the most frequent `ogrid_cde` among the month's surviving records, tie → lowest code. NULL if not in `ogrid.xml`.
8. `well_name, county, well_type, well_status, latitude, longitude` = the well's row in `wells` (state NM). If the well is not in `wells`: `county = NM_FIPS_COUNTY[api_cnty_cde]` (NULL if unknown), the others NULL.
9. `basin = BASIN[(state, county)]`, NULL when unmapped. `entity_type = "well"`, `lease_number = district = NULL`, `source_file = "production/wcproduction/wcproduction.xml"`.

### TX — from `OG_LEASE_CYCLE.dsv` (rules stated now, verified when the file is re-fetched)

One row per `(DISTRICT_NO, LEASE_NO, CYCLE_YEAR, CYCLE_MONTH)`; key `(district, lease_number, production_date)`; duplicate keys keep the last row in file order (`production.amended_duplicates`).
`oil_bbl = LEASE_OIL_PROD_VOL`, `gas_mcf = LEASE_GAS_PROD_VOL`, `condensate_bbl = LEASE_COND_PROD_VOL`, `casinghead_gas_mcf = LEASE_CSGD_PROD_VOL` (blank → NULL), `water_bbl = days_produced = NULL`.
`well_name = LEASE_NAME`, `field_name = FIELD_NAME`, `operator = OPERATOR_NAME`, falling back to `OG_OPERATOR_DW.OPERATOR_NAME` by `OPERATOR_NO`.
Lease → wells: the distinct APIs of `OG_WELL_COMPLETION` rows with the same `(DISTRICT_NO, LEASE_NO)`. Exactly one API → `entity_type = "well"`, `api_number` set, `latitude/longitude/county/well_type` from that well's `wells` row; otherwise `entity_type = "lease"`, `api_number = latitude = longitude = NULL`, `county` = the most common `COUNTY_NAME` among those rows (tie → alphabetical first), `well_type` = all `O` → `OIL`, all `G` → `GAS`, mixed → `OTHER`, none → NULL. `well_status = NULL`. `district` = raw `DISTRICT_NO` (2 characters, as filed). `basin` from the county table. `source_file = "OG_LEASE_CYCLE.dsv"`.

When `OG_LEASE_CYCLE.dsv` is absent the TX production file is written empty with the schema and `rows.production.TX = 0`.

## 5. `completions` — OK only, one row per source row of `data/completions_wells_formations.xlsx`

The sheet's grain is (completion, formation); it is kept as-is with `row_no` (1-based data row index) as part of the identity. No deduplication.

Columns: `state, api_number, completion_no, row_no, well_name, well_number, operator, county, well_type, well_status, formation_name, formation_code, spud_date, completion_date, first_prod_date, test_date, oil_bbl_per_day, gas_mcf_per_day, water_bbl_per_day, latitude, longitude, otc_prod_unit_no, source_file, ingested_at`.

- `api_number` from `API_Number` (10 digits starting `35`), else drop `completions.malformed_api`.
- `county` from `County` `"003-ALFALFA"` → `ALFALFA` (text after the first `-`; whole value if no dash).
- `well_type` / `well_status` via the OK tables; `well_number` = `Well_Number` as text.
- Dates from `Spud, Well_Completion, First_Prod, Test_Date`: `YYYY-MM-DD` strings; `1900-01-01`, blank or unparseable → NULL.
- Rates from `Oil_BBL_Per_Day, Gas_MCF_Per_Day, Water_BBL_Per_Day`: numeric as given (0 stays 0), blank → NULL.
- `latitude`/`longitude` from `Surf_Lat_Y`/`Surf_Long_X`; `otc_prod_unit_no` text-normalised (`" "` → NULL).
- `source_file = "data/completions_wells_formations.xlsx"`.

## 6. Interface (task `dw-silver`)

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/silver.py --bronze data/bronze --out data/silver [--states tx nm ok]
```

Reads only `data/bronze/`; writes only under `--out`; imports `contract/silver_schema.py` for schemas and tables; ≤ 450 code lines; standard library + `pyarrow` + `openpyxl` (+ `pandas` if wanted); finishes in under 20 s on the seed.

## 7. Oracle checks

Per (table, state): file present; schema identical; row count equal; every row equal to the reference reader's (sorted by key, all columns except `ingested_at`, floats exact); `manifest.json` rows and drop counts equal. Plus `labels.json`: hand-traced rows with the raw evidence quoted, checked on the candidate (the reference passes them too, by construction and by `tools/verify-task.mjs`).
