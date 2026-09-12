#!/usr/bin/env python
"""Gold oracle: compare a candidate DuckDB with the reference build, run the
contract's data-quality assertions on the candidate, and reconcile TX against the
RRC county rollup (docs/dw/contract-gold.md §5, §6, §8).

    python gold_check.py --expected <ref.duckdb> --actual <cand.duckdb> --silver <silver dir> [--county-cycle <dsv>] [--tables ...]

Prints one JSON document: {"checks": [{"name", "table", "ok", "detail"}], "pass", "total"}.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from datetime import date, datetime
from pathlib import Path

import duckdb

KEYS = {
    "production_monthly": ["entity_key", "state", "production_date"],
    "decline_curve_inputs": ["api_number", "state", "production_date"],
    "wells": ["state", "api_number"],
    "completions": ["state", "api_number", "completion_no", "row_no"],
}
TOL = 1e-6


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, table, ok, detail=""):
        self.items.append({"name": name, "table": table, "ok": bool(ok), "detail": str(detail)[:1500]})

    def result(self):
        p = sum(1 for c in self.items if c["ok"])
        return {"checks": self.items, "pass": p, "total": len(self.items)}


def norm(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def same(a, b):
    a, b = norm(a), norm(b)
    if isinstance(a, float) and isinstance(b, (int, float)) or isinstance(b, float) and isinstance(a, (int, float)):
        return abs(float(a) - float(b)) <= TOL
    return a == b


def describe(con, table):
    try:
        return [(r[0], r[1]) for r in con.execute(f"describe {table}").fetchall()]
    except duckdb.Error:
        return None


def rows(con, table, cols, keys):
    order = ", ".join(keys)
    return con.execute(f"select {', '.join(cols)} from {table} order by {order}").fetchall()


def compare_table(ck, table, exp, act):
    ed = describe(exp, table)
    ad = describe(act, table)
    if ed is None:
        ck.add("reference_present", table, False, "reference has no such table (oracle bug)")
        return
    if ad is None:
        ck.add("table_present", table, False, f"table {table} missing")
        return
    ck.add("table_present", table, True, "")
    ck.add("columns", table, ad == ed, "" if ad == ed else f"columns/types differ: got {ad} expected {ed}")
    cols = [c for c, _ in ed if c != "ingested_at"]
    if ad != ed:
        cols = [c for c in cols if c in {c2 for c2, _ in ad}]
    keys = KEYS[table]
    er = rows(exp, table, cols, keys)
    ar = rows(act, table, cols, keys)
    ck.add("row_count", table, len(ar) == len(er), f"{len(ar)} rows vs {len(er)} expected")
    ki = [cols.index(k) for k in keys]
    ek = {tuple(norm(r[i]) for i in ki): r for r in er}
    ak = {tuple(norm(r[i]) for i in ki): r for r in ar}
    missing = [k for k in ek if k not in ak]
    extra = [k for k in ak if k not in ek]
    ck.add("keys", table, not missing and not extra and len(ak) == len(ar), f"missing={len(missing)} {missing[:3]}; extra={len(extra)} {extra[:3]}; duplicate keys={len(ar) - len(ak)}")
    diffs = []
    for k, e in ek.items():
        a = ak.get(k)
        if a is None:
            continue
        for i, c in enumerate(cols):
            if not same(e[i], a[i]):
                diffs.append((k, c, norm(e[i]), norm(a[i])))
    by_col = {}
    for _, c, _, _ in diffs:
        by_col[c] = by_col.get(c, 0) + 1
    ck.add("values", table, not diffs, f"{len(ek)} rows compared, {len(diffs)} cell differences" + (f" by column {by_col}; e.g. " + "; ".join(f"{k} {c}: expected {e!r} got {a!r}" for k, c, e, a in diffs[:4]) if diffs else ""))


ASSERTS = {
    "A1_no_null_entity_key": "select count(*) from production_monthly where entity_key is null",
    "A2_entity_key_format": """select count(*) from production_monthly
        where (entity_type = 'well' and entity_key is distinct from api_number)
           or (entity_type = 'lease' and entity_key is distinct from 'TX-LEASE:' || district || '-' || lease_number)""",
    "A3_no_negative_volumes": "select count(*) from production_monthly where oil_bbl < 0 or gas_mcf < 0 or condensate_bbl < 0 or casinghead_gas_mcf < 0 or water_bbl < 0",
    "A4_no_future_dates": "select count(*) from production_monthly where production_date > current_date",
    "A6_reported_month_index": """select count(*) from (select entity_key, state, count(*) n, min(reported_month_index) mn, max(reported_month_index) mx, count(distinct reported_month_index) d
        from production_monthly group by 1, 2) where mn != 1 or mx != n or d != n""",
    "A7_calendar_months_positive": "select count(*) from production_monthly where calendar_months_on_production < 1",
    "A9_dca_months": """select count(*) from (select api_number, state, count(*) n, min(months_on_production) mn, max(months_on_production) mx
        from decline_curve_inputs group by 1, 2) where mn != 1 or mx != n""",
}


def run_asserts(ck, con, silver: Path):
    prod = str(silver / "production" / "state=*" / "*.parquet").replace("\\", "/")
    for name, sql in ASSERTS.items():
        try:
            n = con.execute(sql).fetchone()[0]
            ck.add(name, "*", n == 0, f"{n} violating rows")
        except duckdb.Error as e:
            ck.add(name, "*", False, f"query failed: {e}")
    try:
        s = con.execute(f"""with s as (select *, case when entity_type = 'well' then api_number else 'TX-LEASE:' || district || '-' || lease_number end as entity_key
                              from read_parquet('{prod}', hive_partitioning = false))
            select (select count(*) from s) as silver_rows, (select count(*) from production_monthly) as gold_rows,
                   (select count(*) from production_monthly g left join s on g.entity_key = s.entity_key and g.state = s.state and g.production_date = s.production_date where s.entity_key is null) as orphans""").fetchone()
        ck.add("A5_silver_gold_rows", "*", s[0] == s[1] and s[2] == 0, f"silver {s[0]} rows, gold {s[1]} rows, {s[2]} gold rows without a silver row")
        tot = con.execute(f"""with s as (select state,
                  sum(case when oil_bbl is null and condensate_bbl is null then null else coalesce(oil_bbl,0)+coalesce(condensate_bbl,0) end) so,
                  sum(case when gas_mcf is null and casinghead_gas_mcf is null then null else coalesce(gas_mcf,0)+coalesce(casinghead_gas_mcf,0) end) sg
                  from read_parquet('{prod}', hive_partitioning = false) group by state),
              g as (select state, sum(total_oil_bbl) go, sum(total_gas_mcf) gg from production_monthly group by state)
            select coalesce(s.state, g.state), so, go, sg, gg from s full outer join g on s.state = g.state""").fetchall()
        bad = [r for r in tot if abs((r[1] or 0) - (r[2] or 0)) > 0.01 or abs((r[3] or 0) - (r[4] or 0)) > 0.01]
        ck.add("A8_totals_reconcile", "*", not bad, "; ".join(f"{r[0]}: oil {r[1]} vs {r[2]}, gas {r[3]} vs {r[4]}" for r in tot))
        d = con.execute(f"""select count(*) from decline_curve_inputs d left join read_parquet('{prod}', hive_partitioning = false) s
            on d.api_number = s.api_number and d.state = s.state and d.production_date = s.production_date
            where s.api_number is null or s.entity_type != 'well'""").fetchone()[0]
        ck.add("A9_dca_rows_are_silver_wells", "*", d == 0, f"{d} decline rows without a silver well row")
        for t in ("wells", "completions"):
            g = str(silver / t / "state=*" / "*.parquet").replace("\\", "/")
            n = con.execute(f"select (select count(*) from {t}) - (select count(*) from read_parquet('{g}', hive_partitioning = false))").fetchone()[0]
            ck.add(f"A10_{t}_row_parity", t, n == 0, f"gold minus silver rows = {n}")
    except duckdb.Error as e:
        ck.add("A5-A10", "*", False, f"query failed: {e}")


def reconcile_county(ck, con, dsv: Path):
    n_tx = con.execute("select count(*) from production_monthly where state = 'TX'").fetchone()[0]
    if n_tx == 0:
        ck.add("county_reconciliation", "production_monthly", True, "not applicable: no TX production rows in this pull")
        return
    with open(dsv, encoding="latin-1", newline="") as f:
        cc = list(csv.DictReader(f, delimiter="}"))
    gold = {}
    for name, y, m, o, g, c, cs in con.execute("""select county, production_year, production_month, sum(oil_bbl), sum(gas_mcf), sum(condensate_bbl), sum(casinghead_gas_mcf)
            from production_monthly where state = 'TX' group by 1, 2, 3""").fetchall():
        gold[(name, int(y), int(m))] = (o or 0, g or 0, c or 0, cs or 0)
    bad = []
    n = 0
    for r in cc:
        key = (r["COUNTY_NAME"].strip().upper(), int(r["CYCLE_YEAR"]), int(r["CYCLE_MONTH"]))
        want = tuple(float(r[k] or 0) for k in ("CNTY_OIL_PROD_VOL", "CNTY_GAS_PROD_VOL", "CNTY_COND_PROD_VOL", "CNTY_CSGD_PROD_VOL"))
        got = gold.get(key, (0, 0, 0, 0))
        n += 1
        if any(abs(a - b) > 0.5 for a, b in zip(want, got)):
            bad.append((key, want, got))
    ck.add("county_reconciliation", "production_monthly", not bad, f"{n} county-months checked, {len(bad)} differ" + (f"; e.g. {bad[:3]}" if bad else ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected", type=Path, required=True)
    ap.add_argument("--actual", type=Path, required=True)
    ap.add_argument("--silver", type=Path, required=True)
    ap.add_argument("--county-cycle", type=Path)
    ap.add_argument("--tables", nargs="*")
    a = ap.parse_args()
    ck = Checks()
    if not a.actual.exists():
        ck.add("database_present", "*", False, f"{a.actual} missing")
        print(json.dumps(ck.result(), indent=2))
        return 1
    exp = duckdb.connect(str(a.expected), read_only=True)
    act = duckdb.connect(str(a.actual), read_only=True)
    try:
        for t in a.tables or list(KEYS):
            try:
                compare_table(ck, t, exp, act)
            except Exception as e:  # noqa: BLE001
                ck.add("crash", t, False, f"{type(e).__name__}: {e}")
        if not a.tables:
            run_asserts(ck, act, a.silver)
            if a.county_cycle and a.county_cycle.exists():
                try:
                    reconcile_county(ck, act, a.county_cycle)
                except Exception as e:  # noqa: BLE001
                    ck.add("county_reconciliation", "*", False, f"{type(e).__name__}: {e}")
    finally:
        exp.close()
        act.close()
    print(json.dumps(ck.result(), indent=2))
    return 0 if ck.result()["pass"] == ck.result()["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
