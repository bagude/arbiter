# Campaign explore-1 — orch-dw-explore-27b.json

3 round(s), 0.42 h. Brake: stop on oracle failure or novelty < 0.5 (share of a round's observation titles not similar to any earlier title).

| round | run | outcome | wall s | probes | memory injected | observations | novel | novelty |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-12T17-38-19 | SUCCESS: oracle passed | 413.2 | 6 | 6 | 12 | 12 | 1.00 |
| 2 | 2026-09-12T17-45-13 | SUCCESS: oracle passed | 412 | 2 | 7 | 6 | 6 | 1.00 |
| 3 | 2026-09-12T17-52-06 | SUCCESS: oracle passed | 685 | 3 | 7 | 7 | 7 | 1.00 |

## Round 1 — 2026-09-12T17-38-19

- NM fleet oil down 79% and gas down 45% since 2016
- 57.5% of NM wells first produced in the December 1992 snapshot
- Only 5 of 40 NM wells have a row in December 2025
- 30.7% of NM well-months are gas-only
- 38.5% of NM rows are partial months (days_produced < 28)
- NM water output exceeds oil every year since 2016, peaking at 513% in 2025
- OK completions cover only 69 of 1980 wells (3.5%)
- OK completion spud dates end in August 2010
- 39.7% of decline-curve rows have no computable oil-rate ratio
- Two P&A and both SHUT-IN NM wells still have 2020-or-later production
- All NM condensate was reported in 1992-1993
- Top 5 wells hold 77.0% of all-time NM gas

Open questions left:

- Which specific wells are the 2 P&A and 2 SHUT-IN NM wells with 2020-or-later production, and did they stop mid-year or just recently?
- Is the 2025 water spike (4271 bbl, 513.3% of oil) one well's water event or a broad step-up across the fleet?
- Of the 904 gas-only months with NULL oil in decline_curve_inputs, how many belong to wells that produced oil in other months (intermittent oil) versus permanently gas-only wells?
- Do the 5 gas-leader wells trend flat, rising, or declining year over year, and do the 2 Bravo Dome CO2-EOR wells drive most of the fleet gas decline?
- For the 70 TX wells with NULL county and NULL well_type, is the missing OG_WELL_COMPLETION join because the wells are dry or abandoned, or a coverage gap?

## Round 2 — 2026-09-12T17-45-13

- The 2 P&A and 2 SHUT-IN NM wells with 2020-or-later production are 4 named wells, all stopped mid-2022/2023
- The 2025 NM water spike is one well: EMPIRE ABO UNIT #013C jumped 13 to 3,658 bbl, 85.6% of the fleet's 2025 water
- Gas-only months in decline_curve_inputs split 846 vs 1,102: 4 pure-gas wells vs 11 intermittent oil producers
- The 2 Bravo Dome CO2-EOR wells are 86.0% of 2025 NM fleet gas and both trend down year over year
- The 70 TX wells missing county and well_type are a completion-lookup gap, not dead wells - all 230 TX wells lack name, operator and status
- 29 of 40 NM entities have gappy monthly panels - 3,167 of the 12,501 well-months they span are missing

Open questions left:

- Does the OK well ETHEL (35-003-21903) row explosion repeat elsewhere: 525 of the 964 completion rows (54.5%) come from this one well - a single completion with 5 formations each repeated exactly 105 times at all-zero test rates; check whether the 105 rows per formation are byte-identical in silver and whether other wells (e.g. SCOOTER's 42 rows) share the multiplier, which would argue for a bronze-to-silver dedup rule for OK completions.
- Are the 1,102 gas-only months of the 11 intermittent NM wells clustered in time (shut-ins / mode switches) or scattered, and specifically why does EMPIRE ABO UNIT #013C - well_type OIL, and the source of the 2025 water spike - report NULL total_oil_bbl in all 262 of its producing months: unit-level allocation or a missing oil column in the source?
- Are the 3,167 missing NM well-months concentrated in particular eras (e.g. pre-2003 or around the December 1992 snapshot) or spread across the whole panel - i.e. source coverage vs ingest-side drops?
- Which 5 NM wells have a row in December 2025 (DEKALB A FEDERAL #001, DEKALB FEDERAL #001, LEVICK A STATE #001 and the two Bravo Dome wells), and do those rows report full months (days_produced near 31)? That tells whether the 2-month freshness is a source lag or a pipeline lag.

## Round 3 — 2026-09-12T17-52-06

- OK completion row explosion is unique to ETHEL; all 69 completion wells have 2+ rows
- 779 of 964 OK completion rows are exact duplicates once row_no is ignored
- NM gas-only months are 3 long mode switches (2003-2025) plus one scattered well
- 77.5% of the 3,167 missing NM well-months are a pre-1993 span artifact; the panel is nearly complete from 2013
- December 2025 exists for exactly 5 NM wells: 2 Bravo Dome gas units and 3 tiny oil wells
- Every NM well is a pre-1993 vintage: the 40-well panel is a closed legacy cohort
- 2 of 15 ACTIVE NM wells have no production row since 2008; P&A and SHUT-IN statuses are consistent with history

Open questions left:

- What source_file do the 44 pre-1993 NM rows (17 stray 1973-1985 rows plus the 27-row December 1992 snapshot) come from, and are the stray rows - e.g. STATE #001 with exactly 1 row in 1978-02 and NEW MEXICO AF STATE #002 with 1 row in 1982-03 - first-production records misfiled as monthly volumes, which decides whether a maintainer excludes them from spans.
- Are the 2 NM wells marked ACTIVE but without a row since 2008 (MCA UNIT #211, SANTA FE RR B #035) actually still producing? Cross-check the silver parquet and the source registry to decide whether the status is stale or the production pull is dropping them.
- What are the 9 missing months of 2013-2025 (LE RANCH 9 #001 x4 including 2025-04; SANTA FE RR B #032 and #033 in 2016-07; DEKALB A FEDERAL #001, DEKALB FEDERAL #001 and LEVICK A STATE #001 in 2020-02): genuine shut-in months or missed filings, as a data-quality checklist for the near-complete panel.
- Why does JICARILLA A #017 alternate oil and gas-only months across 35 runs from 1980 to 2025 - dual completion, gas-cap behavior, or unit-level reporting switches - since it is the largest truly intermittent series for decline-curve users.
- Only 69 of the 1,980 OK wells in the wells table have any completion row - quantify that coverage gap by well_status and county and determine whether the OK completions extract covers all Alfalfa County wells or a subset.
