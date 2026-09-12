# Bronze audit of the real `data/bronze` (data-warehousers, pulls 2026-02-11 / 2026-02-13)

Produced by `tasks/dw-bronze/oracle/bronze_check.py audit` on 2026-09-12 against the Downloads copy of the repo (`data/bronze`, read-only). Expected values come from the bytes on disk, never from the pipeline's code.

Result: **15/29 checks pass**.

## Findings

1. **TX has no monthly production.** `OG_LEASE_CYCLE.dsv` is absent (it was inside the 3.4 GB `PDQ_DSV.zip`, deleted after extraction). No TX manifest exists. Two stray files (`daf420.dat`, `drilling_permit_manual.pdf`) sit in the pull directory outside the layout.
2. **NM wells are 7% of what the manifest claims.** `manifest.json` says 139,823 well features; one page file with 10,000 features exists.
3. **NM production was never extracted.** `wcproduction.zip` holds a 47 GB `wcproduction.xml`; the other three zips are extracted. The manifest says `production_files: 4` as if all were usable.
4. **OK manifest is stale.** It says `csv_downloaded: false`, `csv_path: null` and has no completions/ITD keys, while the CSV and both XLSX files are present (later code added them without rewriting the manifest).
5. **Manifests store absolute machine paths** (`wells_dir`, `production_dir`, `data_dir`) and carry no per-file identity (no sizes, hashes or counts), so nothing downstream can tell a partial pull from a complete one.

Everything downstream (silver Parquet, the 8 GB DuckDB) was built from these inputs. Findings 1–3 mean TX production and NM production/wells in silver cannot be from these pulls, or are partial.

## Check table

| state | check | result | detail |
|---|---|---|---|
| tx | layout | **FAIL** | manifest.json missing |
| tx | no_extras | **FAIL** | 2026-02-11: files outside the layout: ['daf420.dat', 'drilling_permit_manual.pdf'] |
| tx | completeness | **FAIL** | 2026-02-11: required artifacts missing: ['OG_LEASE_CYCLE.dsv'] |
| tx | pages_contiguous | pass | 1393 pages, numbering contiguous |
| nm | layout | pass | pull 2026-02-11, manifest ok |
| nm | no_extras | pass | 2026-02-11: files outside the layout: [] |
| nm | completeness | **FAIL** | 2026-02-11: required artifacts missing: ['production/wcproduction/wcproduction.xml'] |
| nm | zip_extracted | pass | ogrid.zip -> production\ogrid\ogrid.xml present |
| nm | member_size | pass | ogrid.xml: member 53657230 bytes vs extracted 53657230 |
| nm | zip_extracted | pass | pool.zip -> production\pool\pool.xml present |
| nm | member_size | pass | pool.xml: member 7298164 bytes vs extracted 7298164 |
| nm | zip_extracted | pass | wchistory.zip -> production\wchistory\wchistory.xml present |
| nm | member_size | pass | wchistory.xml: member 1001930606 bytes vs extracted 1001930606 |
| nm | zip_extracted | **FAIL** | wcproduction.zip -> production\wcproduction\wcproduction.xml MISSING |
| nm | pages_contiguous | pass | 1 pages, numbering contiguous |
| nm | manifest_wells_features | **FAIL** | 2026-02-11: manifest claims 139823 well features; 10000 counted across 1 page files |
| nm | manifest_claim | **FAIL** | 2026-02-11: manifest production_files=4; 4 zips present, 3 extracted |
| nm | manifest_absolute_path | **FAIL** | 2026-02-11: manifest stores an absolute machine path in wells_dir: C:\Users\user\Downloads\claude_playground\data-warehousers\data\bronze\nm\2026-02-11\wells |
| nm | manifest_absolute_path | **FAIL** | 2026-02-11: manifest stores an absolute machine path in production_dir: C:\Users\user\Downloads\claude_playground\data-warehousers\data\bronze\nm\2026-02-11\production |
| ok | layout | pass | pull 2026-02-13, manifest ok |
| ok | no_extras | pass | 2026-02-13: files outside the layout: [] |
| ok | completeness | pass | 2026-02-13: required artifacts missing: [] |
| ok | pages_contiguous | pass | 228 pages, numbering contiguous |
| ok | manifest_wells_features | pass | 2026-02-13: manifest claims 454917 well features; 454917 counted across 228 page files |
| ok | manifest_claim | **FAIL** | 2026-02-13: manifest csv_path=None while data/rbdms_well_data.csv exists |
| ok | manifest_claim | **FAIL** | 2026-02-13: manifest completions_path=None while data/completions_wells_formations.xlsx exists |
| ok | manifest_claim | **FAIL** | 2026-02-13: manifest itd_path=None while data/itd_wells_formations.xlsx exists |
| ok | manifest_absolute_path | **FAIL** | 2026-02-13: manifest stores an absolute machine path in wells_dir: C:\Users\user\Downloads\claude_playground\data-warehousers\data\bronze\ok\2026-02-13\wells |
| ok | manifest_absolute_path | **FAIL** | 2026-02-13: manifest stores an absolute machine path in data_dir: C:\Users\user\Downloads\claude_playground\data-warehousers\data\bronze\ok\2026-02-13\data |
