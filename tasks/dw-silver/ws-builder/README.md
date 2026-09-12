# dw-silver workspace

`data/bronze/<state>/2026-02-11/` is a trusted bronze pull (raw agency files, bytes as received; `manifest.json` lists every file with sizes, hashes and record counts):

- **tx**: `OG_WELL_COMPLETION.dsv`, `OG_OPERATOR_DW.dsv`, `OG_COUNTY_CYCLE.dsv` — `}`-delimited, latin-1, header first. No `OG_LEASE_CYCLE.dsv` in this pull. `wells/wells_batch_0001.json` — ArcGIS page, `features[].attributes.{API, GIS_LAT83, GIS_LONG83}`; some `API` values are truncated to 3 characters.
- **nm**: `wells/wells_batch_0001.json` — ArcGIS page with `id` (API), `name`, `ogrid_name`, `county`, `type`, `status`, `latitude`, `longitude`, …; `production/<name>.zip` and the extracted `production/<name>/<name>.xml` for `wcproduction`, `wchistory`, `ogrid`, `pool` — UTF-16 LE with BOM, an `<xsd:schema>` then one `<name xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">…</name>` per record; field values may carry trailing spaces.
- **ok**: `wells/wells_batch_0001.json` — ArcGIS page (`api` is an integer); `data/rbdms_well_data.csv`; `data/completions_wells_formations.xlsx` (first sheet, 117 columns); `data/itd_wells_formations.xlsx`.

`contract/silver_schema.py` is the contract as code: the three PyArrow schemas, key columns, code tables (`NM_WELL_TYPE`, `nm_status`, `ok_type`, `ok_status`, `TX_WELL_TYPE`, `NM_FIPS_COUNTY`, `BASIN`, `NM_KINDS`) and `norm_text`. Import it from `src/silver.py` (e.g. `sys.path.insert(0, "contract")`); do not modify it.

Run your implementation with:

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python src/silver.py --bronze data/bronze --out data/silver
```

Only `src/` is graded; scratch notes go under `src/notes/`. `pyarrow`, `openpyxl` and `pandas` are pinned in `requirements.txt`.
