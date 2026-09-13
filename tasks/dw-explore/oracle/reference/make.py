#!/usr/bin/env python
"""Generate the reference src/exploration.json + exploration.md for dw-explore.

Observations are hand-written; their results are filled by executing the queries,
so the reference reproduces by construction. Re-run when the warehouse changes:

    python make.py <workspace> [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from explore_check import norm, run_query  # noqa: E402

OBS = [
    {"id": "O1", "title": "Three Raton basin wells out-produce nineteen Permian wells combined",
     "observation": "Grouped by basin, RATON's 3 wells carry 8050015 bbl of total oil against 2911353 for PERMIAN's 19 and 1206404 for SAN JUAN's 18 — a per-well average two orders of magnitude above the others.",
     "why_it_matters": "Either these Union county wells are genuinely exceptional or their volumes are mis-keyed (the raw records carry a 'C' condensate kind with six-figure monthly amounts); an analyst should check the source before using basin totals.",
     "query": "select basin, count(distinct entity_key) as wells, round(sum(total_oil_bbl)) as oil, round(sum(total_gas_mcf)) as gas from production_monthly group by 1 order by 1",
     "confidence": 0.7, "claim": "observed"},
    {"id": "O2", "title": "NM oil output in the seed has collapsed since 2021",
     "observation": "Yearly NM total oil fell from 2435 bbl in 2022 to 1048 in 2023, 913 in 2024 and 832 in 2025 — the 40 sampled wells are late-life.",
     "why_it_matters": "Decline-curve work on this sample sees tails, not ramps; anyone fitting initial rates needs younger wells or the full population.",
     "query": "select production_year, round(sum(total_oil_bbl)) as oil from production_monthly where state = 'NM' group by 1 order by 1 desc limit 5",
     "confidence": 0.85, "claim": "observed"},
    {"id": "O3", "title": "The wells table is one-third 'OTHER' well types",
     "observation": "796 of the wells rows are typed OTHER, more than OIL (739) or GAS (629), with 71 untyped and 15 INJ.",
     "why_it_matters": "OTHER is where the OK codes (DRY, NT, TM, 2DNC…) and NM CO2 wells land under the contract's exhaustive-for-the-seed tables; a consumer filtering to OIL/GAS silently drops a third of the master.",
     "query": "select well_type, count(*) as n from wells group by 1 order by 2 desc",
     "confidence": 0.9, "claim": "observed"},
    {"id": "O4", "title": "Reported month gaps are the norm in NM histories",
     "observation": "The five gappiest NM wells are each missing hundreds of months between first and last report: 30-031-20391 lacks 362 months, 30-025-00470 323, 30-025-00763 280.",
     "why_it_matters": "cumulative_* and months_on_production count reported rows only; time-based analysis must use calendar_months_on_production or expect discontinuities.",
     "query": "select entity_key, max(calendar_months_on_production) - max(reported_month_index) as gap_months from production_monthly where state = 'NM' group by 1 order by 2 desc limit 5",
     "confidence": 0.8, "claim": "observed"},
    {"id": "O5", "title": "Most OK completion rows report no initial-potential oil",
     "observation": "Of the 964 OK completion rows, 840 report 0 bbl/d oil on the IP test; only 124 have a non-zero oil rate.",
     "why_it_matters": "IP tests are the only production-like signal OK contributes; with 87% zeros, any OK 'rate' statistic is dominated by gas or by nulls, not oil.",
     "query": "select case when oil_bbl_per_day > 0 then 'nonzero' else 'zero_or_null' end as oil_ip, count(*) as n from completions group by 1 order by 1",
     "confidence": 0.85, "claim": "observed"},
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
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    a = ap.parse_args()
    db = a.workspace / "data" / "gold" / "warehouse.duckdb"
    obs = []
    for o in OBS:
        rows, err = run_query(db, o["query"])
        if err:
            raise SystemExit(f"{o['id']}: {err}")
        obs.append({**o, "result": [[norm(v) for v in r] for r in rows]})
    doc = {
        "scope": "Concentration, trend, typing and gap structure of the seed warehouse (TX county 421, NM 40 wells, OK Alfalfa) as a maintainer would want to know before trusting aggregates.",
        "observations": obs,
        "next_questions": [
            "Are the Raton basin volumes real or a units/kind error in wcproduction (kind 'C' with six-figure amounts)?",
            "How does initial_gor distribute across NM wells, and do the OTHER-typed wells carry gas or oil?",
            "Which NM wells have the longest continuous reporting runs, for decline fitting?",
        ],
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "exploration.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    (a.out / "exploration.md").write_text(render_md(doc), encoding="utf-8")
    print(f"wrote {a.out / 'exploration.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
