#!/usr/bin/env python
"""Generate the reference src/health.json + src/health.md for the dw-recon task.

The KPI block comes from the oracle's kpi.py (so the reference is honest by
construction); the findings are hand-written and each cites a real file/quote or a
KPI path. Re-run when the workspace data changes:

    python make.py <workspace> [--out <dir>]     (default out: this directory)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kpi import compute  # noqa: E402

FINDINGS = [
    {"id": "F1", "severity": "error", "layer": "bronze", "state": "TX", "title": "TX pull carries no monthly production table",
     "description": "The bronze manifest lists OG_COUNTY_CYCLE, OG_OPERATOR_DW, OG_WELL_COMPLETION and one wells page but no OG_LEASE_CYCLE.dsv, which the silver contract names as the only TX production source. Silver TX production is therefore empty and gold has no TX rows; the county rollup cannot be reconciled until the table is re-fetched.",
     "evidence": [{"file": "data/bronze/tx/2026-02-11/manifest.json", "quote": "\"path\": \"OG_WELL_COMPLETION.dsv\""},
                  {"file": "contract/contract-silver.md", "quote": "When `OG_LEASE_CYCLE.dsv` is absent the TX production file is written empty"},
                  {"kpi": "TX.silver.production.rows"}]},
    {"id": "F2", "severity": "warn", "layer": "silver", "state": "TX", "title": "One in five TX ArcGIS well records has a truncated API and was dropped",
     "description": "The wells page holds APIs shortened to three characters; the silver contract drops and counts them as wells.truncated_api rather than guessing. Coordinates for those wells are lost until the source is re-pulled with full APIs.",
     "evidence": [{"kpi": "TX.silver.dropped"}, {"file": "data/silver/manifest.json", "quote": "\"wells.truncated_api\""},
                  {"file": "contract/contract-silver.md", "quote": "wells.truncated_api"}]},
    {"id": "F3", "severity": "info", "layer": "silver", "state": "NM", "title": "NM production is complete through the pull month and multi-pool months are summed",
     "description": "Silver NM production covers 40 wells with 9334 well-months; the latest month is within the pull's freshness window. Per the contract, well-months spanning several pools are one row with volumes summed per kind and the dominant pool as field_name, and re-filed records are resolved by the latest mod_dte (5 amended duplicates dropped).",
     "evidence": [{"kpi": "NM.silver.production.last_month"}, {"kpi": "NM.silver.production.freshness_months"},
                  {"file": "contract/contract-silver.md", "quote": "volumes are summed across pools per kind"},
                  {"file": "data/silver/manifest.json", "quote": "\"production.amended_duplicates\""}]},
    {"id": "F4", "severity": "info", "layer": "cross", "state": "OK", "title": "OK contributes wells and completions, no monthly production",
     "description": "The OK pull has the ArcGIS wells page, the RBDMS CSV and the completions/ITD sheets but no production source; by contract OK feeds the wells and completions tables only, and gold carries them through with row parity.",
     "evidence": [{"file": "contract/contract-silver.md", "quote": "`completions` for OK"}, {"kpi": "OK.gold.parity"}, {"kpi": "OK.silver.completions.rows"}]},
    {"id": "F5", "severity": "info", "layer": "gold", "state": None, "title": "Gold row parity holds for every state",
     "description": "For each state the gold production_monthly (or completions) and wells row counts equal the silver counts, so the gold build neither dropped nor duplicated rows.",
     "evidence": [{"kpi": "TX.gold.parity"}, {"kpi": "NM.gold.parity"}, {"kpi": "OK.gold.parity"}]},
]


def render_md(doc: dict) -> str:
    lines = [f"# Pipeline health — pull {doc['report_of']} (generated {doc['generated_at']})", ""]
    for s, k in doc["kpi"].items():
        prod = k["silver"].get("production")
        status = "ERROR" if any(f["severity"] == "error" and f["state"] == s for f in doc["findings"]) else "ok"
        lines.append(f"- **{s}** [{status}]: landed {k['bronze']['landed_at']} ({k['bronze']['files']} files, {k['bronze']['records']} records); silver wells {k['silver']['wells']['rows']}"
                     + (f", production {prod['rows']} rows {prod['first_month']}→{prod['last_month']} (freshness {prod['freshness_months']} months, {prod['gap_months']} gap-months)" if prod else f", completions {k['silver']['completions']['rows']}")
                     + f"; gold parity {'ok' if k['gold']['parity'] else 'BROKEN'}")
    lines += ["", "## KPI", "", "| state | layer | metric | value |", "|---|---|---|---|"]
    for s, k in doc["kpi"].items():
        for layer, block in k.items():
            for key, v in block.items():
                if isinstance(v, dict):
                    for kk, vv in v.items():
                        lines.append(f"| {s} | {layer} | {key}.{kk} | {vv} |")
                else:
                    lines.append(f"| {s} | {layer} | {key} | {v} |")
    lines += ["", "## Findings", ""]
    for f in doc["findings"]:
        lines.append(f"### {f['id']} [{f['severity']}] {f['layer']}/{f['state'] or 'all'} — {f['title']}")
        lines.append("")
        lines.append(f["description"])
        lines.append("")
        for e in f["evidence"]:
            lines.append(f"- evidence: `{e['file']}` — `{e['quote']}`" if "file" in e else f"- kpi: `{e['kpi']}`")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    a = ap.parse_args()
    kpi = compute(a.workspace)
    doc = {"report_of": kpi["TX"]["bronze"]["pull_date"], "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "kpi": kpi, "findings": FINDINGS}
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "health.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    (a.out / "health.md").write_text(render_md(doc), encoding="utf-8")
    print(f"wrote {a.out / 'health.json'} and health.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
