# dw-bronze workspace

`remote/` stands in for the three agencies. Every file is a real slice of a real download (Feb 2026), in the agency's own format:

- `remote/tx/mft/PDQ_DSV.zip` — the RRC "PDQ" archive: `}`-delimited, latin-1 `.dsv` tables (`OG_WELL_COMPLETION`, `OG_OPERATOR_DW`, `OG_COUNTY_CYCLE`). Header line first.
- `remote/tx/arcgis/page_0001.json` — one page of the RRC ArcGIS well-location query (`features[].attributes.{API, GIS_LAT83, GIS_LONG83}`).
- `remote/nm/ftp/volumes/wcproduction/wcproduction.zip`, `remote/nm/ftp/core/{wchistory,ogrid,pool}/<name>.zip` — OCD FTP zips, each holding one `<name>.xml`: UTF-16 LE with a BOM, SQL-Server `FOR XML` shape: an `<xsd:schema>` then one `<name xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">…</name>` element per record.
- `remote/nm/arcgis/page_0001.json` — one page of the EMNRD ArcGIS wells query.
- `remote/ok/web/rbdms-wells.csv`, `completions-wells-formations-base.xlsx`, `ITD-wells-formations-base.xlsx` — OCC bulk files; `remote/ok/arcgis/page_0001.json` — one page of the OCC RBDMS_WELLS query.

Your deliverable is `src/bronze.py` (see the specification in your prompt). Run it with:

```
uv run --no-project --python 3.13 --with-requirements requirements.txt python src/bronze.py --remote remote --out data/bronze --pull-date 2026-02-11
```

`uv` resolves the pinned packages once and caches them; the command works offline afterwards. Write outputs under `data/` in the workspace. Only `src/` is graded; scratch notes go under `src/notes/`.
