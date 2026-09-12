# Exploration — Concentration, trend, typing and gap structure of the seed warehouse (TX county 421, NM 40 wells, OK Alfalfa) as a maintainer would want to know before trusting aggregates.

## O1 — Three Raton basin wells out-produce nineteen Permian wells combined (confidence 0.7)

Grouped by basin, RATON's 3 wells carry 8050015 bbl of total oil against 2911353 for PERMIAN's 19 and 1206404 for SAN JUAN's 18 — a per-well average two orders of magnitude above the others.

*Why it matters:* Either these Union county wells are genuinely exceptional or their volumes are mis-keyed (the raw records carry a 'C' condensate kind with six-figure monthly amounts); an analyst should check the source before using basin totals.

```sql
select basin, count(distinct entity_key) as wells, round(sum(total_oil_bbl)) as oil, round(sum(total_gas_mcf)) as gas from production_monthly group by 1 order by 1
```

| PERMIAN | 19 | 2911353.0 | 4195740.0 |
| RATON | 3 | 8050015.0 | 13839862.0 |
| SAN JUAN | 18 | 1206404.0 | 11145003.0 |

## O2 — NM oil output in the seed has collapsed since 2021 (confidence 0.85)

Yearly NM total oil fell from 2435 bbl in 2022 to 1048 in 2023, 913 in 2024 and 832 in 2025 — the 40 sampled wells are late-life.

*Why it matters:* Decline-curve work on this sample sees tails, not ramps; anyone fitting initial rates needs younger wells or the full population.

```sql
select production_year, round(sum(total_oil_bbl)) as oil from production_monthly where state = 'NM' group by 1 order by 1 desc limit 5
```

| 2025 | 832.0 |
| 2024 | 913.0 |
| 2023 | 1048.0 |
| 2022 | 2435.0 |
| 2021 | 2331.0 |

## O3 — The wells table is one-third 'OTHER' well types (confidence 0.9)

796 of the wells rows are typed OTHER, more than OIL (739) or GAS (629), with 71 untyped and 15 INJ.

*Why it matters:* OTHER is where the OK codes (DRY, NT, TM, 2DNC…) and NM CO2 wells land under the contract's exhaustive-for-the-seed tables; a consumer filtering to OIL/GAS silently drops a third of the master.

```sql
select well_type, count(*) as n from wells group by 1 order by 2 desc
```

| OTHER | 796 |
| OIL | 739 |
| GAS | 629 |
| None | 71 |
| INJ | 15 |

## O4 — Reported month gaps are the norm in NM histories (confidence 0.8)

The five gappiest NM wells are each missing hundreds of months between first and last report: 30-031-20391 lacks 362 months, 30-025-00470 323, 30-025-00763 280.

*Why it matters:* cumulative_* and months_on_production count reported rows only; time-based analysis must use calendar_months_on_production or expect discontinuities.

```sql
select entity_key, max(calendar_months_on_production) - max(reported_month_index) as gap_months from production_monthly where state = 'NM' group by 1 order by 2 desc limit 5
```

| 30-031-20391 | 362 |
| 30-025-00470 | 323 |
| 30-025-00763 | 280 |
| 30-015-00645 | 243 |
| 30-015-00613 | 235 |

## O5 — Most OK completion rows report no initial-potential oil (confidence 0.85)

Of the 964 OK completion rows, 840 report 0 bbl/d oil on the IP test; only 124 have a non-zero oil rate.

*Why it matters:* IP tests are the only production-like signal OK contributes; with 87% zeros, any OK 'rate' statistic is dominated by gas or by nulls, not oil.

```sql
select case when oil_bbl_per_day > 0 then 'nonzero' else 'zero_or_null' end as oil_ip, count(*) as n from completions group by 1 order by 1
```

| nonzero | 124 |
| zero_or_null | 840 |

## Next questions

- Are the Raton basin volumes real or a units/kind error in wcproduction (kind 'C' with six-figure amounts)?
- How does initial_gor distribute across NM wells, and do the OTHER-typed wells carry gas or oil?
- Which NM wells have the longest continuous reporting runs, for decline fitting?
