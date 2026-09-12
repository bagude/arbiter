#!/usr/bin/env python
"""Silver oracle: compare a candidate silver tree with the reference's, table by table,
and check hand-traced labels (docs/dw/contract-silver.md §7).

    python silver_check.py --expected <ref silver dir> --actual <candidate silver dir> \
        --contract <dir with silver_schema.py> [--labels labels.json] [--tables wells production completions] [--states TX NM OK]

Prints one JSON document: {"checks": [{"name", "table", "state", "ok", "detail"}], "pass", "total"}.
`ingested_at` is never compared. Rows are matched by the table's key columns.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime
from pathlib import Path

import pyarrow.parquet as pq


def load(dirpath: Path, table: str, state: str):
    p = dirpath / table / f"state={state}" / f"{state.lower()}_{table}.parquet"
    if not p.exists():
        return None, None
    f = pq.ParquetFile(p)
    t = f.read()
    return t.schema.remove_metadata(), t.to_pylist()


def norm(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def keyed(rows, keys):
    out = {}
    for r in rows:
        k = tuple(norm(r.get(c)) for c in keys)
        out.setdefault(k, []).append(r)
    return out


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, table, state, ok, detail=""):
        self.items.append({"name": name, "table": table, "state": state, "ok": bool(ok), "detail": str(detail)[:1500]})

    def result(self):
        p = sum(1 for c in self.items if c["ok"])
        return {"checks": self.items, "pass": p, "total": len(self.items)}


def compare_table(ck: Checks, table: str, state: str, expected: Path, actual: Path, schemas, keys):
    es, erows = load(expected, table, state)
    as_, arows = load(actual, table, state)
    if es is None:
        ck.add("reference_present", table, state, False, "reference produced no file (oracle bug)")
        return
    if as_ is None:
        ck.add("file_present", table, state, False, f"{table}/state={state}/{state.lower()}_{table}.parquet missing")
        return
    ck.add("file_present", table, state, True, "")
    schema_ok = as_.equals(schemas[table])
    ck.add("schema", table, state, schema_ok, "" if schema_ok else f"schema differs from contract:\n{as_}\nvs\n{schemas[table]}")
    ck.add("row_count", table, state, len(arows) == len(erows), f"{len(arows)} rows vs {len(erows)} expected")
    ek = keyed(erows, keys[table])
    ak = keyed(arows, keys[table])
    missing = [k for k in ek if k not in ak]
    extra = [k for k in ak if k not in ek]
    dupes = [k for k, v in ak.items() if len(v) > 1]
    ck.add("keys", table, state, not missing and not extra and not dupes, f"missing={len(missing)} {missing[:3]}; extra={len(extra)} {extra[:3]}; duplicate keys={len(dupes)} {dupes[:3]}")
    cols = [f.name for f in schemas[table] if f.name != "ingested_at"]
    diffs = []
    ncmp = 0
    for k, ev in ek.items():
        av = ak.get(k)
        if not av or len(av) != 1 or len(ev) != 1:
            continue
        ncmp += 1
        for c in cols:
            e, a = norm(ev[0].get(c)), norm(av[0].get(c))
            if e != a:
                diffs.append((k, c, e, a))
    by_col = {}
    for _, c, _, _ in diffs:
        by_col[c] = by_col.get(c, 0) + 1
    sample = "; ".join(f"{k} {c}: expected {e!r} got {a!r}" for k, c, e, a in diffs[:4])
    ck.add("values", table, state, not diffs, f"{ncmp} rows compared, {len(diffs)} cell differences" + (f" by column {by_col}; e.g. {sample}" if diffs else ""))


def check_manifest(ck: Checks, expected: Path, actual: Path):
    try:
        em = json.loads((expected / "manifest.json").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        ck.add("manifest", "*", "*", False, f"reference manifest unreadable: {e}")
        return
    try:
        am = json.loads((actual / "manifest.json").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        ck.add("manifest", "*", "*", False, f"manifest.json missing or unparseable: {e}")
        return
    ck.add("manifest_rows", "*", "*", am.get("rows") == em.get("rows"), f"rows {am.get('rows')} vs expected {em.get('rows')}")
    ed = {s: {k: v for k, v in d.items() if v} for s, d in em.get("dropped", {}).items()}
    ad = {s: {k: v for k, v in (d or {}).items() if v} for s, d in (am.get("dropped") or {}).items()} if isinstance(am.get("dropped"), dict) else None
    ck.add("manifest_dropped", "*", "*", ad == ed, f"dropped {ad} vs expected {ed}")


def check_labels(ck: Checks, labels: list, actual: Path, keys):
    cache = {}
    for lab in labels:
        table, state = lab["table"], lab["state"]
        if (table, state) not in cache:
            _, rows = load(actual, table, state)
            cache[(table, state)] = keyed(rows or [], keys[table])
        k = tuple(norm(lab["key"].get(c)) for c in keys[table])
        rows = cache[(table, state)].get(k)
        if not rows:
            ck.add("label", table, state, False, f"{lab['id']}: no row with key {dict(zip(keys[table], k))}")
            continue
        bad = {c: (norm(rows[0].get(c)), v) for c, v in lab["expect"].items() if norm(rows[0].get(c)) != v}
        ck.add("label", table, state, not bad, f"{lab['id']}: " + ("ok" if not bad else "; ".join(f"{c}: got {g!r} expected {e!r}" for c, (g, e) in bad.items())))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expected", type=Path, required=True)
    ap.add_argument("--actual", type=Path, required=True)
    ap.add_argument("--contract", type=Path, required=True)
    ap.add_argument("--labels", type=Path)
    ap.add_argument("--tables", nargs="*")
    ap.add_argument("--states", nargs="*")
    a = ap.parse_args()
    sys.path.insert(0, str(a.contract))
    from silver_schema import KEYS, SCHEMAS, TABLES_BY_STATE  # noqa: E402

    ck = Checks()
    pairs = [(t, s) for s, ts in TABLES_BY_STATE.items() for t in ts]
    if a.tables:
        pairs = [(t, s) for t, s in pairs if t in a.tables]
    if a.states:
        pairs = [(t, s) for t, s in pairs if s in a.states]
    for t, s in pairs:
        try:
            compare_table(ck, t, s, a.expected, a.actual, SCHEMAS, KEYS)
        except Exception as e:  # noqa: BLE001
            ck.add("crash", t, s, False, f"{type(e).__name__}: {e}")
    if not a.tables and not a.states:
        check_manifest(ck, a.expected, a.actual)
    if a.labels and a.labels.exists():
        labels = json.loads(a.labels.read_text(encoding="utf-8"))
        labels = [l for l in labels if (not a.tables or l["table"] in a.tables) and (not a.states or l["state"] in a.states)]
        try:
            check_labels(ck, labels, a.actual, KEYS)
        except Exception as e:  # noqa: BLE001
            ck.add("crash", "labels", "*", False, f"{type(e).__name__}: {e}")
    print(json.dumps(ck.result(), indent=2))
    return 0 if ck.result()["pass"] == ck.result()["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
