# dw-paper-apply workspace — SPE 162910's time-rate models on the real warehouse

Two read-only mounts:

- `data/real/` — a snapshot of the real pipeline output: `data/real/warehouse.duckdb` with `production_monthly` (93,179,419 rows) and `decline_curve_inputs` (54,710,060 rows: per well, `months_on_production`, `total_oil_bbl`, `total_gas_mcf`, `initial_oil_rate`, `cumulative_oil`, `cumulative_gas`). 84,577 TX and 44,805 NM wells have 60 or more producing months. Columns: `contract/contract-gold.md`. Do not query `stg_production`.
- `paper/` — the text of SPE 162910, one file per page (`paper/index.md`, `paper/pages/pNN.txt`); Appendix A (pages 59–61) lists the models; equations extract garbled, the nomenclature on page 10 is reliable.

Deliverable: `src/exploration.json` + `src/exploration.md` (see the specification). Each observation fits one of the paper's models to rows a query returns, and carries the fit as a `compute` snippet the host re-runs on those rows. Only `src/` is graded; scratch under `src/notes/`.

Python: `uv run --no-project --python 3.13 --with-requirements requirements.txt python -c "…"` with `duckdb`, `pyarrow`, `pandas`, `numpy`, `scipy`. Open the warehouse read-only: `duckdb.connect("data/real/warehouse.duckdb", read_only=True)`. Queries you cite must finish in under 10 s and return at most 50 rows; a per-well rate-time series fits in 50 rows (e.g. the first 48 months).
