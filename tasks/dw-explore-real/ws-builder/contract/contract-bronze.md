# Bronze contract — "exactly as received, nothing lost"

Bronze is the agency's bytes, on disk, with a truthful inventory. It transforms nothing. This contract is what the bronze oracle checks; it is also what a bronze ingester must produce.

## 1. Layout

```
data/bronze/<state>/<pull_date>/          state ∈ {tx, nm, ok}; pull_date = YYYY-MM-DD
  manifest.json
  <files in the agency layout below>
```

| State | Bronze path | Origin (remote) | Notes |
|---|---|---|---|
| tx | `OG_<TABLE>.dsv` | member of `mft/PDQ_DSV.zip` | one file per zip member, bytes identical to the member; the zip itself is not kept |
| tx | `wells/wells_batch_NNNN.json` | `arcgis/page_NNNN.json` | one file per page, bytes as served |
| nm | `wells/wells_batch_NNNN.json` | `arcgis/page_NNNN.json` | as above |
| nm | `production/<name>.zip` | `ftp/<dir>/<name>.zip` | the zip as served (`wcproduction`, `wchistory`, `ogrid`, `pool`) |
| nm | `production/<name>/<name>.xml` | member of that zip | extracted, bytes identical to the member |
| ok | `wells/wells_batch_NNNN.json` | `arcgis/page_NNNN.json` | as above |
| ok | `data/rbdms_well_data.csv` | `web/rbdms-wells.csv` | bytes as served |
| ok | `data/completions_wells_formations.xlsx` | `web/completions-wells-formations-base.xlsx` | bytes as served |
| ok | `data/itd_wells_formations.xlsx` | `web/ITD-wells-formations-base.xlsx` | bytes as served |

Nothing else may be present under a pull directory. No `.part`, no `.tmp`, no re-serialised JSON, no re-encoded text.

## 2. Manifest

`manifest.json` (UTF-8, 2-space indent, keys in this order):

```json
{
  "state": "tx",
  "pull_date": "2026-02-11",
  "pulled_at": "2026-09-12T14:03:22Z",
  "sources": [ { "name": "mft_pdq", "url": "…" }, { "name": "arcgis", "url": "…" } ],
  "files": [
    { "path": "OG_WELL_COMPLETION.dsv", "bytes": 201811, "sha256": "…", "records": 1535, "source": "mft_pdq", "from": "PDQ_DSV.zip" },
    { "path": "wells/wells_batch_0001.json", "bytes": 88120, "sha256": "…", "records": 431, "source": "arcgis" }
  ]
}
```

- `files` lists **every** file under the pull directory except `manifest.json`, sorted by `path` (forward slashes), each with its exact `bytes`, lower-case hex `sha256`, the `source` name, and `from` (the zip it was extracted from) when applicable.
- `records` is an independent count of the file's data records:
  - `.dsv` / `.csv`: data rows (rows after the header; CSV rows may span lines).
  - ArcGIS `.json`: `len(features)`.
  - `.xlsx`: data rows of the first sheet.
  - SQL-Server `.xml`: number of top-level record elements (children of `<root>` other than the XSD schema).
  - `.zip`: no `records`; instead `members: [ { "name", "bytes" } ]`.
- `pulled_at` is the only field allowed to differ between two runs over the same remote.

## 3. Oracle checks

For a `(remote, bronze)` pair, per state:

1. **layout** — the pull directory and a parseable manifest exist; `state`/`pull_date` match the path; `sources` non-empty.
2. **completeness** — every remote artifact has its bronze counterpart (table above); every zip member is extracted.
3. **integrity** — sha256 of each bronze file equals sha256 of the remote file (or zip member) it came from.
4. **no_extras** — nothing under the pull directory beyond the counterparts and `manifest.json`.
5. **manifest_truth** — `files` equals the set of files present; `bytes`, `sha256`, `records`/`members`, `from` are correct; sorted by path.
6. **idempotence** — a second run over the same remote produces the same manifest apart from `pulled_at`.

Without a remote (audit mode) the checker verifies 1, 4 (against the layout table), 5, and reports every discrepancy as a finding.

## 4. Ingester interface (task `dw-bronze`)

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/bronze.py --remote remote --out data/bronze --pull-date 2026-02-11 [--states tx nm ok]
```

Reads only `remote/`; writes only under `--out`; exits 0 on success; ≤ 250 lines; standard library plus `openpyxl` (for the `.xlsx` record count) only. No network code.
