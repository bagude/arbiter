# Tiered oracles for the data-warehousers pipeline — design

Date: 2026-09-12. Target: `C:\Users\user\Downloads\claude_playground\data-warehousers` (read-only; copied, never written). Home for everything built here: this arbiter checkout under `tasks/dw-*`, `tools/dw/`, `docs/dw/`.

## 1. Why tiers, and why nothing comes from the current code

The repo is a medallion pipeline (bronze raw → silver Parquet → gold DuckDB) for TX/NM/OK oil & gas data. Its only end-to-end check compares the parsers' output on a *synthetic* fixture ("Acme Oil Co", "Permian Star 1") whose formats differ from the real downloads. So "same output as before" would only reproduce the current bugs. The bronze directories themselves already show why the outputs cannot be trusted (audit in `docs/dw/bronze-audit-real.md`):

- TX `2026-02-11` has no `OG_LEASE_CYCLE.dsv` — the monthly production table (it was in the deleted 3.4 GB zip). No manifest.
- NM manifest claims 139,823 wells; one batch file (10,000) exists. `wcproduction.zip` (47 GB inside) was never extracted; manifest says 4 production files.
- OK manifest says `csv_downloaded: false` while the CSV and both XLSX files are present.
- OK has no monthly-production source at all; its silver "production" rows are completion IP tests dated by test month, plus one row per well dated *today* with null volumes.
- NM production is per (well, pool, month); the parser dedups on (well, month) and silently drops the other pools' volumes.
- 20% of TX ArcGIS well records carry a 3-character API (truncated).

Rule for every oracle below: **expected values never come from the current parsers.** Bronze truth is the bytes on disk; silver truth is an independent minimal reader over the raw seed plus hand-traced labels; gold truth is independent recomputation from oracle-passed silver.

## 2. Seeds (the fixed inputs)

A seed is a small, real slice of each agency's download, carved once by `tools/dw/carve.py` from the Downloads repo (read-only) into `tasks/dw-seed/remote/<state>/…`. Files keep their real formats (TX `}`-delimited latin-1 DSV, NM UTF-16 SQL-Server XML with namespaces, ArcGIS paginated JSON, OK CSV/XLSX).

| State | Slice | Contents |
|---|---|---|
| TX | county 421 (Sherman) | `OG_WELL_COMPLETION` rows for county 421; `OG_COUNTY_CYCLE` rows for county 421 (independent monthly rollup — a cross-check when lease data exists); `OG_OPERATOR_DW` sample; ArcGIS wells page(s) for the county incl. the truncated-API records as received. `OG_LEASE_CYCLE` is **absent** until the user re-fetches it; the seed and contracts are built so it drops in. |
| NM | ~40 wells from `wells_batch_0001.json` that also appear in `wcproduction.xml` | wells page with those features; every `wcproduction` record for those APIs (streamed from the 47 GB member); `wchistory` records for those APIs; `ogrid` rows referenced; `pool` rows referenced. |
| OK | ALFALFA county wells from `wells_batch_0001.json` (1,980) | that page as received; `rbdms_well_data.csv` rows for those APIs; completions and ITD rows for those APIs written back as XLSX with the original headers. |

The seed is the "remote". Manifests are not carried over: a manifest is what the bronze layer must *produce*.

## 3. Bronze — "exactly as received, nothing lost"

Contract (`docs/dw/contract-bronze.md`): `data/bronze/<state>/<pull_date>/` holds the files in the agency layout; `manifest.json` lists every file with `bytes`, `sha256`, and `records` (features for ArcGIS pages, data rows for DSV/CSV/XLSX, top-level records for XML), the zip members it came from, the source URLs, and `pulled_at`. Nothing in bronze is transformed.

Oracle (`tasks/dw-bronze/oracle/bronze_check.py`): for a `(remote, bronze)` pair — every required remote file present; byte-identical (sha256) to the remote (zip members compared by member bytes); no extra files; manifest lists exactly the files present with correct sizes/hashes; `records` equals an independent count; two runs give the same manifest apart from `pulled_at`. The same checker pointed at the real `data/bronze` produces the audit report.

Task `dw-bronze`: workspace has `remote/` (the seed) and the contract; the agent writes `src/bronze.py` (≤ 250 lines, stdlib + openpyxl only) that materialises bronze from `remote/`. Graded by the checker via `validate.mjs`.

## 4. Silver — "canonical, complete, true to the raw"

Contract (`docs/dw/contract-silver.md`): three Parquet tables, Hive-partitioned by `state`:

- `production` — the existing 23-column `PRODUCTION_SCHEMA`, with these rulings: `state ∈ {TX, NM}` (OK has no production source); NM volumes are **summed across pools** per (api, month), `field_name` = pool with the largest oil+gas that month, `days_produced` = max; TX rows are lease-months, `entity_type='well'` only when the lease has exactly one completion; text fields upper-cased and stripped; `district` is the raw 2-character `DISTRICT_NO`; `api_number` is `SS-CCC-WWWWW`; NULL/zero semantics as documented; `ingested_at` is lineage only and never compared.
- `wells` — one row per well from the well master (TX/NM/OK): `state, api_number, well_name, operator, county, field_name, well_type, well_status, latitude, longitude, source_file, ingested_at`. TX truncated APIs are dropped and **counted** in the run manifest, not silently.
- `completions` — OK only, one row per (api, completion_no): IP test rates as `oil_bbl_per_day, gas_mcf_per_day, water_bbl_per_day`, `test_date`, formation. Never presented as production.

Oracle: (1) schema equality with the contract's PyArrow schema; (2) row parity and value equality against `oracle/reference/silver_ref.py`, an independent minimal reader (csv module, `iterparse`, json, openpyxl — no pandas) that the user can read in one sitting; (3) `labels.json`: hand-traced rows per state with the raw line quoted, checked against both the reference and the candidate (the reference must pass its own labels — `tools/verify-task.mjs`). Only `src/` is graded; `ingested_at` excluded.

Task `dw-silver`: workspace has trusted `data/bronze/` (reference-produced) and the contract; agent writes `src/silver.py`.

## 5. Gold — "the SQL says what silver says"

Contract (`docs/dw/contract-gold.md`): `production_monthly` and `decline_curve_inputs` as defined today (entity_key, totals, cumulatives, reported_month_index, calendar months, vintage, initial GOR, DCA fields), plus `wells` passed through; the 12 `assert_*` tests restated; a new reconciliation: TX `OG_COUNTY_CYCLE` monthly county totals must equal the sum of gold lease-months for that county and month (when lease data exists).

Oracle: recompute gold from the oracle-passed silver goldens with the contract's own SQL, compare table contents (sorted, `ingested_at` excluded); run the asserts; run the county reconciliation.

Task `dw-gold`: workspace has trusted `data/silver/` (reference goldens); agent writes `src/gold.py`.

## 6. Running Python inside arbiter

Agents and oracles run Python via `uv run --no-project --python 3.13 --with-requirements requirements.txt python …` (warm start 0.13 s; environments cached outside the workspace, so nothing is copied per run and the path guard sees only workspace-relative arguments). `requirements.txt` pins pyarrow, duckdb, openpyxl (and pandas for agents who want it). `validate.mjs`/`probe.mjs` are thin node wrappers around the Python checkers (the supervisor's 60 s oracle timeout is the budget; seeds are sized for it).

## 7. Repo-scoped memory ("the data-warehousers agent")

A run config gains `"repo": "data-warehousers"`. Memory records retained from dw runs go to scope `repo:<name>` in addition to `task:<name>`; recall for a run with a `repo` includes that scope. The agent is a (prompt, memory scope, guard) triple — no persona. Promotion stays oracle-gated, so "TX pull lacks OG_LEASE_CYCLE" becomes a promoted fact only with oracle evidence. `lib/memory.mjs` `validScope` accepts `repo:<name>`; supervisor retention/recall plumb the scope; `tools/memory.mjs` unchanged.

## 8. Verification of the oracles themselves

`tools/verify-task.mjs` learns the `validate.mjs` shape: a task with `oracle/reference/` is verified by copying the reference into a scratch workspace as `src/` and requiring `pass === total`; the shipped stub must not pass. Bronze/silver/gold references are the seed pipeline run end to end, so verifying the three tasks also proves the seeds are internally consistent.

## 9. Out of scope

Network ingestion (the seed stands in for it), dagster, dbt, papers/economics/mcp_server/viz, the 19 GB of real data (only the carved seed is committed, ≤ ~30 MB total), and any write to the Downloads repo.

## 10. Open decisions for the user

1. Re-fetch TX `OG_LEASE_CYCLE` (3.4 GB download) so TX production can be verified; everything is built to accept it.
2. NM multi-pool ruling: sum across pools (default) vs. one row per (well, pool, month).
3. OK: wells + completions only (default) vs. keeping IP tests as "production".
4. Silver `wells` and `completions` tables are new; confirm the columns.
