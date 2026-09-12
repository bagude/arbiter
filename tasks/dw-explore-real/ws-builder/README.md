# dw-explore-real workspace — the full warehouse, read-only

`data/real/` is a **read-only mount** of a snapshot of the real pipeline output (9 GB; reads are fine, writes are refused):

- `data/real/warehouse.duckdb` — gold. Tables: `production_monthly` (93,179,419 rows: TX 73.3 M lease-months 1993–2026 over 336,680 entities; NM 19.4 M well-months 1986–2026 over 86,592 wells; OK 486 k rows 1950–2026 over 454,921 entities), `decline_curve_inputs` (54,710,060 rows), `schema_registry`, `schema_registry_columns`, and `stg_production` (a view over silver files outside the snapshot — do not query it). Columns and definitions: `contract/contract-gold.md` (this warehouse predates the `wells`/`completions` tables; it has neither).
- `data/real/silver/production/state=<XX>/*.parquet` — the silver the gold was built from (TX 977 MB, NM 110 MB, OK 14 MB). Read with `pyarrow.parquet.ParquetFile(p)` and row groups, never whole into memory.
- `data/real/bronze/<state>/<pull_date>/manifest.json` — the pulls' manifests (TX has none).

Known provenance (from `source_file`): TX rows come from `2026-02-11/OG_LEASE_CYCLE.dsv`, NM from `wcproduction.xml`, OK from `arcgis_rbdms_wells` (a well master stamped with the pull month, no volumes) and `completions_wells_formations.xlsx` (IP tests). The contracts under `contract/` describe the intended semantics of the seed pipeline; this warehouse was built by the earlier code, so differences are findings.

Your deliverable is `src/exploration.json` + `src/exploration.md` (see the specification in your prompt). Open the warehouse read-only:

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "import duckdb; c=duckdb.connect('data/real/warehouse.duckdb', read_only=True); print(c.execute('describe production_monthly').fetchall())"
```

Queries you cite must finish in under 10 s. Only `src/` is graded; scratch notes go under `src/notes/`.
