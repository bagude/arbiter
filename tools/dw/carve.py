#!/usr/bin/env python
"""Carve the data-warehousers seed: a small, REAL slice of each agency's download.

Reads the Downloads repo read-only and writes `remote/<state>/...` laid out the way
the agencies serve the data (TX: a PDQ zip of `}`-delimited DSVs + ArcGIS pages;
NM: FTP zips of UTF-16 SQL-Server XML + ArcGIS pages; OK: ArcGIS pages + RBDMS CSV
+ completions/ITD XLSX). Formats are preserved byte-for-byte where a file is copied
whole and structurally where rows are filtered (same headers, same encodings, same
XSD preamble). Nothing is parsed into a canonical form here: the seed is bronze's
INPUT, and every later oracle derives its truth from it independently.

    python tools/dw/carve.py --src <data-warehousers repo> --out tasks/dw-seed/remote

Slices: TX county 421 (Sherman); NM ~40 wells present in both the ArcGIS page and
wcproduction; OK the ALFALFA wells of ArcGIS page 1. See docs/superpowers/specs/
2026-09-12-dw-tiered-oracles-design.md §2.
"""
from __future__ import annotations

import argparse
import codecs
import csv
import io
import json
import re
import sys
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

TX_COUNTY = "421"
NM_WELLS = 40
NM_MAX_RECORDS = 45_000  # keeps the UTF-16 seed under ~20 MB
OK_COUNTY = "ALFALFA"
TX_OPERATOR_SAMPLE = 300
CHUNK = 32 * 1024 * 1024


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# generic helpers
# ---------------------------------------------------------------------------

def filter_dsv(src: Path, dst: Path, keep) -> int:
    """Copy a `}`-delimited latin-1 DSV keeping the header and rows where keep(row) is true."""
    n = 0
    with open(src, "r", encoding="latin-1", newline="") as fi, open(dst, "w", encoding="latin-1", newline="") as fo:
        r = csv.reader(fi, delimiter="}")
        w = csv.writer(fo, delimiter="}", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar=None)
        hdr = next(r)
        w.writerow(hdr)
        for row in r:
            if keep(hdr, row):
                w.writerow(row)
                n += 1
    return n


def arcgis_page(src_page: dict, features: list) -> dict:
    """An ArcGIS query response with the same envelope as the real one and a chosen feature list."""
    page = {k: v for k, v in src_page.items() if k != "features"}
    page["features"] = features
    page["exceededTransferLimit"] = False
    return page


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def scan_utf16_records(fh, tag: str):
    """Yield (record_text) for every <tag xmlns=...>...</tag> in a UTF-16 LE stream, chunked.

    Also yields the preamble (everything before the first record) first, as ("preamble", text).
    """
    dec = codecs.getincrementaldecoder("utf-16-le")()
    open_re = re.compile(rf"<{tag} xmlns=")
    close = f"</{tag}>"
    buf = ""
    preamble_done = False
    bom = fh.read(2)
    assert bom == b"\xff\xfe", f"expected UTF-16 LE BOM, got {bom!r}"
    while True:
        raw = fh.read(CHUNK)
        if not raw:
            buf += dec.decode(b"", final=True)
            break
        buf += dec.decode(raw)
        if not preamble_done:
            m = open_re.search(buf)
            if not m:
                continue
            yield ("preamble", buf[: m.start()])
            buf = buf[m.start():]
            preamble_done = True
        last = 0
        while True:
            end = buf.find(close, last)
            if end < 0:
                break
            end += len(close)
            start = buf.find(f"<{tag} xmlns=", last, end)
            if start < 0:
                break
            yield ("record", buf[start:end])
            last = end
        buf = buf[last:]
    if buf.strip() and not preamble_done:
        yield ("preamble", buf)


def write_utf16_xml(path: Path, preamble: str, records: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fo:
        fo.write(b"\xff\xfe")
        fo.write(preamble.encode("utf-16-le"))
        for rec in records:
            fo.write(rec.encode("utf-16-le"))
        fo.write("</root>".encode("utf-16-le"))


def zip_single(zip_path: Path, member_name: str, member_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(member_path, member_name)


NM_KEY = re.compile(r"<api_st_cde>(\d+)</api_st_cde><api_cnty_cde>(\d+)</api_cnty_cde><api_well_idn>(\d+)</api_well_idn>")
NM_POOL = re.compile(r"<pool_idn>(\d+)</pool_idn>")
NM_OGRID = re.compile(r"<ogrid_cde>(\d+)</ogrid_cde>")


def nm_api(rec: str):
    m = NM_KEY.search(rec)
    return (int(m.group(2)), int(m.group(3))) if m else None


# ---------------------------------------------------------------------------
# TX
# ---------------------------------------------------------------------------

def carve_tx(src: Path, out: Path, stats: dict) -> None:
    pull = sorted(d for d in (src / "data/bronze/tx").iterdir() if d.is_dir())[-1]
    log(f"TX from {pull.name}")
    tmp = out / "tx" / "_dsv"
    tmp.mkdir(parents=True, exist_ok=True)
    counts = {}
    counts["OG_WELL_COMPLETION"] = filter_dsv(pull / "OG_WELL_COMPLETION.dsv", tmp / "OG_WELL_COMPLETION.dsv", lambda h, r: r[h.index("API_COUNTY_CODE")] == TX_COUNTY)
    counts["OG_COUNTY_CYCLE"] = filter_dsv(pull / "OG_COUNTY_CYCLE.dsv", tmp / "OG_COUNTY_CYCLE.dsv", lambda h, r: r[h.index("COUNTY_NO")] == TX_COUNTY)
    seen = [0]

    def first_n(h, r):
        seen[0] += 1
        return seen[0] <= TX_OPERATOR_SAMPLE

    counts["OG_OPERATOR_DW"] = filter_dsv(pull / "OG_OPERATOR_DW.dsv", tmp / "OG_OPERATOR_DW.dsv", first_n)
    lease = pull / "OG_LEASE_CYCLE.dsv"
    if lease.exists():
        counts["OG_LEASE_CYCLE"] = filter_dsv(lease, tmp / "OG_LEASE_CYCLE.dsv", lambda h, r: r[h.index("DISTRICT_NO")] == "14" and r[h.index("LEASE_NO")] in stats.get("tx_leases", set()))
    else:
        log("TX: OG_LEASE_CYCLE.dsv is absent in the pull (never extracted) — seed carries no TX production")
        counts["OG_LEASE_CYCLE"] = None
    zip_path = out / "tx" / "mft" / "PDQ_DSV.zip"
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(tmp.glob("*.dsv")):
            zf.write(f, f.name)
    for f in tmp.glob("*"):
        f.unlink()
    tmp.rmdir()
    # ArcGIS: the county's records from page 1, truncated APIs included as received.
    page = json.loads((pull / "wells/wells_batch_0001.json").read_text(encoding="utf-8"))
    feats = [ft for ft in page["features"] if str(ft["attributes"].get("API", "")).startswith(TX_COUNTY)]
    write_json(out / "tx" / "arcgis" / "page_0001.json", arcgis_page(page, feats))
    counts["arcgis_features"] = len(feats)
    counts["arcgis_truncated_api"] = sum(1 for ft in feats if len(str(ft["attributes"].get("API", ""))) < 8)
    stats["tx"] = counts
    log(f"TX done: {counts}")


# ---------------------------------------------------------------------------
# NM
# ---------------------------------------------------------------------------

def carve_nm(src: Path, out: Path, stats: dict) -> None:
    pull = sorted(d for d in (src / "data/bronze/nm").iterdir() if d.is_dir())[-1]
    log(f"NM from {pull.name}")
    page = json.loads((pull / "wells/wells_batch_0001.json").read_text(encoding="utf-8"))
    by_api = {}
    for ft in page["features"]:
        a = ft["attributes"].get("id") or ""
        m = re.fullmatch(r"30-(\d{3})-(\d{5})", a)
        if m:
            by_api[(int(m.group(1)), int(m.group(2)))] = ft
    log(f"NM ArcGIS page 1: {len(page['features'])} features, {len(by_api)} well-formed APIs")

    # Candidates: wells of page 1 that appear early in wcproduction (one cheap read).
    zpath = pull / "production/wcproduction.zip"
    zf = zipfile.ZipFile(zpath)
    member = zf.namelist()[0]
    cand = Counter()
    with zf.open(member) as fh:
        head = fh.read(64 * 1024 * 1024)
    for m in NM_KEY.finditer(head.decode("utf-16-le", errors="ignore")):
        k = (int(m.group(2)), int(m.group(3)))
        if k in by_api:
            cand[k] += 1
    by_county = defaultdict(list)
    for k in sorted(cand):
        by_county[k[0]].append(k)
    chosen = []
    while len(chosen) < NM_WELLS and any(by_county.values()):
        for c in sorted(by_county):
            if by_county[c] and len(chosen) < NM_WELLS:
                chosen.append(by_county[c].pop(0))
    chosen_set = set(chosen)
    log(f"NM chose {len(chosen)} wells across counties {sorted(set(k[0] for k in chosen))}")

    # One full pass over the 47 GB member: keep every record of the chosen wells.
    t0 = time.time()
    preamble = None
    recs = []
    per_well = Counter()
    n = 0
    with zf.open(member) as fh:
        for kind, text in scan_utf16_records(fh, "wcproduction"):
            if kind == "preamble":
                preamble = text
                continue
            n += 1
            if n % 5_000_000 == 0:
                log(f"  wcproduction: {n:,} records scanned, {len(recs):,} kept ({time.time() - t0:.0f}s)")
            k = nm_api(text)
            if k in chosen_set:
                recs.append(text)
                per_well[k] += 1
    log(f"NM wcproduction: scanned {n:,} records in {time.time() - t0:.0f}s; kept {len(recs):,} for {len(per_well)} wells")
    # Size control: drop the heaviest wells until under the record budget.
    while len(recs) > NM_MAX_RECORDS and len(per_well) > 10:
        heavy = per_well.most_common(1)[0][0]
        chosen_set.discard(heavy)
        recs = [r for r in recs if nm_api(r) != heavy]
        del per_well[heavy]
        log(f"  dropped heavy well {heavy}; {len(recs):,} records remain")
    pools = set(int(m.group(1)) for r in recs for m in [NM_POOL.search(r)] if m)
    ogrids = set(int(m.group(1)) for r in recs for m in [NM_OGRID.search(r)] if m)
    tmp = out / "nm" / "_xml"
    tmp.mkdir(parents=True, exist_ok=True)
    write_utf16_xml(tmp / "wcproduction.xml", preamble, recs)

    def carve_ref(name: str, keep):
        kept = []
        pre = None
        with open(pull / "production" / name / f"{name}.xml", "rb") as fh:
            for kind, text in scan_utf16_records(fh, name):
                if kind == "preamble":
                    pre = text
                elif keep(text):
                    kept.append(text)
        write_utf16_xml(tmp / f"{name}.xml", pre, kept)
        return len(kept)

    counts = {"wcproduction": len(recs), "wells_chosen": len(chosen_set)}
    counts["wchistory"] = carve_ref("wchistory", lambda t: nm_api(t) in chosen_set)
    for r in []:
        pass
    # ogrid/pool referenced by production or history rows
    hist_ogrids = set()
    hist_pools = set()
    with open(tmp / "wchistory.xml", "rb") as fh:
        for kind, text in scan_utf16_records(fh, "wchistory"):
            if kind == "record":
                m = NM_OGRID.search(text)
                if m:
                    hist_ogrids.add(int(m.group(1)))
                m = NM_POOL.search(text)
                if m:
                    hist_pools.add(int(m.group(1)))
    ogrids |= hist_ogrids
    pools |= hist_pools
    counts["ogrid"] = carve_ref("ogrid", lambda t: (lambda m: m and int(m.group(1)) in ogrids)(NM_OGRID.search(t)))
    counts["pool"] = carve_ref("pool", lambda t: (lambda m: m and int(m.group(1)) in pools)(NM_POOL.search(t)))
    for name, sub in [("wcproduction", "volumes/wcproduction"), ("wchistory", "core/wchistory"), ("ogrid", "core/ogrid"), ("pool", "core/pool")]:
        zip_single(out / "nm" / "ftp" / sub / f"{name}.zip", f"{name}.xml", tmp / f"{name}.xml")
    for f in tmp.glob("*"):
        f.unlink()
    tmp.rmdir()
    feats = [by_api[k] for k in sorted(chosen_set)]
    write_json(out / "nm" / "arcgis" / "page_0001.json", arcgis_page(page, feats))
    counts["arcgis_features"] = len(feats)
    counts["per_well_records"] = {f"30-{c:03d}-{w:05d}": per_well[(c, w)] for (c, w) in sorted(chosen_set)}
    stats["nm"] = counts
    log(f"NM done: { {k: v for k, v in counts.items() if k != 'per_well_records'} }")


# ---------------------------------------------------------------------------
# OK
# ---------------------------------------------------------------------------

def filter_xlsx(src: Path, dst: Path, keep) -> int:
    wb = openpyxl.load_workbook(src, read_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    hdr = next(rows)
    out = openpyxl.Workbook(write_only=True)
    wo = out.create_sheet(title=ws.title)
    wo.append(list(hdr))
    n = 0
    for r in rows:
        if keep(hdr, r):
            wo.append(list(r))
            n += 1
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst)
    return n


def carve_ok(src: Path, out: Path, stats: dict) -> None:
    pull = sorted(d for d in (src / "data/bronze/ok").iterdir() if d.is_dir())[-1]
    log(f"OK from {pull.name}")
    page = json.loads((pull / "wells/wells_batch_0001.json").read_text(encoding="utf-8"))
    feats = [ft for ft in page["features"] if ft["attributes"].get("county") == OK_COUNTY]
    apis = set(int(ft["attributes"]["api"]) for ft in feats if ft["attributes"].get("api") is not None)
    write_json(out / "ok" / "arcgis" / "page_0001.json", arcgis_page(page, feats))
    counts = {"arcgis_features": len(feats), "apis": len(apis)}
    # RBDMS CSV: keep header + rows whose API is in the set (10-digit string)
    dst = out / "ok" / "web" / "rbdms-wells.csv"
    dst.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(pull / "data/rbdms_well_data.csv", "r", encoding="utf-8", errors="strict", newline="") as fi, open(dst, "w", encoding="utf-8", newline="") as fo:
        r = csv.reader(fi)
        w = csv.writer(fo, lineterminator="\n")
        hdr = next(r)
        w.writerow(hdr)
        for row in r:
            try:
                if int(row[0]) in apis:
                    w.writerow(row)
                    n += 1
            except ValueError:
                continue
    counts["rbdms_csv"] = n
    t0 = time.time()
    counts["completions"] = filter_xlsx(pull / "data/completions_wells_formations.xlsx", out / "ok" / "web" / "completions-wells-formations-base.xlsx", lambda h, r: isinstance(r[0], (int, float)) and int(r[0]) in apis)
    log(f"  completions filtered in {time.time() - t0:.0f}s: {counts['completions']} rows")
    t0 = time.time()
    counts["itd"] = filter_xlsx(pull / "data/itd_wells_formations.xlsx", out / "ok" / "web" / "ITD-wells-formations-base.xlsx", lambda h, r: isinstance(r[0], (int, float)) and int(r[0]) // 10000 in apis)
    log(f"  ITD filtered in {time.time() - t0:.0f}s: {counts['itd']} rows")
    stats["ok"] = counts
    log(f"OK done: {counts}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--only", nargs="*", default=["tx", "ok", "nm"])
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    stats = {"src_repo": str(a.src), "carved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    for s in a.only:
        {"tx": carve_tx, "nm": carve_nm, "ok": carve_ok}[s](a.src, a.out, stats)
    (a.out / "CARVE.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")
    total = sum(f.stat().st_size for f in a.out.rglob("*") if f.is_file())
    log(f"seed written to {a.out}: {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
