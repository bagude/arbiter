#!/usr/bin/env python
"""Generate the reference src/exploration.json + exploration.md for dw-explore-real.

Queries run against the mounted real-data snapshot; observation text is built from
the rows so it always cites a number from the result. Re-run at verify time
(tools/verify-task.mjs does this): python make.py <workspace> [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "dw-explore" / "oracle"))
from explore_check import norm, run_query  # noqa: E402

MOUNTS = json.loads((HERE.parents[1] / "mounts.json").read_text(encoding="utf-8"))["mounts"]
DB = (HERE.parents[3] / MOUNTS[0]["target"] / "warehouse.duckdb").resolve()


def fmt(v):
    v = norm(v)
    if isinstance(v, bool) or v is None:
        return str(v)
    if isinstance(v, float):
        return f"{v:.6g}"
    return str(v)


OBS = [
    {"id": "O1", "title": "Three states, three grains: TX lease-months dominate the warehouse",
     "query": "select state, count(*) as rows_, count(distinct entity_key) as entities, min(production_date) as first_month, max(production_date) as last_month from production_monthly group by 1 order by 1",
     "text": lambda rows: "Row counts by state: " + "; ".join(f"{r[0]} {fmt(r[1])} rows over {fmt(r[2])} entities ({fmt(r[3])} to {fmt(r[4])})" for r in rows) + ". TX is lease-grain (many wells per lease), NM and OK are well-grain, so row counts are not comparable across states.",
     "why": "Any cross-state statistic must be per entity-month of the right grain; a naive row count over-weights TX by an order of magnitude."},
    {"id": "O2", "title": "The five largest TX operators by lifetime oil",
     "query": "select operator, round(sum(total_oil_bbl)) as oil_bbl, count(distinct entity_key) as leases from production_monthly where state = 'TX' and operator is not null group by 1 order by 2 desc nulls last, 1 limit 5",
     "text": lambda rows: "Top TX operators by summed total_oil_bbl: " + "; ".join(f"{r[0]} {fmt(r[1])} bbl across {fmt(r[2])} leases" for r in rows) + ".",
     "why": "Concentration at the operator level tells an analyst whose filings drive the TX totals and where a reporting change would show first."},
    {"id": "O3", "title": "NM yearly oil for the last five complete years",
     "query": "select production_year, round(sum(total_oil_bbl)) as oil_bbl, count(distinct entity_key) as wells from production_monthly where state = 'NM' and production_year between 2020 and 2024 group by 1 order by 1",
     "text": lambda rows: "NM total oil by year: " + "; ".join(f"{fmt(r[0])}: {fmt(r[1])} bbl from {fmt(r[2])} wells" for r in rows) + ".",
     "why": "The trend and the active-well count together say whether NM output is moving on volume per well or on the number of reporting wells."},
    {"id": "O4", "title": "OK 'production' rows come from two non-production sources",
     "query": "select source_file, count(*) as rows_, min(production_date) as first_month, max(production_date) as last_month from production_monthly where state = 'OK' group by 1 order by 2 desc",
     "text": lambda rows: "OK rows by source_file: " + "; ".join(f"{r[0]} {fmt(r[1])} rows ({fmt(r[2])} to {fmt(r[3])})" for r in rows) + ". Neither is a monthly production report: one is the well master stamped with the pull month, the other is completion IP tests.",
     "why": "OK volumes and months in this warehouse are not production; the seed-pipeline contract already excludes them, and this warehouse should too."},
    {"id": "O5", "title": "NULL versus zero oil by state",
     "query": "select state, sum(case when total_oil_bbl is null then 1 else 0 end) as null_oil, sum(case when total_oil_bbl = 0 then 1 else 0 end) as zero_oil, count(*) as rows_ from production_monthly group by 1 order by 1",
     "text": lambda rows: "Per state (null oil / zero oil / rows): " + "; ".join(f"{r[0]} {fmt(r[1])} / {fmt(r[2])} / {fmt(r[3])}" for r in rows) + ".",
     "why": "The contract says NULL means not reported and 0 means reported zero; how each state's parser used them decides whether averages over 'producing' months are meaningful."},
]


def render_md(doc):
    lines = [f"# Exploration — {doc['scope']}", ""]
    for o in doc["observations"]:
        lines += [f"## {o['id']} — {o['title']} (confidence {o['confidence']})", "", o["observation"], "", f"*Why it matters:* {o['why_it_matters']}", "", "```sql", o["query"], "```", ""]
        for r in o["result"][:10]:
            lines.append("| " + " | ".join(str(v) for v in r) + " |")
        lines.append("")
    lines += ["## Next questions", ""] + [f"- {q}" for q in doc["next_questions"]] + [""]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--out", type=Path, default=HERE)
    a = ap.parse_args()
    obs = []
    for o in OBS:
        rows, err = run_query(DB, o["query"])
        if err:
            raise SystemExit(f"{o['id']}: {err}")
        rows = [[norm(v) for v in r] for r in rows]
        obs.append({"id": o["id"], "title": o["title"], "observation": o["text"](rows), "why_it_matters": o["why"], "query": o["query"], "result": rows, "confidence": 0.85, "claim": "observed"})
    doc = {
        "scope": "Shape and provenance of the full 93-million-row warehouse: grain per state, concentration, trend, source mix and NULL/zero semantics — the baseline before deeper exploration.",
        "observations": obs,
        "next_questions": [
            "How many TX leases are single-well (entity_type = 'well') versus multi-well, and how does that split affect per-well statistics?",
            "Which NM wells dominate cumulative oil, and are the top ones CO2-EOR condensate units as in the seed?",
            "Does the OK well-master row set carry any volume at all, or are all OK volumes from completion IP tests?",
        ],
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "exploration.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    (a.out / "exploration.md").write_text(render_md(doc), encoding="utf-8")
    print(f"wrote {a.out / 'exploration.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
