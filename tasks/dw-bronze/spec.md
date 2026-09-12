Build the **bronze layer** of an oil & gas data warehouse: an ingester that materialises the raw agency downloads for Texas (RRC), New Mexico (OCD) and Oklahoma (OCC) exactly as received, with a truthful inventory. There is no network here: `remote/` in the workspace stands in for the three agencies and holds real files in their real formats. Read the workspace README first; it names every file.

## Deliverable

`src/bronze.py`, runnable as

```
uv run --no-project --python 3.13 --with-requirements requirements.txt \
  python src/bronze.py --remote remote --out data/bronze --pull-date 2026-02-11 [--states tx nm ok]
```

It reads only `remote/`, writes only under `--out`, exits 0, uses the standard library plus `openpyxl` only (no network or subprocess modules), and is at most 250 code lines. Only `src/` is graded.

## Contract (this is what the hidden oracle checks)

### Layout — `data/bronze/<state>/<pull_date>/`

| State | Bronze path | Origin in `remote/<state>/` | Rule |
|---|---|---|---|
| tx | `OG_<TABLE>.dsv` | each member of `mft/PDQ_DSV.zip` | bytes identical to the zip member; the zip is not kept |
| tx, nm, ok | `wells/wells_batch_NNNN.json` | `arcgis/page_NNNN.json` | bytes as served, same number |
| nm | `production/<name>.zip` | `ftp/**/<name>.zip` | the zip as served |
| nm | `production/<name>/<name>.xml` | member of that zip | extracted, bytes identical |
| ok | `data/rbdms_well_data.csv` | `web/rbdms-wells.csv` | bytes as served |
| ok | `data/completions_wells_formations.xlsx` | `web/completions-wells-formations-base.xlsx` | bytes as served |
| ok | `data/itd_wells_formations.xlsx` | `web/ITD-wells-formations-base.xlsx` | bytes as served |

Nothing else may exist under a pull directory except `manifest.json`. Exactly one pull directory per state.

### Manifest — `manifest.json`, UTF-8, keys in this order

```json
{
  "state": "tx",
  "pull_date": "2026-02-11",
  "pulled_at": "2026-09-12T14:03:22Z",
  "sources": [ { "name": "mft_pdq", "url": "https://…" } ],
  "files": [
    { "path": "OG_WELL_COMPLETION.dsv", "bytes": 110793, "sha256": "…", "records": 1535, "source": "mft_pdq", "from": "PDQ_DSV.zip" },
    { "path": "wells/wells_batch_0001.json", "bytes": 42539, "sha256": "…", "records": 288, "source": "arcgis" }
  ]
}
```

- `files` lists every file under the pull directory except `manifest.json`, **sorted by `path`** (forward slashes), with exact `bytes`, lower-case hex `sha256`, a `source` name from `sources`, and `from` = the zip's file name for extracted members.
- `records` is an independent count: `.dsv`/`.csv` → data rows after the header (CSV rows may span lines: use the `csv` module); ArcGIS `.json` → `len(features)`; `.xlsx` → data rows of the first sheet; SQL-Server `.xml` (UTF-16 with a BOM) → number of top-level record elements, i.e. occurrences of `<name xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">`; `.zip` → no `records`, instead `"members": [ { "name", "bytes" } ]` in zip order.
- `pulled_at` is UTC `YYYY-MM-DDTHH:MM:SSZ` and is the only field allowed to differ between two runs over the same remote.
- `sources` is non-empty; every entry has `name` and `url`.

### The oracle's checks

1. layout and a parseable manifest whose `state`/`pull_date` match the directory;
2. completeness — every remote artifact has its counterpart, every zip member is extracted;
3. integrity — every bronze file is sha256-identical to the remote file or zip member it came from;
4. no extras;
5. manifest truth — `files` equals the files present, and every `bytes`/`sha256`/`records`/`members`/`from` is right;
6. idempotence — a second run yields the same manifest apart from `pulled_at`;
7. interface — ≤ 250 code lines; no `requests`, `httpx`, `urllib`, `socket`, `ftplib`, `subprocess`.

## Verification channel

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["tx"] }` (one state per entry) and returns, for each, the oracle's pass/total for that state and the exact failing checks. Probe every state before claiming `kind="done"`.
