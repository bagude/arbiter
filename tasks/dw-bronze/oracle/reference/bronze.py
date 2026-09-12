#!/usr/bin/env python
"""Reference bronze ingester for docs/dw/contract-bronze.md (the oracle's own solution).

Materialises data/bronze/<state>/<pull_date>/ from a local `remote/` tree that stands
in for the agencies, byte for byte, and writes a truthful manifest. Standard library
plus openpyxl only; no network. ~140 lines.

    python bronze.py --remote remote --out data/bronze --pull-date 2026-02-11 [--states tx nm ok]
"""
from __future__ import annotations

import argparse
import codecs
import csv
import hashlib
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

SOURCES = {
    "tx": {"mft_pdq": "https://mft.rrc.texas.gov/link/1f5ddb8d-329a-4459-b7f8-177b4f5ee60d", "arcgis": "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/1/query"},
    "nm": {"ocd_ftp": "ftp://164.64.106.6/Public/OCD/OCD Interface v1.1", "arcgis": "https://gis.emnrd.nm.gov/arcgis/rest/services/OCDView/Wells_Public/FeatureServer/0/query"},
    "ok": {"occ_web": "https://oklahoma.gov/content/dam/ok/en/occ/documents/og/ogdatafiles", "arcgis": "https://gis.occ.ok.gov/server/rest/services/Hosted/RBDMS_WELLS/FeatureServer/220/query"},
}
OK_NAMES = {"rbdms-wells.csv": "rbdms_well_data.csv", "completions-wells-formations-base.xlsx": "completions_wells_formations.xlsx", "ITD-wells-formations-base.xlsx": "itd_wells_formations.xlsx"}
XML_REC = re.compile(r'<\w+ xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">')


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def records(p: Path):
    suf = p.suffix.lower()
    if suf == ".dsv":
        with open(p, "rb") as f:
            return max(sum(1 for _ in f) - 1, 0)
    if suf == ".csv":
        with open(p, encoding="utf-8", errors="replace", newline="") as f:
            r = csv.reader(f)
            next(r, None)
            return sum(1 for _ in r)
    if suf == ".json":
        return len(json.loads(p.read_text(encoding="utf-8")).get("features", []))
    if suf == ".xlsx":
        import openpyxl
        rows = openpyxl.load_workbook(p, read_only=True).worksheets[0].iter_rows(values_only=True)
        next(rows, None)
        return sum(1 for _ in rows)
    if suf == ".xml":
        with open(p, "rb") as f:
            bom = f.read(2)
            enc = {b"\xff\xfe": "utf-16-le", b"\xfe\xff": "utf-16-be"}.get(bom, "utf-8")
            if enc == "utf-8":
                f.seek(0)
            dec = codecs.getincrementaldecoder(enc)()
            n, tail = 0, ""
            for chunk in iter(lambda: f.read(8 << 20), b""):
                text = tail + dec.decode(chunk)
                n += len(XML_REC.findall(text)) - len(XML_REC.findall(text[-80:]))
                tail = text[-80:]
            return n + len(XML_REC.findall(tail))
    return None


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def extract_member(z: Path, member: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(z) as zf, zf.open(member) as src, open(dst, "wb") as out:
        shutil.copyfileobj(src, out, 1 << 20)


def pages(remote: Path, pull: Path, files: list) -> None:
    for p in sorted((remote / "arcgis").glob("page_*.json")):
        rel = f"wells/wells_batch_{p.stem.split('_')[1]}.json"
        copy_file(p, pull / rel)
        files.append({"path": rel, "source": "arcgis"})


def ingest(state: str, remote: Path, pull: Path) -> list:
    files: list = []
    if state == "tx":
        z = remote / "mft" / "PDQ_DSV.zip"
        with zipfile.ZipFile(z) as zf:
            for m in zf.namelist():
                rel = Path(m).name
                extract_member(z, m, pull / rel)
                files.append({"path": rel, "source": "mft_pdq", "from": z.name})
    elif state == "nm":
        for z in sorted((remote / "ftp").rglob("*.zip")):
            copy_file(z, pull / "production" / z.name)
            files.append({"path": f"production/{z.name}", "source": "ocd_ftp"})
            with zipfile.ZipFile(z) as zf:
                for m in zf.namelist():
                    rel = f"production/{z.stem}/{Path(m).name}"
                    extract_member(z, m, pull / rel)
                    files.append({"path": rel, "source": "ocd_ftp", "from": z.name})
    elif state == "ok":
        for src_name, dst_name in OK_NAMES.items():
            p = remote / "web" / src_name
            if p.exists():
                copy_file(p, pull / "data" / dst_name)
                files.append({"path": f"data/{dst_name}", "source": "occ_web"})
    pages(remote, pull, files)
    return files


def manifest(state: str, pull: Path, files: list) -> dict:
    entries = []
    for f in sorted(files, key=lambda e: e["path"]):
        p = pull / f["path"]
        e = {"path": f["path"], "bytes": p.stat().st_size, "sha256": sha256(p)}
        if p.suffix.lower() == ".zip":
            with zipfile.ZipFile(p) as zf:
                e["members"] = [{"name": i.filename, "bytes": i.file_size} for i in zf.infolist()]
        else:
            e["records"] = records(p)
        e["source"] = f["source"]
        if "from" in f:
            e["from"] = f["from"]
        entries.append(e)
    return {
        "state": state,
        "pull_date": pull.name,
        "pulled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": [{"name": n, "url": u} for n, u in SOURCES[state].items()],
        "files": entries,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--remote", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--pull-date", required=True)
    ap.add_argument("--states", nargs="*", default=["tx", "nm", "ok"])
    a = ap.parse_args()
    for state in a.states:
        remote = a.remote / state
        if not remote.exists():
            continue
        pull = a.out / state / a.pull_date
        if pull.exists():
            shutil.rmtree(pull)
        pull.mkdir(parents=True)
        files = ingest(state, remote, pull)
        (pull / "manifest.json").write_text(json.dumps(manifest(state, pull, files), indent=2) + "\n", encoding="utf-8")
        print(f"{state}: {len(files)} files -> {pull}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
