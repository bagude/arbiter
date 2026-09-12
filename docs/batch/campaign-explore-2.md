# Campaign explore-2 — orch-dw-explore-27b.json

3 round(s), 0.95 h. Brake: stop on oracle failure or novelty < 0.5 (share of a round's observation titles not similar to any earlier title).

| round | run | outcome | wall s | probes | memory injected | observations | novel | novelty |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-12T18-04-17 | SUCCESS: oracle passed | 1907.1 | 9 | 6 | 9 | 9 | 1.00 |
| 2 | 2026-09-12T18-36-04 | SUCCESS: oracle passed | 839.5 | 2 | 6 | 8 | 8 | 1.00 |
| 3 | 2026-09-12T18-50-05 | SUCCESS: oracle passed | 658.2 | 3 | 6 | 12 | 12 | 1.00 |

## Round 1 — 2026-09-12T18-04-17

- All 44 pre-1993 NM legacy rows come from the same wcproduction.xml filing stream: a 27-well December 1992 snapshot plus 17 stray 1973-1985 rows
- The 2013-2025 NM panel has exactly 9 missing well-months, all single-month gaps; three Chaves wells all miss 2020-02
- JICARILLA A #017 (397 months, 1980-2025) alternates gas-only vs gas+oil 83 times and never produces oil-only
- Only 2 of 6,861 NM producing well-months ever exceed the initial oil rate, and both are the December 1992 snapshot month
- Only 28 of 40 NM wells have 12+ producing months for decline-curve fitting; 10 wells have exactly one producing month
- OK completions cover only 69 of 1,980 wells (3.5%), with thin P&A coverage (25 of 1,467) and 8.4% of ACTIVE wells
- 88.9% of OK completion rows (857 of 964) carry an OTC production unit number; 10.5% lack a test date
- 70 of 230 TX wells (30.4%) have neither well_type nor county - the exact set with no OG_WELL_COMPLETION rows in this pull
- The exact-105 pattern: four single-well formations and the top OSWEGO operator each contribute exactly 105 OK completion rows

Open questions left:

- Do the bronze wcproduction records contain 2020-02 rows for DEKALB A FEDERAL #001, DEKALB FEDERAL #001 and LEVICK A STATE #001 (all missing that month), or were those months never filed - distinguishing an ingestion drop from a filing miss.
- Does the OK source xlsx literally contain 105 rows per formation for ETHEL and for EARLSBORO's OSWEGO entries (differing only in row_no or formation detail), confirming the exact-105 pattern as a property of the source file.
- Name the 4 NM wells that appear in both the December 1992 snapshot and a stray 1973-1985 row, and check whether their snapshot volumes are consistent with their stray-row volumes (i.e. snapshot = last-known rate).
- For JICARILLA A #017's 83 mode switches, do the pool-level wcproduction records show the oil leg tied to a specific pool_idn that turns on and off, supporting pool-level oil attribution.
- What do the non-producing rows of MCA UNIT #211 (61 of 62) and SANTA FE RR B #035 (42 of 43) report - water only, zero, or NULL - and does that support reclassifying their ACTIVE status.
- NM cumulative water (32,449,504 bbl) exceeds cumulative oil (12,167,772 bbl) 2.7x - identify the wells and fields driving the water cut and whether the dominant water well is actually an injection well.

## Round 2 — 2026-09-12T18-36-04

- NM panel attrition: 23 of 40 entities have their last row in 2022 or earlier; only 13 remain in 2025
- The December 1992 snapshot rows are the 'initial rate' for 23 of 40 NM wells in decline_curve_inputs
- BRAVO DOME CO2 gas units hold 77% of December 1992 snapshot oil and 99% of 1993 oil, then flip to gas-only in 1994
- All 230 TX well coordinates sit ~170 km north of Sherman County, while OK and NM coordinates are consistent with their counties
- MCA UNIT #211 and SANTA FE RR B #035 encode non-production two different ways: explicit 0s vs NULLs
- Four dual-era NM wells pair a stray 1974-1981 row with the December 1992 snapshot at calendar_months_on_production 134-222
- 55 producing well-months report days_produced = 0; LE RANCH 9 #001 accounts for 24 of them
- NM annual trend 1993-2025: gas peaks 1994 at 1,028,604 Mcf and falls 76% by 2025; oil (ex-1993 spike) falls 98.5%

Open questions left:

- T1 (needs bronze, not in this workspace): do the bronze wcproduction records contain 2020-02 rows for DEKALB A FEDERAL #001, DEKALB FEDERAL #001 and LEVICK A STATE #001 (the wells behind the 9 missing panel well-months), i.e. were the months dropped between bronze and gold?
- T4 (needs bronze, not in this workspace): for JICARILLA A #017's 83 gas-only vs gas+oil mode switches, do the pool-level wcproduction records show the oil leg tied to a specific pool_idn that turns on and off, or is the whole well switching pools?
- The three snapshot entities that skip 1993 entirely (EMPIRE ABO UNIT #015C, EMU #001, MILNESAND UNIT #137 - present in 1992-12, absent all 12 months of 1993, back in 1994-01 as zeros): check the silver parquet for 1993 rows - is the gap in the source or introduced by the gold build?
- BRAVO DOME CARBON DIOXIDE GAS UNIT #061 reports a single-month gas spike of 93,918 Mcf in 1994-07 against a ~4,500 Mcf baseline: is that spike a source value or an artifact of multi-pool summation in silver?
- The 19 water-only rows (oil and gas NULL, water present) across 5 wells from 1993-2022 - 12 in SOUTH RED LAKE II UNIT #032 alone: are these waterflood water-production months, and should they be flagged so consumers reading only the hydrocarbon columns do not treat them as 'no production'?

## Round 3 — 2026-09-12T18-50-05

- The three 1993-skipping snapshot units are dead: two never produce again, EMU #001 reappears in 1994-12
- The December 1992 snapshot rows are 32x to 86x larger than any real month in the 1993-2025 panel
- BRAVO DOME CO2 unit #061: exactly 2 of 73 gas months exceed 2x the 4121.0 Mcf median - both in 1994
- Both #061 spikes sit inside a stable 1994 baseline of 4.5-6.1k Mcf with normal neighbor months
- The 19 water-only rows span 5 wells, 12 of them in SOUTH RED LAKE II UNIT #032, with 3.0 bbl as a recurring default
- None of the 19 water-only months sit inside a producing run: 0 of 19 have a producing neighbor
- 66.2% of all NM oil is condensate from 3 CO2 units in the first 13 months
- One OK well holds 525 of the 964 completion rows: a 5-formation x 105-row grid with all-zero test rates
- completions row_no is a global 1-964 sequence and completion_no has only 5 distinct values
- 29 of 40 NM entities have missing months inside their panels; worst is 362 of 405
- OK Alfalfa: 74% of wells are P&A, 40% are type OTHER, and 12 are injection wells
- 56.1% of NM producing well-months sit at or below 5% of the initial oil rate

Open questions left:

- T1 (needs bronze, not in this workspace): do the bronze wcproduction records contain 2020-02 rows for DEKALB A FEDERAL #001 / DEKALB FEDERAL wells - i.e. amended records for a month that is missing in silver? Still open from an earlier run; cannot be answered from the gold warehouse alone.
- T4 (needs bronze, not in this workspace): for JICARILLA A #017's 83 gas-only vs gas+oil mode switches, do the pool-level wcproduction records show the mode switching at pool level or at well level? Still open from an earlier run; cannot be answered from the gold warehouse alone.
- For the 525-row OK completion grid of api 35-003-21903 (OTC 003-124435, 5 formations x 105 rows, all zero rates, all completed 2008-09-25): do the 105 rows per formation correspond to 105 distinct wells of one unit that were collapsed to a single API in silver? Check the bronze OCC source file for 2008-09-25 for distinct well identifiers (O8/O9).
- Of the 27 NM entities with a 1992-12 snapshot row, only 2 have that row as their sole nonzero row (EMPIRE ABO UNIT #015C, MILNESAND UNIT #137). For the other 25, does the snapshot volume step down discontinuously into 1994 (supporting the cumulative-placeholder reading of O2), or do they show a plausible monthly rate?
- Does sibling BRAVO DOME CARBON DIOXIDE GAS UNIT #291 - which holds the four largest post-1993 gas months (44336.0, 43305.0, 43247.0, 43176.0 Mcf in 1994-01..1995-03) - show the same 1994 double-spike pattern as #061? If so, the 1994 anomaly is field-level CO2 reporting, not a single-well misreport (O3/O4).
- GRACE MITCHELL B FEDERAL #005 has only 202 of 525 calendar months present (323 missing, O10): are the missing months long contiguous absences or scattered, and do the absences cluster around well-status changes? Same question for the 280 missing months of MCA UNIT #211.
- BREECH A #132E reaches oil_rate_pct_of_initial of 3062.07%: is its 1981-05 initial oil rate a low outlier (e.g. a partial-day report) that makes the initial-rate denominator meaningless, and do its curve inputs change materially if the first producing month is excluded?
