"""Reference deliverable for dw-paper-apply, generated from the real warehouse: five
NM wells with at least 48 producing months, each with the first 48 months of oil
rate and an exponential (Arps b = 0, the modified hyperbolic's terminal branch)
least-squares fit on log rate. Every compute is deterministic (numpy polyfit), so
the oracle's re-run prints the same numbers.

    python make.py <workspace> [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import duckdb

COMPUTE = (
    "import json, sys, numpy as np\n"
    "rows = json.load(sys.stdin)\n"
    "t = np.array([r[0] for r in rows], dtype=float)\n"
    "q = np.array([r[1] for r in rows], dtype=float)\n"
    "keep = q > 0\n"
    "slope, intercept = np.polyfit(t[keep], np.log(q[keep]), 1)\n"
    "print(json.dumps({'Di_per_month': round(float(-slope), 6), 'qi_fit': round(float(np.exp(intercept)), 2), 'n': int(keep.sum())}))\n"
)


def fit(rows):
    import numpy as np

    t = np.array([r[0] for r in rows], dtype=float)
    q = np.array([r[1] for r in rows], dtype=float)
    keep = q > 0
    slope, intercept = np.polyfit(t[keep], np.log(q[keep]), 1)
    return {"Di_per_month": round(float(-slope), 6), "qi_fit": round(float(np.exp(intercept)), 2), "n": int(keep.sum())}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    a = ap.parse_args()
    here = Path(__file__).resolve().parent
    mounts = json.loads((here.parent.parent / "mounts.json").read_text(encoding="utf-8"))["mounts"]
    db = (here.parent.parent.parent.parent / mounts[0]["target"] / "warehouse.duckdb").resolve()
    con = duckdb.connect(str(db), read_only=True)
    wells = con.execute(
        "select entity_key from decline_curve_inputs where state = 'NM' and months_on_production <= 48 and total_oil_bbl > 0 "
        "group by entity_key having count(*) = 48 and min(total_oil_bbl) > 50 order by entity_key limit 5"
    ).fetchall()
    obs = []
    for i, (key,) in enumerate(wells, 1):
        sql = f"select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '{key}' and months_on_production <= 48 order by months_on_production limit 48"
        rows = [[int(r[0]), float(r[1])] for r in con.execute(sql).fetchall()]
        expect = fit(rows)
        obs.append({
            "id": f"O{i}",
            "title": f"Exponential fit of NM well {key}: Di {expect['Di_per_month']} per month over its first 48 months",
            "observation": f"An exponential least-squares fit on log oil rate over the first {expect['n']} months of well {key} gives Di_per_month = {expect['Di_per_month']} and qi_fit = {expect['qi_fit']} bbl/month.",
            "why_it_matters": "The exponential branch is the modified hyperbolic model's terminal decline; its monthly decline sets the reserves floor the paper says constrained extrapolations must respect.",
            "claim": "observed",
            "model": "MH",
            "paper_refs": ["p59", "C4"],
            "query": sql,
            "result": rows,
            "compute": {"code": COMPUTE, "expect": expect},
            "confidence": 0.85,
        })
    doc = {
        "scope": "Exponential (terminal-decline) fits of the first 48 months of five NM wells, as the simplest of SPE 162910's models applied to monthly rates.",
        "observations": obs,
        "next_questions": [
            "Fit the power-law exponential model to the same five wells and compare residuals with the exponential fit.",
            "Do TX well-level and lease-level rows for one lease give different fitted declines?",
        ],
    }
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "exploration.json").write_text(json.dumps(doc, indent=2), encoding="utf-8")
    lines = ["# SPE 162910 applied — reference round", ""]
    for o in obs:
        lines += [f"## {o['id']} — {o['title']}", "", o["observation"], "", "```sql", o["query"], "```", ""]
    lines += ["## Next questions", ""] + [f"- {q}" for q in doc["next_questions"]] + [""]
    (a.out / "exploration.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {len(obs)} observations to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
