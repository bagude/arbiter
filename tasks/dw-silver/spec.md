Build the **silver layer** of an oil & gas data warehouse: canonical Parquet tables derived from a trusted bronze pull for Texas (RRC), New Mexico (OCD) and Oklahoma (OCC). The workspace holds `data/bronze/` (raw agency files, exactly as received, with a manifest) and `contract/silver_schema.py` (the schemas and code tables — import it, do not restate or edit it). Read the workspace README first; it names every raw file and its format.

## Deliverable

`src/silver.py`, runnable as

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/silver.py --bronze data/bronze --out data/silver [--states tx nm ok]
```

Reads only `data/bronze/`; writes only under `--out`; exits 0; standard library + `pyarrow` + `openpyxl` (`pandas` allowed); at most 450 code lines; finishes in under 20 s. Only `src/` is graded.

## Contract (this is what the hidden oracle checks)

### Storage

`data/silver/<table>/state=<XX>/<xx>_<table>.parquet` with **exactly** the PyArrow schema from `contract/silver_schema.py` (`WELLS_SCHEMA`, `PRODUCTION_SCHEMA`, `COMPLETIONS_SCHEMA`); `state` stored as a plain string column. Tables per state: `wells` for TX, NM, OK; `production` for TX and NM (TX is an **empty file with the schema** when `OG_LEASE_CYCLE.dsv` is absent, which it is in this pull); `completions` for OK. `data/silver/manifest.json`:

```json
{ "rows": { "wells": { "TX": 230, "NM": 40, "OK": 1980 }, "production": { "TX": 0, "NM": 9334 }, "completions": { "OK": 964 } },
  "dropped": { "TX": { "wells.truncated_api": 57, "wells.duplicate_api": 1 }, "NM": { "production.amended_duplicates": 5 }, "OK": {} } }
```

(numbers illustrative; zero-count reasons may be omitted). `ingested_at` is the run's UTC timestamp and is never compared.

### Common rules

- API number `SS-CCC-WWWWW`. Text fields (`norm_text` in the contract module): decode XML/HTML entities (`&amp;` → `&`, `&#x20;` → space), strip, collapse internal whitespace to one space, upper-case, empty → NULL. NULL = not reported; 0 = reported zero; never convert one into the other. Codes outside a table → `OTHER` (well_type/well_status) or NULL (basin, county from FIPS). Dates are `date32`; `production_date` is the first of the month.

### `wells` — one row per well of the ArcGIS pages (`wells/wells_batch_*.json`, in page then feature order)

| | TX (`API, GIS_LAT83, GIS_LONG83`) | NM (`id, name, ogrid_name, county, type, status, latitude, longitude`) | OK (`api, well_name, operator, county, welltype, wellstatus, sh_lat, sh_lon`) |
|---|---|---|---|
| api_number | digits of `API`: 8 digits `CCCWWWWW` → `42-CCC-WWWWW`; 10 digits starting `42` → split; else **drop** (`wells.truncated_api`) | `id` must match `30-\d{3}-\d{5}` else drop (`wells.malformed_api`) | integer with exactly 10 digits starting `35` → `35-CCC-WWWWW`, else drop (`wells.malformed_api`) |
| well_name / operator | NULL / NULL | `name` / `ogrid_name` | `well_name` / `operator` |
| county | `COUNTY_NAME` of the first `OG_WELL_COMPLETION.dsv` row whose `API_COUNTY_CODE`+`API_UNIQUE_NO` equals the API; NULL if none | `county` | `county` |
| well_type | `OIL_GAS_CODE` of the well's completion rows: all `O` → OIL, all `G` → GAS, mixed → OTHER, none → NULL | `NM_WELL_TYPE[type]`, unknown → OTHER, missing → NULL | `ok_type(welltype)`; missing → NULL |
| well_status | NULL | `nm_status(status)` | `ok_status(wellstatus)` |
| latitude / longitude | `GIS_LAT83` / `GIS_LONG83` | `latitude` / `longitude` | `sh_lat` / `sh_lon` |
| source_file | `wells/wells_batch_NNNN.json` | same | same |

Duplicate `(state, api_number)`: keep the first occurrence, count the rest as `wells.duplicate_api`.

`OG_WELL_COMPLETION.dsv` is `}`-delimited, latin-1, header row first.

### `production` — NM, from `production/wcproduction/wcproduction.xml`

The XML is UTF-16 LE with a BOM; after an `<xsd:schema>`, one `<wcproduction xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">` element per record with child elements `api_cnty_cde, api_well_idn, pool_idn, prodn_yr, prodn_mth, ogrid_cde, prd_knd_cde, prod_amt, prodn_day_num, mod_dte` (and others). One record per well, pool, month and **product kind** (`prd_knd_cde`, strip it: `O` oil, `G` gas, `W` water, `C` condensate).

1. **Amendments**: records with the same `(api, pool_idn, prodn_yr, prodn_mth, kind)` are one fact re-filed; keep the greatest `mod_dte` (string order; tie → later in file), count the others as `production.amended_duplicates`.
2. Drop records with `prodn_mth` outside 1–12 or `prodn_yr` outside 1900–2100 (`production.invalid_month`) and kinds other than O/G/W/C (`production.unknown_kind`).
3. **One row per (well, month)**: `api_number = 30-{api_cnty_cde:03d}-{api_well_idn:05d}`, `production_date = date(yr, mth, 1)`. Volumes are **summed across pools** per kind: `oil_bbl = Σ O`, `gas_mcf = Σ G`, `water_bbl = Σ W`, `condensate_bbl = Σ C`; a kind with no surviving record that month → NULL. `casinghead_gas_mcf` = NULL.
4. `days_produced` = max `prodn_day_num` over the month's surviving records with `0 ≤ value ≤ 31`; others are ignored and counted (`production.days_out_of_range`); NULL if none valid.
5. `field_name` = `pool_nam` from `production/pool/pool.xml` (`<pool>` records: `pool_idn`, `pool_nam`), text-normalised, of the **dominant pool**: largest `O + G + C` that month, tie → lowest `pool_idn`; NULL if unknown pool.
6. `operator` = `ogrid_nam` from `production/ogrid/ogrid.xml` (`<ogrid>` records: `ogrid_cde`, `ogrid_nam`) of the most frequent `ogrid_cde` among the month's records, tie → lowest code; NULL if unknown.
7. `well_name, county, well_type, well_status, latitude, longitude` from the well's `wells` row (state NM); if none: `county = NM_FIPS_COUNTY[api_cnty_cde]` (else NULL), the rest NULL.
8. `basin = BASIN[(state, county)]` else NULL; `entity_type = "well"`; `lease_number = district = NULL`; `source_file = "production/wcproduction/wcproduction.xml"`.

### `production` — TX, from `OG_LEASE_CYCLE.dsv` (absent in this pull → empty file with the schema, `rows.production.TX = 0`)

One row per `(DISTRICT_NO, LEASE_NO, CYCLE_YEAR, CYCLE_MONTH)`, later duplicates win (`production.amended_duplicates`). `oil_bbl/gas_mcf/condensate_bbl/casinghead_gas_mcf` = `LEASE_OIL_PROD_VOL/LEASE_GAS_PROD_VOL/LEASE_COND_PROD_VOL/LEASE_CSGD_PROD_VOL` (blank → NULL); `water_bbl = days_produced = NULL`; `well_name = LEASE_NAME`, `field_name = FIELD_NAME`, `operator = OPERATOR_NAME` else `OG_OPERATOR_DW` by `OPERATOR_NO`; `district` = raw `DISTRICT_NO`; `lease_number = LEASE_NO`. The lease's wells are the distinct APIs of `OG_WELL_COMPLETION` rows with the same `(DISTRICT_NO, LEASE_NO)`: exactly one → `entity_type = "well"`, `api_number` set, `county/well_type/latitude/longitude` from its `wells` row; otherwise `entity_type = "lease"`, `api_number/latitude/longitude` NULL, `county` = most common `COUNTY_NAME` (tie → alphabetical), `well_type` all O → OIL / all G → GAS / mixed → OTHER / none → NULL. `well_status = NULL`; `basin` from the table; `source_file = "OG_LEASE_CYCLE.dsv"`.

### `completions` — OK, one row per data row of `data/completions_wells_formations.xlsx` (first sheet, header row first)

No deduplication; `row_no` = 1-based data row index. `api_number` from `API_Number` (10 digits starting `35`) else drop (`completions.malformed_api`); `completion_no` = `Completion_No`; `well_name = Well_Name`, `well_number = Well_Number` (as text), `operator = Operator_Name`; `county` = `County` after its first `-` (`003-ALFALFA` → `ALFALFA`); `well_type = ok_type(Well_Type)`, `well_status = ok_status(Well_Status)`; `formation_name/formation_code` = `Formation_Name/Formation_Code`; `spud_date/completion_date/first_prod_date/test_date` from `Spud/Well_Completion/First_Prod/Test_Date` (`YYYY-MM-DD` strings or Excel dates; `1900-01-01`, blank or unparseable → NULL); `oil_bbl_per_day/gas_mcf_per_day/water_bbl_per_day` from `Oil_BBL_Per_Day/Gas_MCF_Per_Day/Water_BBL_Per_Day` as numbers (0 stays 0, blank → NULL); `latitude/longitude` from `Surf_Lat_Y/Surf_Long_X`; `otc_prod_unit_no` from `OTC_Prod_Unit_No` text-normalised; `source_file = "data/completions_wells_formations.xlsx"`.

### The oracle's checks

Per (table, state): file present; schema identical to the contract; row count; every row equal to an independent reference reader's (matched on the table's `KEYS`, all columns except `ingested_at`, exact values); `manifest.json` rows and drop counts; hand-traced label rows. Plus: `contract/silver_schema.py` unmodified; ≤ 450 code lines; no network/process modules.

## Verification channel

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["<table>", "<STATE>"] }` (e.g. `["production", "NM"]`) and returns the oracle's pass/total for that table and the exact failing checks with sample differences. Probe every (table, state) before claiming `kind="done"`.
