# Pipeline health — pull 2026-02-11 (generated 2026-09-12T15:58:57Z)

- **TX** [ERROR]: landed 2026-09-12T15:54:44Z (4 files, 2919 records); silver wells 230, production 0 rows None→None (freshness None months, 0 gap-months); gold parity ok
- **NM** [ok]: landed 2026-09-12T15:54:44Z (9 files, 21721 records); silver wells 40, production 9334 rows 1973-10-01→2025-12-01 (freshness 2 months, 3167 gap-months); gold parity ok
- **OK** [ok]: landed 2026-09-12T15:54:47Z (4 files, 7480 records); silver wells 1980, completions 964; gold parity ok

## KPI

| state | layer | metric | value |
|---|---|---|---|
| TX | bronze | pull_date | 2026-02-11 |
| TX | bronze | landed_at | 2026-09-12T15:54:44Z |
| TX | bronze | files | 4 |
| TX | bronze | bytes | 229435 |
| TX | bronze | records | 2919 |
| TX | silver | wells.rows | 230 |
| TX | silver | wells.with_production | 0 |
| TX | silver | production.rows | 0 |
| TX | silver | production.first_month | None |
| TX | silver | production.last_month | None |
| TX | silver | production.freshness_months | None |
| TX | silver | production.entities | 0 |
| TX | silver | production.gap_months | 0 |
| TX | silver | dropped.wells.duplicate_api | 1 |
| TX | silver | dropped.wells.truncated_api | 57 |
| TX | gold | production_monthly.rows | 0 |
| TX | gold | decline_curve_inputs.rows | 0 |
| TX | gold | wells.rows | 230 |
| TX | gold | parity | True |
| NM | bronze | pull_date | 2026-02-11 |
| NM | bronze | landed_at | 2026-09-12T15:54:44Z |
| NM | bronze | files | 9 |
| NM | bronze | bytes | 22426818 |
| NM | bronze | records | 21721 |
| NM | silver | wells.rows | 40 |
| NM | silver | wells.with_production | 40 |
| NM | silver | production.rows | 9334 |
| NM | silver | production.first_month | 1973-10-01 |
| NM | silver | production.last_month | 2025-12-01 |
| NM | silver | production.freshness_months | 2 |
| NM | silver | production.entities | 40 |
| NM | silver | production.gap_months | 3167 |
| NM | silver | dropped.production.amended_duplicates | 5 |
| NM | silver | dropped.production.days_out_of_range | 127 |
| NM | gold | production_monthly.rows | 9334 |
| NM | gold | decline_curve_inputs.rows | 6861 |
| NM | gold | wells.rows | 40 |
| NM | gold | parity | True |
| OK | bronze | pull_date | 2026-02-11 |
| OK | bronze | landed_at | 2026-09-12T15:54:47Z |
| OK | bronze | files | 4 |
| OK | bronze | bytes | 3839809 |
| OK | bronze | records | 7480 |
| OK | silver | wells.rows | 1980 |
| OK | silver | wells.with_production | 0 |
| OK | silver | completions.rows | 964 |
| OK | gold | wells.rows | 1980 |
| OK | gold | completions.rows | 964 |
| OK | gold | parity | True |

## Findings

### F1 [error] bronze/TX — TX pull carries no monthly production table

The bronze manifest lists OG_COUNTY_CYCLE, OG_OPERATOR_DW, OG_WELL_COMPLETION and one wells page but no OG_LEASE_CYCLE.dsv, which the silver contract names as the only TX production source. Silver TX production is therefore empty and gold has no TX rows; the county rollup cannot be reconciled until the table is re-fetched.

- evidence: `data/bronze/tx/2026-02-11/manifest.json` — `"path": "OG_WELL_COMPLETION.dsv"`
- evidence: `contract/contract-silver.md` — `When `OG_LEASE_CYCLE.dsv` is absent the TX production file is written empty`
- kpi: `TX.silver.production.rows`

### F2 [warn] silver/TX — One in five TX ArcGIS well records has a truncated API and was dropped

The wells page holds APIs shortened to three characters; the silver contract drops and counts them as wells.truncated_api rather than guessing. Coordinates for those wells are lost until the source is re-pulled with full APIs.

- kpi: `TX.silver.dropped`
- evidence: `data/silver/manifest.json` — `"wells.truncated_api"`
- evidence: `contract/contract-silver.md` — `wells.truncated_api`

### F3 [info] silver/NM — NM production is complete through the pull month and multi-pool months are summed

Silver NM production covers 40 wells with 9334 well-months; the latest month is within the pull's freshness window. Per the contract, well-months spanning several pools are one row with volumes summed per kind and the dominant pool as field_name, and re-filed records are resolved by the latest mod_dte (5 amended duplicates dropped).

- kpi: `NM.silver.production.last_month`
- kpi: `NM.silver.production.freshness_months`
- evidence: `contract/contract-silver.md` — `volumes are summed across pools per kind`
- evidence: `data/silver/manifest.json` — `"production.amended_duplicates"`

### F4 [info] cross/OK — OK contributes wells and completions, no monthly production

The OK pull has the ArcGIS wells page, the RBDMS CSV and the completions/ITD sheets but no production source; by contract OK feeds the wells and completions tables only, and gold carries them through with row parity.

- evidence: `contract/contract-silver.md` — ``completions` for OK`
- kpi: `OK.gold.parity`
- kpi: `OK.silver.completions.rows`

### F5 [info] gold/all — Gold row parity holds for every state

For each state the gold production_monthly (or completions) and wells row counts equal the silver counts, so the gold build neither dropped nor duplicated rows.

- kpi: `TX.gold.parity`
- kpi: `NM.gold.parity`
- kpi: `OK.gold.parity`
