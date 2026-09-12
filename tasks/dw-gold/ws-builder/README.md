# dw-gold workspace

- `data/silver/<table>/state=<XX>/<xx>_<table>.parquet` — trusted silver tables (`wells` for TX/NM/OK, `production` for TX/NM — TX is empty in this pull — and `completions` for OK). Schemas: `contract/silver_schema.py` (`WELLS_SCHEMA`, `PRODUCTION_SCHEMA`, `COMPLETIONS_SCHEMA`). Every file carries `state` as a column, so read with `read_parquet(..., hive_partitioning = false)`.
- `data/silver/manifest.json` — row counts per table and state.
- `data/reference/OG_COUNTY_CYCLE.dsv` — the Texas RRC's monthly county rollup (`}`-delimited, latin-1, header first; `COUNTY_NO`, `COUNTY_NAME`, `CYCLE_YEAR`, `CYCLE_MONTH`, `CNTY_OIL_PROD_VOL`, `CNTY_GAS_PROD_VOL`, `CNTY_COND_PROD_VOL`, `CNTY_CSGD_PROD_VOL`, …).

Your deliverable is `src/gold.py` (see the specification in your prompt). Run it with:

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python src/gold.py --silver data/silver --out data/gold/warehouse.duckdb --county-cycle data/reference/OG_COUNTY_CYCLE.dsv
```

Inspect the result with `uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "import duckdb; print(duckdb.connect('data/gold/warehouse.duckdb', read_only=True).execute('describe production_monthly').fetchall())"`. Only `src/` is graded; scratch notes go under `src/notes/`.
