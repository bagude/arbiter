#!/usr/bin/env python
"""Independent KPI computation for docs/dw/contract-recon.md §3.

    python kpi.py <workspace> [--state TX]      -> JSON {"TX": {...}, ...}

Reads the bronze manifests, the silver manifest and parquet, and the gold DuckDB;
never the candidate's report.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

TABLES = {"TX": ["wells", "production"], "NM": ["wells", "production"], "OK": ["wells", "completions"]}
GOLD = {"TX": ["production_monthly", "decline_curve_inputs", "wells"], "NM": ["production_monthly", "decline_curve_inputs", "wells"], "OK": ["wells", "completions"]}


def months(d) -> int:
    return d.year * 12 + d.month


def bronze_kpi(ws: Path, state: str) -> dict:
    root = ws / "data" / "bronze" / state.lower()
    pulls = sorted(d for d in root.iterdir() if d.is_dir())
    pull = pulls[-1]
    man = json.loads((pull / "manifest.json").read_text(encoding="utf-8"))
    files = man.get("files", [])
    return {
        "pull_date": pull.name,
        "landed_at": man.get("pulled_at"),
        "files": len(files),
        "bytes": sum(int(f.get("bytes", 0)) for f in files),
        "records": sum(int(f["records"]) for f in files if isinstance(f.get("records"), int)),
    }


def silver_kpi(ws: Path, state: str, pull_date: str) -> dict:
    man = json.loads((ws / "data" / "silver" / "manifest.json").read_text(encoding="utf-8"))
    out = {}
    for t in TABLES[state]:
        out[t] = {"rows": int(man["rows"][t][state])}
    out["dropped"] = man.get("dropped", {}).get(state, {}) or {}
    if "production" in TABLES[state]:
        p = ws / "data" / "silver" / "production" / f"state={state}" / f"{state.lower()}_production.parquet"
        rows = pq.ParquetFile(p).read().to_pylist()
        prod = out["production"]
        if rows:
            dates = [r["production_date"] for r in rows]
            first, last = min(dates), max(dates)
            py, pm = int(pull_date[:4]), int(pull_date[5:7])
            prod["first_month"] = first.isoformat()
            prod["last_month"] = last.isoformat()
            prod["freshness_months"] = (py * 12 + pm) - months(last)
            ent = defaultdict(list)
            for r in rows:
                ent[(r["entity_type"], r["api_number"], r["lease_number"], r["district"])].append(r["production_date"])
            prod["entities"] = len(ent)
            prod["gap_months"] = sum((months(max(ds)) - months(min(ds)) + 1) - len(ds) for ds in ent.values())
            apis = {r["api_number"] for r in rows if r["api_number"]}
        else:
            prod.update({"first_month": None, "last_month": None, "freshness_months": None, "entities": 0, "gap_months": 0})
            apis = set()
        w = ws / "data" / "silver" / "wells" / f"state={state}" / f"{state.lower()}_wells.parquet"
        wells = {r["api_number"] for r in pq.ParquetFile(w).read().to_pylist()}
        out["wells"]["with_production"] = len(wells & apis)
    else:
        out["wells"]["with_production"] = 0
    return out


def gold_kpi(ws: Path, state: str, silver: dict) -> dict:
    con = duckdb.connect(str(ws / "data" / "gold" / "warehouse.duckdb"), read_only=True)
    try:
        out = {t: {"rows": con.execute(f"select count(*) from {t} where state = ?", [state]).fetchone()[0]} for t in GOLD[state]}
    finally:
        con.close()
    parity = out["wells"]["rows"] == silver["wells"]["rows"]
    if "production" in silver:
        parity = parity and out["production_monthly"]["rows"] == silver["production"]["rows"]
    if "completions" in silver:
        parity = parity and out["completions"]["rows"] == silver["completions"]["rows"]
    out["parity"] = bool(parity)
    return out


def compute(ws: Path, states=("TX", "NM", "OK")) -> dict:
    result = {}
    for s in states:
        b = bronze_kpi(ws, s)
        sv = silver_kpi(ws, s, b["pull_date"])
        g = gold_kpi(ws, s, sv)
        result[s] = {"bronze": b, "silver": sv, "gold": g}
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--state", nargs="*")
    a = ap.parse_args()
    print(json.dumps(compute(a.workspace, a.state or ("TX", "NM", "OK")), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
