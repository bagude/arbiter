#!/usr/bin/env python
"""Bronze oracle: checks a bronze tree against docs/dw/contract-bronze.md.

Two modes:
  check  --remote <dir> --bronze <dir> [--bronze2 <dir>]   grade an ingester's output
  audit  --bronze <dir>                                    inventory + manifest truth only

Prints one JSON document: {"checks": [{"name", "state", "ok", "detail"}], "pass", "total"}.
Every expected value is derived here, from bytes: remote files, zip members, and
independent record counts. Nothing is taken from the candidate's manifest on trust.
"""
from __future__ import annotations

import argparse
import codecs
import csv
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

STATES = ("tx", "nm", "ok")
BIG = 2 * 1024 ** 3  # audit mode: skip record counts above this many bytes

# remote relative path (glob) -> bronze relative path builder
def _tx(remote: Path):
    out = {}
    z = remote / "mft" / "PDQ_DSV.zip"
    if z.exists():
        with zipfile.ZipFile(z) as zf:
            for m in zf.namelist():
                out[Path(m).name] = ("zipmember", z, m)
    for p in sorted((remote / "arcgis").glob("page_*.json")):
        out[f"wells/wells_batch_{p.stem.split('_')[1]}.json"] = ("file", p, None)
    return out


def _nm(remote: Path):
    out = {}
    for z in sorted((remote / "ftp").rglob("*.zip")):
        out[f"production/{z.name}"] = ("file", z, None)
        with zipfile.ZipFile(z) as zf:
            for m in zf.namelist():
                out[f"production/{z.stem}/{Path(m).name}"] = ("zipmember", z, m)
    for p in sorted((remote / "arcgis").glob("page_*.json")):
        out[f"wells/wells_batch_{p.stem.split('_')[1]}.json"] = ("file", p, None)
    return out


def _ok(remote: Path):
    out = {}
    names = {
        "rbdms-wells.csv": "data/rbdms_well_data.csv",
        "completions-wells-formations-base.xlsx": "data/completions_wells_formations.xlsx",
        "ITD-wells-formations-base.xlsx": "data/itd_wells_formations.xlsx",
    }
    for src, dst in names.items():
        p = remote / "web" / src
        if p.exists():
            out[dst] = ("file", p, None)
    for p in sorted((remote / "arcgis").glob("page_*.json")):
        out[f"wells/wells_batch_{p.stem.split('_')[1]}.json"] = ("file", p, None)
    return out


EXPECTED = {"tx": _tx, "nm": _nm, "ok": _ok}

# audit mode: which paths the layout allows, per state (regexes on the relative path)
ALLOWED = {
    "tx": [r"^OG_[A-Z_]+\.dsv$", r"^wells/wells_batch_\d{4}\.json$"],
    "nm": [r"^wells/wells_batch_\d{4}\.json$", r"^production/(wcproduction|wchistory|ogrid|pool)\.zip$", r"^production/(wcproduction|wchistory|ogrid|pool)/\1\.xml$"],
    "ok": [r"^wells/wells_batch_\d{4}\.json$", r"^data/rbdms_well_data\.csv$", r"^data/completions_wells_formations\.xlsx$", r"^data/itd_wells_formations\.xlsx$"],
}
REQUIRED = {
    "tx": ["OG_LEASE_CYCLE.dsv", "OG_WELL_COMPLETION.dsv", "OG_OPERATOR_DW.dsv", "OG_FIELD_CYCLE.dsv", "OG_COUNTY_CYCLE.dsv", "wells/wells_batch_0001.json"],
    "nm": ["wells/wells_batch_0001.json"] + [f"production/{n}.zip" for n in ("wcproduction", "wchistory", "ogrid", "pool")] + [f"production/{n}/{n}.xml" for n in ("wcproduction", "wchistory", "ogrid", "pool")],
    "ok": ["wells/wells_batch_0001.json", "data/rbdms_well_data.csv", "data/completions_wells_formations.xlsx", "data/itd_wells_formations.xlsx"],
}


# ---------------------------------------------------------------------------
# independent facts about bytes
# ---------------------------------------------------------------------------

def sha256_path(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_member(z: Path, m: str) -> str:
    h = hashlib.sha256()
    with zipfile.ZipFile(z) as zf, zf.open(m) as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def count_records(p: Path):
    """Independent data-record count by file type; None when the type has none (zip)."""
    suf = p.suffix.lower()
    if suf == ".dsv":
        with open(p, "rb") as f:
            n = sum(1 for _ in f)
        return max(n - 1, 0)
    if suf == ".csv":
        with open(p, "r", encoding="utf-8", errors="replace", newline="") as f:
            r = csv.reader(f)
            next(r, None)
            return sum(1 for _ in r)
    if suf == ".json":
        d = json.loads(p.read_text(encoding="utf-8"))
        return len(d.get("features", []))
    if suf == ".xlsx":
        import openpyxl
        wb = openpyxl.load_workbook(p, read_only=True)
        ws = wb.worksheets[0]
        rows = ws.iter_rows(values_only=True)
        next(rows, None)
        return sum(1 for _ in rows)
    if suf == ".xml":
        return count_xml_records(p)
    return None


XML_REC = re.compile(r"<(\w+) xmlns=\"urn:schemas-microsoft-com:sql:SqlRowSet1\">")


def count_xml_records(p: Path) -> int:
    with open(p, "rb") as f:
        bom = f.read(2)
        enc = "utf-16-le" if bom == b"\xff\xfe" else "utf-16-be" if bom == b"\xfe\xff" else "utf-8"
        if enc == "utf-8":
            f.seek(0)
        dec = codecs.getincrementaldecoder(enc)()
        n = 0
        tail = ""
        for chunk in iter(lambda: f.read(8 << 20), b""):
            text = tail + dec.decode(chunk)
            n += len(XML_REC.findall(text))
            tail = text[-80:]
            # avoid double counting a match that sat entirely in the tail
            n -= len(XML_REC.findall(tail))
        n += len(XML_REC.findall(tail))
    return n


def zip_members(p: Path):
    with zipfile.ZipFile(p) as zf:
        return [{"name": i.filename, "bytes": i.file_size} for i in zf.infolist()]


def list_files(root: Path):
    return sorted(str(f.relative_to(root)).replace("\\", "/") for f in root.rglob("*") if f.is_file())


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------

class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, state, ok, detail=""):
        self.items.append({"name": name, "state": state, "ok": bool(ok), "detail": str(detail)[:2000]})

    def result(self):
        p = sum(1 for c in self.items if c["ok"])
        return {"checks": self.items, "pass": p, "total": len(self.items)}


def load_manifest(pull: Path):
    mp = pull / "manifest.json"
    if not mp.exists():
        return None, "manifest.json missing"
    try:
        return json.loads(mp.read_text(encoding="utf-8")), None
    except Exception as e:  # noqa: BLE001
        return None, f"manifest.json unparseable: {e}"


def check_manifest_truth(ck: Checks, state: str, pull: Path, man: dict, count: bool = True, big_skip: bool = False):
    present = [f for f in list_files(pull) if f != "manifest.json"]
    files = man.get("files")
    if not isinstance(files, list):
        ck.add("manifest_truth", state, False, "files is not a list")
        return
    listed = [f.get("path") for f in files]
    ck.add("manifest_lists_present_files", state, listed == present, f"listed={len(listed)} present={len(present)}; missing={sorted(set(present) - set(listed))[:10]} extra={sorted(set(listed) - set(present))[:10]}; sorted={listed == sorted(listed)}")
    for entry in files:
        rel = entry.get("path")
        p = pull / rel if isinstance(rel, str) else None
        if p is None or not p.exists():
            continue
        size = p.stat().st_size
        ok_bytes = entry.get("bytes") == size
        ok_sha = entry.get("sha256") == sha256_path(p)
        detail = f"bytes {entry.get('bytes')} vs {size}; sha256 {'ok' if ok_sha else 'MISMATCH'}"
        if p.suffix.lower() == ".zip":
            ok_rec = entry.get("members") == zip_members(p)
            detail += f"; members {'ok' if ok_rec else 'MISMATCH'}"
        elif count and not (big_skip and size > BIG):
            actual = count_records(p)
            ok_rec = entry.get("records") == actual
            detail += f"; records {entry.get('records')} vs {actual}"
        else:
            ok_rec = True
            detail += "; records not counted (large file)"
        ck.add("manifest_entry", state, ok_bytes and ok_sha and ok_rec, f"{rel}: {detail}")


def check_layout(ck: Checks, state: str, pull: Path, man: dict):
    ck.add("manifest_state_matches", state, man.get("state") == state and man.get("pull_date") == pull.name, f"state={man.get('state')} pull_date={man.get('pull_date')} dir={pull.name}")
    ck.add("manifest_sources", state, isinstance(man.get("sources"), list) and len(man["sources"]) > 0 and all(isinstance(s, dict) and s.get("name") and s.get("url") for s in man["sources"]), str(man.get("sources"))[:200])
    ck.add("manifest_pulled_at", state, bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", str(man.get("pulled_at", "")))), str(man.get("pulled_at")))


def check_state(ck: Checks, state: str, remote: Path, bronze: Path):
    exp = EXPECTED[state](remote / state)
    pulls = sorted(d for d in (bronze / state).iterdir() if d.is_dir()) if (bronze / state).exists() else []
    if len(pulls) != 1:
        ck.add("layout", state, False, f"expected exactly one pull directory under {bronze / state}, found {[p.name for p in pulls]}")
        return
    pull = pulls[0]
    man, err = load_manifest(pull)
    ck.add("layout", state, man is not None, err or f"pull {pull.name}, manifest ok")
    if man is None:
        return
    check_layout(ck, state, pull, man)
    present = [f for f in list_files(pull) if f != "manifest.json"]
    missing = [k for k in exp if not (pull / k).exists()]
    ck.add("completeness", state, not missing, f"{len(exp)} expected artifacts; missing={missing[:10]}")
    extras = sorted(set(present) - set(exp))
    ck.add("no_extras", state, not extras, f"extras={extras[:10]}")
    bad = []
    for rel, (kind, src, member) in exp.items():
        p = pull / rel
        if not p.exists():
            continue
        want = sha256_path(src) if kind == "file" else sha256_member(src, member)
        if sha256_path(p) != want:
            bad.append(rel)
    ck.add("integrity", state, not bad, f"byte-identical to remote except: {bad[:10]}")
    # `from` must name the zip for extracted members
    by_path = {f.get("path"): f for f in man.get("files", []) if isinstance(f, dict)}
    wrong_from = [rel for rel, (kind, src, member) in exp.items() if kind == "zipmember" and by_path.get(rel, {}).get("from") != src.name]
    ck.add("manifest_from", state, not wrong_from, f"entries lacking from=<zip>: {wrong_from[:10]}")
    check_manifest_truth(ck, state, pull, man)


def check_idempotence(ck: Checks, state: str, b1: Path, b2: Path):
    def strip(d):
        if d is None:
            return None
        return {k: v for k, v in d.items() if k != "pulled_at"}
    p1 = sorted(d for d in (b1 / state).iterdir() if d.is_dir()) if (b1 / state).exists() else []
    p2 = sorted(d for d in (b2 / state).iterdir() if d.is_dir()) if (b2 / state).exists() else []
    m1 = load_manifest(p1[0])[0] if p1 else None
    m2 = load_manifest(p2[0])[0] if p2 else None
    ck.add("idempotence", state, m1 is not None and strip(m1) == strip(m2), "second run manifest equals the first apart from pulled_at" if strip(m1) == strip(m2) else "manifests differ between runs")


def audit_state(ck: Checks, state: str, bronze: Path):
    root = bronze / state
    pulls = sorted(d for d in root.iterdir() if d.is_dir()) if root.exists() else []
    if not pulls:
        ck.add("layout", state, False, f"no pull directories under {root}")
        return
    for pull in pulls:
        man, err = load_manifest(pull)
        ck.add("layout", state, man is not None, err or f"pull {pull.name}, manifest ok")
        present = [f for f in list_files(pull) if f != "manifest.json"]
        allowed = [re.compile(x) for x in ALLOWED[state]]
        extras = [f for f in present if not any(a.match(f) for a in allowed)]
        ck.add("no_extras", state, not extras, f"{pull.name}: files outside the layout: {extras[:10]}")
        missing = [r for r in REQUIRED[state] if not (pull / r).exists()]
        ck.add("completeness", state, not missing, f"{pull.name}: required artifacts missing: {missing}")
        # zips extracted?
        for z in pull.glob("production/*.zip"):
            x = pull / "production" / z.stem / f"{z.stem}.xml"
            ck.add("zip_extracted", state, x.exists(), f"{z.name} -> {x.relative_to(pull)} {'present' if x.exists() else 'MISSING'}")
            if x.exists():
                with zipfile.ZipFile(z) as zf:
                    info = zf.getinfo(zf.namelist()[0])
                ck.add("member_size", state, info.file_size == x.stat().st_size, f"{x.name}: member {info.file_size} bytes vs extracted {x.stat().st_size}")
        # pages: contiguous numbering and declared counts
        pages = sorted(pull.glob("wells/wells_batch_*.json"))
        nums = [int(p.stem.split("_")[-1]) for p in pages]
        ck.add("pages_contiguous", state, nums == list(range(1, len(nums) + 1)), f"{len(pages)} pages, numbering {'contiguous' if nums == list(range(1, len(nums) + 1)) else 'has gaps'}")
        if man is None:
            continue
        check_layout(ck, state, pull, man) if "files" in man else None
        if "files" in man:
            check_manifest_truth(ck, state, pull, man, count=True, big_skip=True)
        else:
            # legacy manifest (ingester's own shape): verify the claims it does make
            feats = 0
            for p in pages:
                try:
                    feats += len(json.loads(p.read_text(encoding="utf-8")).get("features", []))
                except Exception as e:  # noqa: BLE001
                    ck.add("page_parse", state, False, f"{p.name}: {e}")
            if "wells_features" in man:
                ck.add("manifest_wells_features", state, man["wells_features"] == feats, f"{pull.name}: manifest claims {man['wells_features']} well features; {feats} counted across {len(pages)} page files")
            for key, rel in (("csv_path", "data/rbdms_well_data.csv"), ("completions_path", "data/completions_wells_formations.xlsx"), ("itd_path", "data/itd_wells_formations.xlsx")):
                if key in man or (pull / rel).exists():
                    claimed = bool(man.get(key))
                    ck.add("manifest_claim", state, claimed == (pull / rel).exists(), f"{pull.name}: manifest {key}={man.get(key)!r} while {rel} {'exists' if (pull / rel).exists() else 'is absent'}")
            if "production_files" in man:
                zips = list(pull.glob("production/*.zip"))
                extracted = [z for z in zips if (pull / "production" / z.stem / f"{z.stem}.xml").exists()]
                ck.add("manifest_claim", state, man["production_files"] == len(zips) and len(extracted) == len(zips), f"{pull.name}: manifest production_files={man['production_files']}; {len(zips)} zips present, {len(extracted)} extracted")
            for key in ("wells_dir", "production_dir", "data_dir"):
                if key in man:
                    ck.add("manifest_absolute_path", state, False, f"{pull.name}: manifest stores an absolute machine path in {key}: {man[key]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["check", "audit"])
    ap.add_argument("--remote", type=Path)
    ap.add_argument("--bronze", type=Path, required=True)
    ap.add_argument("--bronze2", type=Path, help="a second run's output, for the idempotence check")
    ap.add_argument("--states", nargs="*", default=list(STATES))
    a = ap.parse_args()
    ck = Checks()
    if a.mode == "check":
        if not a.remote:
            ap.error("check needs --remote")
        for s in a.states:
            if not (a.remote / s).exists():
                continue
            try:
                check_state(ck, s, a.remote, a.bronze)
                if a.bronze2:
                    check_idempotence(ck, s, a.bronze, a.bronze2)
            except Exception as e:  # noqa: BLE001
                ck.add("crash", s, False, f"{type(e).__name__}: {e}")
    else:
        for s in a.states:
            try:
                audit_state(ck, s, a.bronze)
            except Exception as e:  # noqa: BLE001
                ck.add("crash", s, False, f"{type(e).__name__}: {e}")
    print(json.dumps(ck.result(), indent=2))
    return 0 if ck.result()["pass"] == ck.result()["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
