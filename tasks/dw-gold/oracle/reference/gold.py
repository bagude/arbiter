#!/usr/bin/env python
"""Reference gold builder for docs/dw/contract-gold.md — the oracle's own solution.

DuckDB SQL only; every definition is the contract's, written out once.

    python gold.py --silver data/silver --out data/gold/warehouse.duckdb [--county-cycle data/reference/OG_COUNTY_CYCLE.dsv]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb


def glob(silver: Path, table: str) -> str:
    return str(silver / table / "state=*" / "*.parquet").replace("\\", "/")


PRODUCTION_MONTHLY = """
create or replace table production_monthly as
with s as (
    select *,
        case when entity_type = 'well' then api_number
             when entity_type = 'lease' then 'TX-LEASE:' || district || '-' || lease_number end as entity_key,
        case when oil_bbl is null and condensate_bbl is null then null
             else coalesce(oil_bbl, 0) + coalesce(condensate_bbl, 0) end as total_oil_bbl,
        case when gas_mcf is null and casinghead_gas_mcf is null then null
             else coalesce(gas_mcf, 0) + coalesce(casinghead_gas_mcf, 0) end as total_gas_mcf
    from read_parquet('{prod}', hive_partitioning = false)
),
w as (
    select *,
        row_number() over (partition by entity_key, state order by production_date) as reported_month_index,
        (extract(year from production_date) * 12 + extract(month from production_date))
          - (extract(year from first_value(production_date) over (partition by entity_key, state order by production_date rows between unbounded preceding and unbounded following)) * 12
           + extract(month from first_value(production_date) over (partition by entity_key, state order by production_date rows between unbounded preceding and unbounded following)))
          + 1 as calendar_months_on_production,
        extract(year from min(case when total_oil_bbl > 0 or total_gas_mcf > 0 then production_date end)
                over (partition by entity_key, state))::int as vintage,
        max(total_oil_bbl) over (partition by entity_key, state) as _peak_oil,
        max(total_gas_mcf) over (partition by entity_key, state) as _peak_gas,
        sum(total_oil_bbl) over (partition by entity_key, state order by production_date rows between unbounded preceding and current row) as cumulative_oil_bbl,
        sum(total_gas_mcf) over (partition by entity_key, state order by production_date rows between unbounded preceding and current row) as cumulative_gas_mcf,
        sum(water_bbl) over (partition by entity_key, state order by production_date rows between unbounded preceding and current row) as cumulative_water_bbl
    from s
)
select
    entity_key, state, entity_type, api_number, lease_number, district,
    well_name, operator, county, field_name, basin, well_type, well_status,
    latitude, longitude,
    production_date,
    extract(year from production_date)::int as production_year,
    extract(month from production_date)::int as production_month,
    reported_month_index::int as reported_month_index,
    calendar_months_on_production::int as calendar_months_on_production,
    vintage,
    case when _peak_oil > 0 then round(_peak_gas / _peak_oil * 1000, 1) end as initial_gor,
    total_oil_bbl, total_gas_mcf,
    oil_bbl, condensate_bbl, gas_mcf, casinghead_gas_mcf, water_bbl, days_produced,
    cumulative_oil_bbl, cumulative_gas_mcf, cumulative_water_bbl,
    source_file, ingested_at
from w
"""

DECLINE_CURVE_INPUTS = """
create or replace table decline_curve_inputs as
with p as (
    select * from production_monthly
    where entity_type = 'well' and api_number is not null and (total_oil_bbl > 0 or total_gas_mcf > 0)
),
d as (
    select *,
        row_number() over (partition by api_number, state order by production_date) as months_on_production,
        first_value(total_oil_bbl) over (partition by api_number, state order by production_date rows between unbounded preceding and unbounded following) as initial_oil_rate,
        first_value(total_gas_mcf) over (partition by api_number, state order by production_date rows between unbounded preceding and unbounded following) as initial_gas_rate,
        sum(total_oil_bbl) over (partition by api_number, state order by production_date rows between unbounded preceding and current row) as cumulative_oil,
        sum(total_gas_mcf) over (partition by api_number, state order by production_date rows between unbounded preceding and current row) as cumulative_gas,
        sum(water_bbl) over (partition by api_number, state order by production_date rows between unbounded preceding and current row) as cumulative_water
    from p
)
select entity_key, api_number, state, well_name, operator, county, field_name, basin, well_type, well_status,
       latitude, longitude, production_date, production_year, production_month,
       months_on_production::int as months_on_production, total_oil_bbl, total_gas_mcf, water_bbl, days_produced,
       initial_oil_rate, initial_gas_rate,
       case when initial_oil_rate > 0 then round(total_oil_bbl / initial_oil_rate * 100, 2) end as oil_rate_pct_of_initial,
       cumulative_oil, cumulative_gas, cumulative_water
from d
"""


def build(silver: Path, out: Path) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    for f in (out, out.with_name(out.name + ".wal")):
        if f.exists():
            f.unlink()
    con = duckdb.connect(str(out))
    try:
        con.execute(PRODUCTION_MONTHLY.format(prod=glob(silver, "production")))
        con.execute(DECLINE_CURVE_INPUTS)
        con.execute(f"create or replace table wells as select * from read_parquet('{glob(silver, 'wells')}', hive_partitioning = false)")
        con.execute(f"create or replace table completions as select * from read_parquet('{glob(silver, 'completions')}', hive_partitioning = false)")
        return {t: con.execute(f"select count(*) from {t}").fetchone()[0] for t in ("production_monthly", "decline_curve_inputs", "wells", "completions")}
    finally:
        con.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--silver", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--county-cycle", type=Path, help="accepted for interface parity; the reconciliation is the oracle's job")
    a = ap.parse_args()
    counts = build(a.silver, a.out)
    print(" ".join(f"{k}={v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
