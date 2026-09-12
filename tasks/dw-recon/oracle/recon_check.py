#!/usr/bin/env python
"""Reconciliation oracle: grade src/health.json against docs/dw/contract-recon.md.

    python recon_check.py <workspace> [--data <dir with data/ and contract/>] [--finding F1] [--kpi-only]

Prints one JSON document: {"checks": [{"name","ok","detail"}], "pass", "total", "digest"}.
`--data` lets the candidate's src/ live elsewhere than the inputs (the supervisor's
probe dir holds only src/).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kpi import compute  # noqa: E402

TEXT = {".json", ".md", ".py", ".dsv", ".csv", ".txt", ".xml"}
SEVERITIES = {"info", "warn", "error"}
LAYERS = {"bronze", "silver", "gold", "cross"}
MIN_FINDINGS = 3


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=""):
        self.items.append({"name": name, "ok": bool(ok), "detail": str(detail)[:1200]})

    def result(self, digest=""):
        p = sum(1 for c in self.items if c["ok"])
        return {"checks": self.items, "pass": p, "total": len(self.items), "digest": digest}


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict) and k != "dropped":
            out.update(flatten(v, key + "."))
        else:
            out[key] = v
            if isinstance(v, dict):  # dropped: the object and each reason are both citable
                for kk, vv in v.items():
                    out[f"{key}.{kk}"] = vv
    return out


def read_text(p: Path) -> str:
    raw = p.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    return raw.decode("utf-8", errors="replace")


def check_finding(f, data: Path, kpi_flat: dict):
    """Return the list of failed rule labels for one finding."""
    bad = []
    if not isinstance(f, dict):
        return ["finding is not an object"]
    if f.get("severity") not in SEVERITIES:
        bad.append(f"severity {f.get('severity')!r} not in {sorted(SEVERITIES)}")
    if f.get("layer") not in LAYERS:
        bad.append(f"layer {f.get('layer')!r} not in {sorted(LAYERS)}")
    if f.get("state") not in ("TX", "NM", "OK", None):
        bad.append(f"state {f.get('state')!r} not in TX/NM/OK/null")
    for k in ("title", "description"):
        if not (isinstance(f.get(k), str) and f[k].strip()):
            bad.append(f"{k} empty")
    ev = f.get("evidence")
    if not isinstance(ev, list) or not ev:
        bad.append("evidence missing or empty")
        return bad
    for i, e in enumerate(ev):
        if not isinstance(e, dict):
            bad.append(f"evidence[{i}] is not an object")
            continue
        if "kpi" in e:
            if e["kpi"] not in kpi_flat:
                bad.append(f"evidence[{i}] kpi path {e['kpi']!r} does not exist")
            continue
        file, quote = e.get("file"), e.get("quote")
        if not isinstance(file, str) or not file:
            bad.append(f"evidence[{i}] needs file+quote or kpi")
            continue
        rel = Path(file.replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts or rel.parts[0] not in ("data", "contract"):
            bad.append(f"evidence[{i}] file {file!r} is not under data/ or contract/")
            continue
        p = data / rel
        if not p.is_file():
            bad.append(f"evidence[{i}] file {file!r} does not exist")
            continue
        if p.suffix.lower() not in TEXT:
            bad.append(f"evidence[{i}] file {file!r} is not a text file ({p.suffix}); cite a manifest, contract or raw text file, or a kpi path")
            continue
        if not isinstance(quote, str) or len(quote) < 12:
            bad.append(f"evidence[{i}] quote must be a string of at least 12 characters")
            continue
        if quote not in read_text(p):
            bad.append(f"evidence[{i}] quote not found verbatim in {file}: {quote[:60]!r}")
    return bad


def compact(kpi: dict) -> dict:
    """The KPI digest as memory carries it: one small JSON object per state."""
    out = {}
    for s, k in kpi.items():
        prod = k["silver"].get("production")
        c = {"pull_date": k["bronze"]["pull_date"], "landed_at": k["bronze"]["landed_at"], "files": k["bronze"]["files"], "records": k["bronze"]["records"], "wells": k["silver"]["wells"]["rows"]}
        if prod:
            c.update({"production_rows": prod["rows"], "last_month": prod["last_month"], "freshness_months": prod["freshness_months"]})
        else:
            c["completions_rows"] = k["silver"]["completions"]["rows"]
        c["parity"] = bool(k["gold"]["parity"])
        out[s] = c
    return out


def digest_of(kpi: dict) -> str:
    return json.dumps(compact(kpi), separators=(",", ":"), sort_keys=True)


def previous_report(memory: Path | None):
    """The newest surviving dw-recon record in memory with a JSON KPI digest → (run id, digest dict), or None.

    Mirrors what the wiki shows the agent: the record's first run: evidence and the
    digest on it. Records tombstoned by consolidation are ignored, like the wiki does.
    """
    if not memory or not memory.exists():
        return None
    recs, status = {}, {}
    for line in memory.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("op") == "tombstone":
            status[e.get("id")] = "tombstoned"
        elif e.get("op") == "promote":
            status[e.get("id")] = "promoted"
        elif e.get("id"):
            recs[e["id"]] = e
    best = None
    for r in recs.values():
        st = status.get(r["id"], r.get("status"))
        if st != "promoted" or r.get("kind") != "episodic" or not str(r.get("text", "")).startswith("dw-recon via"):
            continue
        m = re.search(r"KPI digest: (\{.*\})\s*$", r.get("text", ""), re.S)
        if not m:
            continue
        try:
            digest = json.loads(m.group(1))
        except ValueError:
            continue
        run = next((str(x)[4:] for x in r.get("evidence", []) if str(x).startswith("run:")), None)
        if run and (best is None or r["ts"] > best[2]):
            best = (run, digest, r["ts"])
    return (best[0], best[1]) if best else None


def diff_digests(prev: dict, cur: dict):
    changed, unchanged = {}, 0
    for s in sorted(set(prev) | set(cur)):
        for key in sorted(set(prev.get(s, {})) | set(cur.get(s, {}))):
            a, b = prev.get(s, {}).get(key), cur.get(s, {}).get(key)
            if a != b:
                changed[f"{s}.{key}"] = {"from": a, "to": b}
            else:
                unchanged += 1
    return changed, unchanged


def check_since_last(ck: Checks, doc: dict, kpi: dict, memory: Path | None):
    prev = previous_report(memory)
    got = doc.get("since_last", "MISSING")
    if got == "MISSING":
        ck.add("since_last", False, "since_last is missing (null when no earlier report is known)")
        return
    if prev is None:
        ck.add("since_last", got is None, "no earlier JSON KPI digest in memory → since_last must be null" if got is not None else "null, as expected: no earlier report")
        return
    run, pdigest = prev
    if not isinstance(got, dict):
        ck.add("since_last", False, f"an earlier report exists (run {run}); since_last must be an object")
        return
    changed, unchanged = diff_digests(pdigest, compact(kpi))
    bad = []
    if got.get("run") != run:
        bad.append(f"run {got.get('run')!r} ≠ the newest earlier report {run!r}")
    if got.get("previous") != pdigest:
        bad.append("previous does not equal that report's KPI digest verbatim")
    if got.get("changed") != changed:
        bad.append(f"changed differs: expected {json.dumps(changed)[:300]} got {json.dumps(got.get('changed'))[:300]}")
    if got.get("unchanged") != unchanged:
        bad.append(f"unchanged {got.get('unchanged')!r} ≠ {unchanged}")
    ck.add("since_last", not bad, "; ".join(bad) or f"compared with {run}: {len(changed)} changed, {unchanged} unchanged")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--data", type=Path, help="directory holding data/ and contract/ (default: the workspace)")
    ap.add_argument("--finding")
    ap.add_argument("--kpi-only", action="store_true")
    ap.add_argument("--memory", type=Path, help="memory/records.jsonl — enables the since_last check against the newest earlier report")
    a = ap.parse_args()
    data = a.data or a.workspace
    ck = Checks()
    kpi = compute(data)
    kpi_flat = flatten(kpi)
    digest = digest_of(kpi)
    if a.kpi_only:
        prev = previous_report(a.memory)
        print(json.dumps({"kpi": kpi, "digest": digest, "previous_report": {"run": prev[0], "digest": prev[1]} if prev else None}, indent=2))
        return 0
    hp = a.workspace / "src" / "health.json"
    try:
        doc = json.loads(hp.read_text(encoding="utf-8"))
        assert isinstance(doc, dict)
    except Exception as e:  # noqa: BLE001
        ck.add("health_json", False, f"src/health.json missing or unparseable: {e}")
        print(json.dumps(ck.result(digest), indent=2))
        return 1
    if a.finding:
        f = next((x for x in doc.get("findings", []) if isinstance(x, dict) and x.get("id") == a.finding), None)
        if f is None:
            ck.add("finding", False, f"no finding {a.finding}")
        else:
            bad = check_finding(f, data, kpi_flat)
            ck.add(f"finding {a.finding}", not bad, "; ".join(bad) or "grounded")
        print(json.dumps(ck.result(digest), indent=2))
        return 0
    pull_dates = {s: k["bronze"]["pull_date"] for s, k in kpi.items()}
    ck.add("report_of", doc.get("report_of") in set(pull_dates.values()), f"report_of {doc.get('report_of')!r} vs pull dates {sorted(set(pull_dates.values()))}")
    ck.add("generated_at", bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", str(doc.get("generated_at", "")))), str(doc.get("generated_at")))
    got = doc.get("kpi")
    if not isinstance(got, dict):
        ck.add("kpi_block", False, "kpi is not an object")
    else:
        got_flat = flatten(got)
        missing = sorted(set(kpi_flat) - set(got_flat))
        extra = sorted(set(got_flat) - set(kpi_flat))
        diff = sorted(k for k in kpi_flat if k in got_flat and got_flat[k] != kpi_flat[k])
        ck.add("kpi_keys", not missing and not extra, f"missing {missing[:8]}; extra {extra[:8]}")
        ck.add("kpi_values", not diff, f"{len(diff)} differing: " + "; ".join(f"{k}: reported {got_flat[k]!r} actual {kpi_flat[k]!r}" for k in diff[:6]))
    findings = doc.get("findings")
    if not isinstance(findings, list):
        ck.add("findings", False, "findings is not a list")
    else:
        ids = [f.get("id") if isinstance(f, dict) else None for f in findings]
        ck.add("findings_count", len(findings) >= MIN_FINDINGS, f"{len(findings)} findings (min {MIN_FINDINGS})")
        ck.add("findings_ids_unique", len(set(ids)) == len(ids) and all(isinstance(i, str) and i for i in ids), str(ids)[:200])
        for f in findings:
            fid = f.get("id") if isinstance(f, dict) else "?"
            bad = check_finding(f, data, kpi_flat)
            ck.add(f"finding {fid}", not bad, "; ".join(bad) or "grounded")
    check_since_last(ck, doc, kpi, a.memory)
    md = a.workspace / "src" / "health.md"
    ck.add("health_md", md.is_file() and md.stat().st_size > 200, "src/health.md present and non-trivial" if md.is_file() else "src/health.md missing")
    print(json.dumps(ck.result(digest), indent=2))
    return 0 if ck.result()["pass"] == ck.result()["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
