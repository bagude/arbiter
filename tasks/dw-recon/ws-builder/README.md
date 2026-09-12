# dw-recon workspace — one pipeline state to reconcile

- `data/bronze/<state>/<pull_date>/` — the raw pulls as received, each with `manifest.json` (`pull_date`, `pulled_at`, `sources`, and one entry per file with `bytes`, `sha256`, `records` or zip `members`, `source`, `from`). Contract: `contract/contract-bronze.md`.
- `data/silver/<table>/state=<XX>/<xx>_<table>.parquet` — `wells` (TX/NM/OK), `production` (TX/NM; TX is empty in this pull), `completions` (OK). `data/silver/manifest.json` has `rows` per table and state and `dropped` counts per state with reasons. Schemas and code tables: `contract/silver_schema.py`; rules: `contract/contract-silver.md`.
- `data/gold/warehouse.duckdb` — tables `production_monthly`, `decline_curve_inputs`, `wells`, `completions`. Contract: `contract/contract-gold.md`.

Your deliverable is `src/health.json` + `src/health.md` (see the specification in your prompt). Python is available as

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "..."
```

with `pyarrow`, `duckdb`, `openpyxl`, `pandas` pinned. Read parquet with `pyarrow.parquet.ParquetFile(p).read()`; open DuckDB read-only. Everything under `data/` and `contract/` is read-only input; write only under `src/`.
