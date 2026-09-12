# Campaign explore-3 — orch-dw-explore-27b.json

3 round(s), 0.65 h. Brake: stop on oracle failure or novelty < 0.5 — an observation counts as already found if its query was run before, its result rows are identical to an earlier observation's, or its title is similar (Jaccard ≥ 0.4); seeded from 73 earlier observation(s) on disk and 72 title(s) in memory.

| round | run | outcome | wall s | probes | memory injected | observations | novel | novelty |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-12T20-35-53 | SUCCESS: oracle passed | 952.4 | 12 | 11 | 8 | 8 | 1.00 |
| 2 | 2026-09-12T20-51-46 | SUCCESS: oracle passed | 731.4 | 2 | 11 | 7 | 7 | 1.00 |
| 3 | 2026-09-12T21-03-58 | SUCCESS: oracle passed | 649.5 | 2 | 11 | 8 | 7 | 0.88 |

## Round 1 — 2026-09-12T20-35-53

- OK 525-row completion grid: 25 distinct fact-tuples, each repeated exactly 21 times
- OK completions: first production precedes the test date in 846 of 859 rows
- OK IP test rates: 87% of oil rates are zero, 345 rows all-zero, max 318 BBL/d
- The 1992-12 snapshot month holds 76% of panel oil and 80% of panel water
- Eight NM wells' panels all end at 2025-11; the active fleet falls from 13 to 5 in December 2025
- initial_gor is stored 1000x the conventional GOR; 5 entities are NULL for two different reasons
- TX well master: 93% of typed Sherman County wells are GAS, 70 wells have no type at all
- All eight 2025-11-ended wells are ACTIVE in the well master — the December gap is reporting, not abandonment

Open questions left:

- Does the next NM OCD pull restore 2025-12 rows for the eight ACTIVE wells that end at 2025-11 (CENTRAL BISTI UNIT #043, EMPIRE ABO UNIT #013C, BREECH A #132E, LE RANCH 9 #001, BREECH D #341, JICARILLA A #017, DOME STATE 32-22-6 #002, FEDERAL 29-22-6 #001), and do their 2025-11 volumes look like normal run-rate rather than a wind-down?
- Gold `vintage`: 23 of 40 entities have vintage 1992 (the snapshot month) and no entity's vintage falls in 1986–1991 — should vintage exclude the 1992-12 snapshot row, and how many vintage-based cohorts change if it does?
- CANYON LARGO UNIT COM #136, the largest gas-only entity (1,900,261 Mcf cumulative), last reports 2023-08 — check its well_status and whether the 18-month silence is a reporting gap or a real stop.
- OK completions: do the 40 rows missing first_prod_date and the 101 rows missing test_date concentrate in particular operators or formations, or are they scattered?
- Water excluding the snapshot is still 2.2x oil (6,385,522 vs 2,963,163 BBL over 4,232 well-months) — which single well or unit dominates cumulative_water_bbl, and does water cut trend up over 1993–2025?

## Round 2 — 2026-09-12T20-51-46

- NM last production months span 27 distinct values; only 5 of 40 entities reach 2025-12
- Two vintage-1992 panels are zombies: 127-157 months of explicit zero gas after the snapshot
- Gas-only NM entities: the 2 that stopped are P&A, the 2 still ACTIVE report through 2025-11
- The 525-row OK completion grid has zero null dates; all 101/40 nulls sit in the other 439 rows
- OK completion null dates concentrate in small formations (SIMPSON, TONKAWA, REDFORK, COTTAGE GROVE)
- EMU H #003 alone holds 77.6% of ex-snapshot cumulative water (4952694.0 of 6385522.0 BBL)
- The 2025-12 NM gap is operator-specific: only SLAYTON and OXY filed December

Open questions left:

- Do the 6 operators with no 2025-12 rows (APACHE, CROSS TIMBERS, DJR, DUGAN, HILCORP, QUATRO OSOS) restore December 2025 in the next NM OCD pull or the bronze wcproduction records? - because the gap is operator-specific, so a targeted re-pull (or the raw bronze) will separate late filers from truly idle units.
- Are EMU H #003's 1996-1998 water rates (~150-173k BBL/month) real waterflood volumes or a unit/reporting error? - because one P&A well is 77.6% of all ex-snapshot water, so the bronze pool-level records must confirm it before warehouse water totals (and water-oil ratios) are trusted.
- Why do the vintage-1992 zombie panels (EMPIRE ABO #015C, MILNESAND #137) keep filing explicit zero gas for 12-14 years after the snapshot? - because the contract reads 0 as 'reported zero', so the bronze records or OCD unit status are needed to know whether these were shut-in units that kept reporting, and whether 'vintage' should exclude the snapshot month.
- Do the SIMPSON / TONKAWA / REDFORK / COTTAGE GROVE completion rows with missing test dates share a completion_date window or a single source extract? - because TONKAWA and REDFORK are 100% missing test_date, which points to a systematic per-formation source gap rather than random missingness.

## Round 3 — 2026-09-12T21-03-58

- EMU H #003's 1996-1998 water is a flat 146,319-173,134 BBL/month, 270x-1,600x the rest of the fleet
- The two zombie units file 127 and 157 calendar-perfect all-zero months from 1994-01, and both are P&A
- The 33 OK completions missing test dates group into three filing batches, not into the formations
- All six operators with no 2025-12 rows still filed 2025-11, with at most 1,036 Mcf of gas each
- (similar title) Only 2 of 6,861 decline well-months exceed 100% of initial oil rate - both are the 1992-12 snapshot
- Six fully gas-only wells carry 1,821 decline well-months; JICARILLA A #017 has the 396-month longest run
- 2,413 NM well-months (25.8%) report days_produced = 0, and 62 of them still carry non-zero volume
- Only 69 of 1,980 OK Alfalfa wells appear in the completions table; every completion API matches wells

Open questions left:

- EMU H #003 water onset 1996-08: check whether its operator changed (MERRION OIL & GAS CORP era vs SYNERGY OPERATING LLC era) or its dominant pool changed at exactly that month - a unit/convention change usually coincides with an operator or metering change (needs pool-level bronze, not in this workspace).
- BREECH A #132E: it has 100 well-months in the 10-50%-of-initial band (1993-2007) on top of the 3062.07% snapshot row - what did its real mid-1990s oil rate look like, and which of its three operator eras (CAULKINS, XTO, CROSS TIMBERS) filed the step? That decides whether 116 BBL (1981) or the 1990s plateau is the right decline baseline.
- Do the 1983-1984 OK legacy cluster (VELMA, KILDOW, V.O GOODWIN, ANGLE-MCCLAFLIN) have test dates on their other formations, or are those four wells entirely test-less in the completions file - i.e. a whole-well legacy gap rather than a per-formation one?
- days_produced = 0: do the 62 with-volume zero-day rows concentrate in one filing era (1995-2001 looks likely from the top wells) or one set of operators, which would indicate a legacy placeholder for 'days unknown' rather than a genuine zero?
- JICARILLA A #017's 396-month gas run: is its late-life rate a stable plateau near the 729 Mcf initial or genuinely declining - a 45-year single-well series is the only long enough record in this warehouse to fit a real decline curve.
- Four gas-only wells take their initial_gas_rate from the 1992-12 snapshot (up to 1,780,146 Mcf for CANYON LARGO UNIT COM #136): re-baseline them to the first post-1993 producing month and quantify how much the fitted decline changes.
