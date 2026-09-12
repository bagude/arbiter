#!/usr/bin/env python
"""Exploration oracle: grade src/exploration.json by reproduction (docs/dw/contract-explore.md).

    python explore_check.py <workspace> --data <dir with data/> [--observation O1] [--query "<sql>"]

Prints one JSON document: {"checks": [...], "pass", "total", "digest"} — or, with --query,
{"rows": [...], "error": ...}.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import threading
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import duckdb

MIN_OBS = 5
MAX_ROWS = 50
FORBIDDEN = ["attach", "copy", "install", "load", "pragma", "create", "insert", "update", "delete", "drop", "alter", "export", "import", "read_csv", "read_parquet", "read_json", "glob("]
NUM = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=""):
        self.items.append({"name": name, "ok": bool(ok), "detail": str(detail)[:1200]})

    def result(self, digest=""):
        p = sum(1 for c in self.items if c["ok"])
        return {"checks": self.items, "pass": p, "total": len(self.items), "digest": digest}


def query_ok(sql) -> str | None:
    if not isinstance(sql, str) or not sql.strip():
        return "query is empty"
    s = sql.strip().rstrip(";").strip()
    if ";" in s:
        return "query must be a single statement"
    if not re.match(r"^(select|with)\b", s, re.I):
        return "query must start with select or with"
    low = re.sub(r"'[^']*'", "''", s.lower())
    for w in FORBIDDEN:
        if re.search(rf"(?<![\w.]){re.escape(w)}(?![\w])" if not w.endswith("(") else re.escape(w), low):
            return f"query uses forbidden word {w!r}"
    return None


def run_query(db: Path, sql: str, limit: int = MAX_ROWS):
    con = duckdb.connect(str(db), read_only=True)
    out = {}

    def work():
        try:
            cur = con.execute(sql.strip().rstrip(";"))
            out["rows"] = cur.fetchmany(limit + 1)
        except Exception as e:  # noqa: BLE001
            out["error"] = f"{type(e).__name__}: {e}"

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(10)
    if t.is_alive():
        try:
            con.interrupt()
        except Exception:  # noqa: BLE001
            pass
        return None, "query exceeded 10 s"
    con.close()
    if "error" in out:
        return None, out["error"]
    rows = out["rows"]
    if len(rows) > limit:
        return None, f"query returns more than {limit} rows; add a limit"
    return [list(r) for r in rows], None


def norm(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v


def same(a, b) -> bool:
    a, b = norm(a), norm(b)
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= 1e-6 * max(1.0, abs(float(a)))
    if isinstance(a, str) and isinstance(b, str):
        return a == b or a.replace("T", " ") == b.replace("T", " ")
    return a == b


def numbers_in(rows):
    vals = set()
    for r in rows:
        for v in r:
            v = norm(v)
            if isinstance(v, bool) or v is None:
                continue
            if isinstance(v, (int, float)):
                vals.add(f"{v:.6g}")
                vals.add(str(int(round(v))))
                vals.add(f"{v:,.0f}")
                vals.add(f"{v:.1f}")
                vals.add(f"{v:.2f}")
            elif isinstance(v, str):
                for m in NUM.findall(v):
                    vals.add(m.replace(",", ""))
    return vals


def check_observation(o, db: Path):
    bad = []
    if not isinstance(o, dict):
        return ["observation is not an object"]
    for k in ("title", "observation", "why_it_matters"):
        if not (isinstance(o.get(k), str) and o[k].strip()):
            bad.append(f"{k} empty")
    c = o.get("confidence")
    if not (isinstance(c, (int, float)) and not isinstance(c, bool) and 0 <= c <= 1):
        bad.append("confidence must be a number in [0, 1]")
    err = query_ok(o.get("query"))
    if err:
        bad.append(err)
        return bad
    res = o.get("result")
    if not isinstance(res, list) or not all(isinstance(r, list) for r in res):
        bad.append("result must be a list of rows (lists)")
        return bad
    if len(res) > MAX_ROWS:
        bad.append(f"result has more than {MAX_ROWS} rows")
    rows, qerr = run_query(db, o["query"])
    if qerr:
        bad.append(f"query failed on re-execution: {qerr}")
        return bad
    if len(rows) != len(res):
        bad.append(f"re-execution returned {len(rows)} rows, result claims {len(res)}")
    else:
        for i, (a, b) in enumerate(zip(res, rows)):
            if len(a) != len(b) or not all(same(x, y) for x, y in zip(a, b)):
                bad.append(f"row {i} differs: claimed {json.dumps([norm(x) for x in a])[:120]} actual {json.dumps([norm(y) for y in b])[:120]}")
                break
    if rows:
        nums = numbers_in(rows)
        mentioned = [m.replace(",", "") for m in NUM.findall(str(o.get("observation", "")))]
        if not any(m in nums or (m.replace(".", "", 1).isdigit() and any(m == n for n in nums)) for m in mentioned):
            bad.append("observation text mentions no number that appears in the result")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--data", type=Path)
    ap.add_argument("--observation")
    ap.add_argument("--query")
    a = ap.parse_args()
    data = a.data or a.workspace
    db = data / "data" / "gold" / "warehouse.duckdb"
    if a.query is not None:
        err = query_ok(a.query)
        if err:
            print(json.dumps({"rows": None, "error": err}))
            return 0
        rows, qerr = run_query(db, a.query)
        print(json.dumps({"rows": [[norm(v) for v in r] for r in rows] if rows is not None else None, "error": qerr}, default=str))
        return 0
    ck = Checks()
    p = a.workspace / "src" / "exploration.json"
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(doc, dict)
    except Exception as e:  # noqa: BLE001
        ck.add("exploration_json", False, f"src/exploration.json missing or unparseable: {e}")
        print(json.dumps(ck.result(), indent=2))
        return 1
    obs = doc.get("observations") if isinstance(doc.get("observations"), list) else []
    if a.observation:
        o = next((x for x in obs if isinstance(x, dict) and x.get("id") == a.observation), None)
        if o is None:
            ck.add("observation", False, f"no observation {a.observation}")
        else:
            bad = check_observation(o, db)
            ck.add(f"observation {a.observation}", not bad, "; ".join(bad) or "reproduces")
        print(json.dumps(ck.result(), indent=2))
        return 0
    ck.add("scope", isinstance(doc.get("scope"), str) and doc["scope"].strip() != "", str(doc.get("scope"))[:100])
    ids = [o.get("id") if isinstance(o, dict) else None for o in obs]
    titles = [str(o.get("title", "")).strip().lower() if isinstance(o, dict) else "" for o in obs]
    ck.add("observations_count", len(obs) >= MIN_OBS, f"{len(obs)} observations (min {MIN_OBS})")
    ck.add("ids_unique", len(set(ids)) == len(ids) and all(isinstance(i, str) and i for i in ids), str(ids)[:200])
    ck.add("titles_distinct", len(set(titles)) == len(titles), "")
    nq = doc.get("next_questions")
    ck.add("next_questions", isinstance(nq, list) and len(nq) > 0 and all(isinstance(q, str) and q.strip() for q in nq), str(nq)[:200])
    for o in obs:
        oid = o.get("id") if isinstance(o, dict) else "?"
        bad = check_observation(o, db)
        ck.add(f"observation {oid}", not bad, "; ".join(bad) or "reproduces")
    md = a.workspace / "src" / "exploration.md"
    ck.add("exploration_md", md.is_file() and md.stat().st_size > 200, "present" if md.is_file() else "src/exploration.md missing")
    # The digest is what later runs are told: the titles found, then the open questions
    # this run left — the seeds of a self-recursive exploration.
    digest = " | ".join(f"{o.get('id')} {str(o.get('title', ''))[:80]}" for o in obs if isinstance(o, dict))
    if isinstance(nq, list) and nq:
        digest += " || next: " + " | ".join(str(q)[:140] for q in nq[:5] if isinstance(q, str))
    print(json.dumps(ck.result(digest), indent=2))
    return 0 if ck.result()["pass"] == ck.result()["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
