# dw-explore workspace — the warehouse, ready to explore

- `data/gold/warehouse.duckdb` — `production_monthly` (one row per entity-month: identity, descriptive fields, `production_date`, volumes, totals, cumulatives, `reported_month_index`, `calendar_months_on_production`, `vintage`, `initial_gor`), `decline_curve_inputs` (producing well-months with `months_on_production`, initial rates, `oil_rate_pct_of_initial`, cumulatives), `wells` (one row per well: TX/NM/OK), `completions` (OK completion rows with IP test rates). Definitions: `contract/contract-gold.md`.
- `data/silver/` — the Parquet the gold was built from, plus `manifest.json` (rows and drop counts). Schemas: `contract/silver_schema.py`. Read with `pyarrow.parquet.ParquetFile(p).read()`.
- `contract/contract-silver.md` and `contract-bronze.md` — what the data is supposed to mean (NULL vs zero, units, how NM multi-pool months were summed, why TX production is empty in this pull, why OK has completions instead of production).

This pull: TX county 421 (Sherman) wells only, no TX production; NM 40 wells with full monthly histories 1973–2025; OK Alfalfa county wells and completions.

Your deliverable is `src/exploration.json` + `src/exploration.md` (see the specification in your prompt). Open the warehouse read-only:

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "import duckdb; c=duckdb.connect('data/gold/warehouse.duckdb', read_only=True); print(c.execute('describe production_monthly').fetchall())"
```

Only `src/` is graded; scratch notes go under `src/notes/`.
