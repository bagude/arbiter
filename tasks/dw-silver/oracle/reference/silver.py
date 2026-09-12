#!/usr/bin/env python
"""Reference silver reader for docs/dw/contract-silver.md — the oracle's own solution.

Deliberately minimal and independent: csv module, regex over the UTF-16 XML,
json, openpyxl, pyarrow for writing. No pandas, no reuse of the pipeline being
replaced. Read it top to bottom against the contract; that is its verification.

    python silver.py --bronze data/bronze --out data/silver [--states tx nm ok]
"""
from __future__ import annotations

import argparse
import codecs
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

# The contract module lives in the workspace (contract/silver_schema.py); DW_CONTRACT
# overrides for the oracle, which runs this file from outside any workspace.
sys.path.insert(0, os.environ.get("DW_CONTRACT") or str(Path.cwd() / "contract"))
from silver_schema import (  # noqa: E402
    BASIN, COMPLETIONS_SCHEMA, KEYS, NM_FIPS_COUNTY, NM_KINDS, NM_WELL_TYPE, PRODUCTION_SCHEMA, SCHEMAS, TX_WELL_TYPE,
    WELLS_SCHEMA, nm_status, norm_text, ok_status, ok_type,
)

NOW = datetime.now(timezone.utc)
XML_REC = re.compile(r'<(\w+) xmlns="urn:schemas-microsoft-com:sql:SqlRowSet1">(.*?)</\1>', re.S)
XML_FIELD = re.compile(r"<(\w+)>(.*?)</\1>", re.S)


# ---------------------------------------------------------------------------
# raw readers
# ---------------------------------------------------------------------------

def pull_dir(bronze: Path, state: str) -> Path:
    dirs = sorted(d for d in (bronze / state).iterdir() if d.is_dir())
    if len(dirs) != 1:
        raise SystemExit(f"{state}: expected one pull directory, found {[d.name for d in dirs]}")
    return dirs[0]


def pages(pull: Path):
    """[(relative page path, features)] in page order."""
    out = []
    for p in sorted((pull / "wells").glob("wells_batch_*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        out.append((f"wells/{p.name}", d.get("features", [])))
    return out


def dsv_rows(path: Path):
    with open(path, encoding="latin-1", newline="") as f:
        yield from csv.DictReader(f, delimiter="}")


def xml_records(path: Path):
    """Yield {field: text} for every SQL-Server FOR XML record (UTF-16 with BOM)."""
    with open(path, "rb") as f:
        bom = f.read(2)
        enc = {b"\xff\xfe": "utf-16-le", b"\xfe\xff": "utf-16-be"}.get(bom, "utf-8")
        if enc == "utf-8":
            f.seek(0)
        text = codecs.getincrementaldecoder(enc)().decode(f.read(), final=True)
    for m in XML_REC.finditer(text):
        yield {k: v for k, v in XML_FIELD.findall(m.group(2))}


def fnum(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fdate(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        d = v.date()
    elif isinstance(v, date):
        d = v
    else:
        try:
            d = datetime.strptime(str(v).strip()[:10], "%Y-%m-%d").date()
        except ValueError:
            return None
    return None if d == date(1900, 1, 1) else d


# ---------------------------------------------------------------------------
# wells
# ---------------------------------------------------------------------------

def tx_completions(pull: Path):
    """(county_code, unique_no) -> rows of OG_WELL_COMPLETION; also (district, lease) -> rows."""
    by_api = defaultdict(list)
    by_lease = defaultdict(list)
    p = pull / "OG_WELL_COMPLETION.dsv"
    if p.exists():
        for r in dsv_rows(p):
            by_api[(r["API_COUNTY_CODE"].strip(), r["API_UNIQUE_NO"].strip())].append(r)
            by_lease[(r["DISTRICT_NO"].strip(), r["LEASE_NO"].strip())].append(r)
    return by_api, by_lease


def tx_type(rows):
    codes = {r["OIL_GAS_CODE"].strip() for r in rows}
    if not codes:
        return None
    if len(codes) == 1 and next(iter(codes)) in TX_WELL_TYPE:
        return TX_WELL_TYPE[next(iter(codes))]
    return "OTHER"


def wells_tx(pull: Path, drops: Counter):
    by_api, _ = tx_completions(pull)
    rows = []
    for rel, feats in pages(pull):
        for ft in feats:
            a = ft.get("attributes", {})
            digits = re.sub(r"\D", "", str(a.get("API", "")))
            if len(digits) == 8:
                cc, un = digits[:3], digits[3:]
            elif len(digits) == 10 and digits.startswith("42"):
                cc, un = digits[2:5], digits[5:]
            else:
                drops["wells.truncated_api"] += 1
                continue
            comp = by_api.get((cc, un), [])
            rows.append({
                "state": "TX", "api_number": f"42-{cc}-{un}", "well_name": None, "operator": None,
                "county": norm_text(comp[0]["COUNTY_NAME"]) if comp else None,
                "well_type": tx_type(comp), "well_status": None,
                "latitude": fnum(a.get("GIS_LAT83")), "longitude": fnum(a.get("GIS_LONG83")),
                "source_file": rel, "ingested_at": NOW,
            })
    return rows


def wells_nm(pull: Path, drops: Counter):
    rows = []
    for rel, feats in pages(pull):
        for ft in feats:
            a = ft.get("attributes", {})
            api = str(a.get("id") or "")
            if not re.fullmatch(r"30-\d{3}-\d{5}", api):
                drops["wells.malformed_api"] += 1
                continue
            t = a.get("type")
            rows.append({
                "state": "NM", "api_number": api, "well_name": norm_text(a.get("name")), "operator": norm_text(a.get("ogrid_name")),
                "county": norm_text(a.get("county")),
                "well_type": None if t is None else NM_WELL_TYPE.get(str(t).strip(), "OTHER"),
                "well_status": nm_status(a.get("status")),
                "latitude": fnum(a.get("latitude")), "longitude": fnum(a.get("longitude")),
                "source_file": rel, "ingested_at": NOW,
            })
    return rows


def wells_ok(pull: Path, drops: Counter):
    rows = []
    for rel, feats in pages(pull):
        for ft in feats:
            a = ft.get("attributes", {})
            raw = a.get("api")
            digits = str(int(raw)) if isinstance(raw, (int, float)) else re.sub(r"\D", "", str(raw or ""))
            if len(digits) != 10 or not digits.startswith("35"):
                drops["wells.malformed_api"] += 1
                continue
            rows.append({
                "state": "OK", "api_number": f"35-{digits[2:5]}-{digits[5:]}", "well_name": norm_text(a.get("well_name")),
                "operator": norm_text(a.get("operator")), "county": norm_text(a.get("county")),
                "well_type": ok_type(a.get("welltype")), "well_status": ok_status(a.get("wellstatus")),
                "latitude": fnum(a.get("sh_lat")), "longitude": fnum(a.get("sh_lon")),
                "source_file": rel, "ingested_at": NOW,
            })
    return rows


def dedup_wells(rows, drops: Counter):
    seen = set()
    out = []
    for r in rows:
        if r["api_number"] in seen:
            drops["wells.duplicate_api"] += 1
            continue
        seen.add(r["api_number"])
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# production
# ---------------------------------------------------------------------------

def production_nm(pull: Path, wells, drops: Counter):
    pools = {int(r["pool_idn"]): norm_text(r.get("pool_nam")) for r in xml_records(pull / "production/pool/pool.xml")}
    ogrids = {int(r["ogrid_cde"]): norm_text(r.get("ogrid_nam")) for r in xml_records(pull / "production/ogrid/ogrid.xml")}
    by_api = {w["api_number"]: w for w in wells}
    # amendments: keep the greatest mod_dte per (api, pool, yr, mth, kind)
    latest = {}
    for i, r in enumerate(xml_records(pull / "production/wcproduction/wcproduction.xml")):
        try:
            yr, mth = int(r["prodn_yr"]), int(r["prodn_mth"])
        except (KeyError, ValueError):
            drops["production.invalid_month"] += 1
            continue
        if not (1 <= mth <= 12 and 1900 <= yr <= 2100):
            drops["production.invalid_month"] += 1
            continue
        kind = r.get("prd_knd_cde", "").strip()
        if kind not in NM_KINDS:
            drops["production.unknown_kind"] += 1
            continue
        api = f"30-{int(r['api_cnty_cde']):03d}-{int(r['api_well_idn']):05d}"
        key = (api, int(r["pool_idn"]), yr, mth, kind)
        stamp = (r.get("mod_dte", ""), i)
        prev = latest.get(key)
        if prev is None or stamp > prev[0]:
            if prev is not None:
                drops["production.amended_duplicates"] += 1
            latest[key] = (stamp, r, int(r["api_cnty_cde"]))
        else:
            drops["production.amended_duplicates"] += 1
    months = defaultdict(list)  # (api, yr, mth) -> [(pool, kind, rec, cnty)]
    for (api, pool, yr, mth, kind), (_, r, cnty) in latest.items():
        months[(api, yr, mth)].append((pool, kind, r, cnty))
    rows = []
    for (api, yr, mth), recs in sorted(months.items()):
        vols = {c: None for c in NM_KINDS.values()}
        per_pool = Counter()
        ogrid_votes = Counter()
        days = []
        for pool, kind, r, cnty in recs:
            amt = int(r["prod_amt"])
            col = NM_KINDS[kind]
            vols[col] = (vols[col] or 0) + amt
            if kind in ("O", "G", "C"):
                per_pool[pool] += amt
            else:
                per_pool[pool] += 0
            ogrid_votes[int(r["ogrid_cde"])] += 1
            d = int(r.get("prodn_day_num", "0") or 0)
            if 0 <= d <= 31:
                days.append(d)
            else:
                drops["production.days_out_of_range"] += 1
        dominant = min(per_pool, key=lambda p: (-per_pool[p], p))
        operator_code = min(ogrid_votes, key=lambda c: (-ogrid_votes[c], c))
        w = by_api.get(api)
        county = w["county"] if w else NM_FIPS_COUNTY.get(recs[0][3])
        rows.append({
            "state": "NM", "entity_type": "well", "api_number": api, "lease_number": None, "district": None,
            "well_name": w["well_name"] if w else None, "operator": ogrids.get(operator_code),
            "county": county, "field_name": pools.get(dominant), "basin": BASIN.get(("NM", county)) if county else None,
            "well_type": w["well_type"] if w else None, "well_status": w["well_status"] if w else None,
            "latitude": w["latitude"] if w else None, "longitude": w["longitude"] if w else None,
            "production_date": date(yr, mth, 1),
            "oil_bbl": None if vols["oil_bbl"] is None else float(vols["oil_bbl"]),
            "gas_mcf": None if vols["gas_mcf"] is None else float(vols["gas_mcf"]),
            "condensate_bbl": None if vols["condensate_bbl"] is None else float(vols["condensate_bbl"]),
            "casinghead_gas_mcf": None,
            "water_bbl": None if vols["water_bbl"] is None else float(vols["water_bbl"]),
            "days_produced": max(days) if days else None,
            "source_file": "production/wcproduction/wcproduction.xml", "ingested_at": NOW,
        })
    return rows


def production_tx(pull: Path, wells, drops: Counter):
    p = pull / "OG_LEASE_CYCLE.dsv"
    if not p.exists():
        return []
    _, by_lease = tx_completions(pull)
    by_api = {w["api_number"]: w for w in wells}
    operators = {}
    op = pull / "OG_OPERATOR_DW.dsv"
    if op.exists():
        for r in dsv_rows(op):
            operators[r["OPERATOR_NO"].strip()] = norm_text(r["OPERATOR_NAME"])
    last = {}
    for r in dsv_rows(p):
        try:
            yr, mth = int(r["CYCLE_YEAR"]), int(r["CYCLE_MONTH"])
        except ValueError:
            drops["production.invalid_month"] += 1
            continue
        if not (1 <= mth <= 12 and 1900 <= yr <= 2100):
            drops["production.invalid_month"] += 1
            continue
        key = (r["DISTRICT_NO"].strip(), r["LEASE_NO"].strip(), yr, mth)
        if key in last:
            drops["production.amended_duplicates"] += 1
        last[key] = r
    rows = []
    for (district, lease, yr, mth), r in sorted(last.items()):
        comp = by_lease.get((district, lease), [])
        apis = sorted({f"42-{c['API_COUNTY_CODE'].strip()}-{c['API_UNIQUE_NO'].strip()}" for c in comp if c["API_COUNTY_CODE"].strip() and c["API_UNIQUE_NO"].strip()})
        single = len(apis) == 1
        w = by_api.get(apis[0]) if single else None
        if single:
            county = w["county"] if w else (norm_text(comp[0]["COUNTY_NAME"]) if comp else None)
        else:
            names = Counter(norm_text(c["COUNTY_NAME"]) for c in comp if norm_text(c["COUNTY_NAME"]))
            county = min(names, key=lambda n: (-names[n], n)) if names else None
        rows.append({
            "state": "TX", "entity_type": "well" if single else "lease", "api_number": apis[0] if single else None,
            "lease_number": lease, "district": district,
            "well_name": norm_text(r.get("LEASE_NAME")), "operator": norm_text(r.get("OPERATOR_NAME")) or operators.get(r.get("OPERATOR_NO", "").strip()),
            "county": county, "field_name": norm_text(r.get("FIELD_NAME")), "basin": BASIN.get(("TX", county)) if county else None,
            "well_type": (w["well_type"] if w else tx_type(comp)) if single else tx_type(comp), "well_status": None,
            "latitude": w["latitude"] if w else None, "longitude": w["longitude"] if w else None,
            "production_date": date(yr, mth, 1),
            "oil_bbl": fnum(r.get("LEASE_OIL_PROD_VOL")), "gas_mcf": fnum(r.get("LEASE_GAS_PROD_VOL")),
            "condensate_bbl": fnum(r.get("LEASE_COND_PROD_VOL")), "casinghead_gas_mcf": fnum(r.get("LEASE_CSGD_PROD_VOL")),
            "water_bbl": None, "days_produced": None,
            "source_file": "OG_LEASE_CYCLE.dsv", "ingested_at": NOW,
        })
    return rows


# ---------------------------------------------------------------------------
# completions (OK)
# ---------------------------------------------------------------------------

def completions_ok(pull: Path, drops: Counter):
    import openpyxl
    ws = openpyxl.load_workbook(pull / "data/completions_wells_formations.xlsx", read_only=True).worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = [str(h) for h in next(it)]
    rows = []
    for i, values in enumerate(it, 1):
        r = dict(zip(hdr, values))
        raw = r.get("API_Number")
        digits = str(int(raw)) if isinstance(raw, (int, float)) else re.sub(r"\D", "", str(raw or ""))
        if len(digits) != 10 or not digits.startswith("35"):
            drops["completions.malformed_api"] += 1
            continue
        county = norm_text(r.get("County"))
        if county and "-" in county:
            county = norm_text(county.split("-", 1)[1])
        cn = r.get("Completion_No")
        rows.append({
            "state": "OK", "api_number": f"35-{digits[2:5]}-{digits[5:]}", "completion_no": int(cn) if isinstance(cn, (int, float)) else None,
            "row_no": i, "well_name": norm_text(r.get("Well_Name")), "well_number": norm_text(r.get("Well_Number")),
            "operator": norm_text(r.get("Operator_Name")), "county": county,
            "well_type": ok_type(r.get("Well_Type")), "well_status": ok_status(r.get("Well_Status")),
            "formation_name": norm_text(r.get("Formation_Name")), "formation_code": norm_text(r.get("Formation_Code")),
            "spud_date": fdate(r.get("Spud")), "completion_date": fdate(r.get("Well_Completion")),
            "first_prod_date": fdate(r.get("First_Prod")), "test_date": fdate(r.get("Test_Date")),
            "oil_bbl_per_day": fnum(r.get("Oil_BBL_Per_Day")), "gas_mcf_per_day": fnum(r.get("Gas_MCF_Per_Day")), "water_bbl_per_day": fnum(r.get("Water_BBL_Per_Day")),
            "latitude": fnum(r.get("Surf_Lat_Y")), "longitude": fnum(r.get("Surf_Long_X")),
            "otc_prod_unit_no": norm_text(r.get("OTC_Prod_Unit_No")),
            "source_file": "data/completions_wells_formations.xlsx", "ingested_at": NOW,
        })
    return rows


# ---------------------------------------------------------------------------
# write
# ---------------------------------------------------------------------------

def write(out: Path, table: str, state: str, rows):
    schema = SCHEMAS[table]
    d = out / table / f"state={state}"
    d.mkdir(parents=True, exist_ok=True)
    t = pa.Table.from_pylist(rows, schema=schema) if rows else schema.empty_table()
    pq.write_table(t, d / f"{state.lower()}_{table}.parquet")
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bronze", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--states", nargs="*", default=["tx", "nm", "ok"])
    a = ap.parse_args()
    manifest = {"rows": defaultdict(dict), "dropped": {}}
    for st in a.states:
        if not (a.bronze / st).exists():
            continue
        S = st.upper()
        pull = pull_dir(a.bronze, st)
        drops = Counter()
        wells = dedup_wells({"tx": wells_tx, "nm": wells_nm, "ok": wells_ok}[st](pull, drops), drops)
        manifest["rows"]["wells"][S] = write(a.out, "wells", S, wells)
        if st == "nm":
            manifest["rows"]["production"][S] = write(a.out, "production", S, production_nm(pull, wells, drops))
        if st == "tx":
            manifest["rows"]["production"][S] = write(a.out, "production", S, production_tx(pull, wells, drops))
        if st == "ok":
            manifest["rows"]["completions"][S] = write(a.out, "completions", S, completions_ok(pull, drops))
        manifest["dropped"][S] = dict(sorted(drops.items()))
        print(f"{st}: {manifest['rows']['wells'][S]} wells; drops {dict(drops)}")
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
