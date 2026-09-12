"""Silver contract as code: schemas and code tables (docs/dw/contract-silver.md).

This module is the contract. The oracle imports this exact file; a silver
implementation should import it too rather than restate it.
"""
from __future__ import annotations

import html

import pyarrow as pa

TS = pa.timestamp("us", tz="UTC")

WELLS_SCHEMA = pa.schema([
    pa.field("state", pa.string(), nullable=False),
    pa.field("api_number", pa.string(), nullable=False),
    pa.field("well_name", pa.string()),
    pa.field("operator", pa.string()),
    pa.field("county", pa.string()),
    pa.field("well_type", pa.string()),
    pa.field("well_status", pa.string()),
    pa.field("latitude", pa.float64()),
    pa.field("longitude", pa.float64()),
    pa.field("source_file", pa.string()),
    pa.field("ingested_at", TS),
])

PRODUCTION_SCHEMA = pa.schema([
    pa.field("state", pa.string(), nullable=False),
    pa.field("entity_type", pa.string(), nullable=False),
    pa.field("api_number", pa.string()),
    pa.field("lease_number", pa.string()),
    pa.field("district", pa.string()),
    pa.field("well_name", pa.string()),
    pa.field("operator", pa.string()),
    pa.field("county", pa.string()),
    pa.field("field_name", pa.string()),
    pa.field("basin", pa.string()),
    pa.field("well_type", pa.string()),
    pa.field("well_status", pa.string()),
    pa.field("latitude", pa.float64()),
    pa.field("longitude", pa.float64()),
    pa.field("production_date", pa.date32(), nullable=False),
    pa.field("oil_bbl", pa.float64()),
    pa.field("gas_mcf", pa.float64()),
    pa.field("condensate_bbl", pa.float64()),
    pa.field("casinghead_gas_mcf", pa.float64()),
    pa.field("water_bbl", pa.float64()),
    pa.field("days_produced", pa.int32()),
    pa.field("source_file", pa.string()),
    pa.field("ingested_at", TS),
])

COMPLETIONS_SCHEMA = pa.schema([
    pa.field("state", pa.string(), nullable=False),
    pa.field("api_number", pa.string(), nullable=False),
    pa.field("completion_no", pa.int32()),
    pa.field("row_no", pa.int32(), nullable=False),
    pa.field("well_name", pa.string()),
    pa.field("well_number", pa.string()),
    pa.field("operator", pa.string()),
    pa.field("county", pa.string()),
    pa.field("well_type", pa.string()),
    pa.field("well_status", pa.string()),
    pa.field("formation_name", pa.string()),
    pa.field("formation_code", pa.string()),
    pa.field("spud_date", pa.date32()),
    pa.field("completion_date", pa.date32()),
    pa.field("first_prod_date", pa.date32()),
    pa.field("test_date", pa.date32()),
    pa.field("oil_bbl_per_day", pa.float64()),
    pa.field("gas_mcf_per_day", pa.float64()),
    pa.field("water_bbl_per_day", pa.float64()),
    pa.field("latitude", pa.float64()),
    pa.field("longitude", pa.float64()),
    pa.field("otc_prod_unit_no", pa.string()),
    pa.field("source_file", pa.string()),
    pa.field("ingested_at", TS),
])

SCHEMAS = {"wells": WELLS_SCHEMA, "production": PRODUCTION_SCHEMA, "completions": COMPLETIONS_SCHEMA}
TABLES_BY_STATE = {"TX": ["wells", "production"], "NM": ["wells", "production"], "OK": ["wells", "completions"]}
KEYS = {"wells": ["state", "api_number"], "production": ["state", "entity_type", "api_number", "lease_number", "district", "production_date"], "completions": ["state", "api_number", "completion_no", "row_no"]}

# ---- code tables (exhaustive for the seed; anything else -> OTHER) ----------

WELL_TYPES = ("OIL", "GAS", "INJ", "OTHER")
WELL_STATUSES = ("ACTIVE", "SHUT-IN", "P&A", "INACTIVE", "OTHER")

NM_WELL_TYPE = {"Oil": "OIL", "Gas": "GAS", "Injection": "INJ"}
# NM statuses are matched by prefix, in this order.
NM_WELL_STATUS_PREFIX = [("Active", "ACTIVE"), ("Plugged", "P&A"), ("Temporary Abandonment", "SHUT-IN")]

OK_WELL_TYPE = {"OIL": "OIL", "GAS": "GAS", "Gas": "GAS", "INJ": "INJ", "SWD": "INJ", "2RIn": "INJ"}
OK_WELL_STATUS = {"AC": "ACTIVE", "PA": "P&A", "PAFF": "P&A", "PASURSF": "P&A", "SIFORDER": "SHUT-IN", "TA": "SHUT-IN"}

TX_WELL_TYPE = {"O": "OIL", "G": "GAS"}  # OIL_GAS_CODE

NM_FIPS_COUNTY = {5: "CHAVES", 15: "EDDY", 25: "LEA", 31: "MCKINLEY", 39: "RIO ARRIBA", 41: "ROOSEVELT", 43: "SANDOVAL", 45: "SAN JUAN", 59: "UNION"}

# (state, county) -> basin; unmapped -> NULL
BASIN = {
    ("NM", "CHAVES"): "PERMIAN", ("NM", "EDDY"): "PERMIAN", ("NM", "LEA"): "PERMIAN", ("NM", "ROOSEVELT"): "PERMIAN",
    ("NM", "SAN JUAN"): "SAN JUAN", ("NM", "RIO ARRIBA"): "SAN JUAN", ("NM", "SANDOVAL"): "SAN JUAN", ("NM", "MCKINLEY"): "SAN JUAN",
    ("NM", "UNION"): "RATON",
    ("TX", "SHERMAN"): "ANADARKO",
    ("OK", "ALFALFA"): "ANADARKO",
}

NM_KINDS = {"O": "oil_bbl", "G": "gas_mcf", "W": "water_bbl", "C": "condensate_bbl"}

DROP_REASONS = (
    "wells.truncated_api", "wells.malformed_api", "wells.duplicate_api",
    "production.amended_duplicates", "production.invalid_month", "production.unknown_kind", "production.days_out_of_range",
    "completions.malformed_api",
)


def norm_text(v) -> str | None:
    """Decode XML/HTML entities (&amp; &#x20; …), strip, collapse internal whitespace, upper-case; empty -> None.

    The agencies' SQL-Server XML carries names like 'BC &amp; D OPERATING INC.'; the
    entity is source encoding, not data (found by the data explorer, run 2026-09-12T16-06-52).
    """
    if v is None:
        return None
    s = " ".join(html.unescape(str(v)).split())
    return s.upper() if s else None


def nm_status(raw) -> str | None:
    if raw is None:
        return None
    for prefix, out in NM_WELL_STATUS_PREFIX:
        if str(raw).startswith(prefix):
            return out
    return "OTHER"


def ok_type(raw) -> str | None:
    if raw is None:
        return None
    return OK_WELL_TYPE.get(str(raw).strip(), "OTHER")


def ok_status(raw) -> str | None:
    if raw is None:
        return None
    return OK_WELL_STATUS.get(str(raw).strip(), "OTHER")
