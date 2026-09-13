# Campaign real-1 — orch-dw-explore-real-27b.json

3 round(s), 0.63 h. Brake: stop on oracle failure or novelty < 0.5 — an observation counts as already found if its query was run before, its result rows are identical to an earlier observation's, or its title is similar (Jaccard ≥ 0.4); seeded from 8 earlier observation(s) on disk and 103 title(s) in memory.

| round | run | outcome | wall s | probes | memory injected | observations | novel | novelty |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-09-12T22-08-57 | SUCCESS: oracle passed | 735.1 | 6 | 3 | 8 | 8 | 1.00 |
| 2 | 2026-09-12T22-21-13 | SUCCESS: oracle passed | 745.2 | 9 | 4 | 8 | 8 | 1.00 |
| 3 | 2026-09-12T22-33-39 | SUCCESS: oracle passed | 769.2 | 4 | 4 | 8 | 8 | 1.00 |

## Round 1 — 2026-09-12T22-08-57

- Three quarters of TX zero-volume well-months are shut-in months of otherwise-producing wells
- Top-10 extreme oil_rate_pct_of_initial wells all start at exactly 1 bbl
- 94% of OK wells with IP-test volume carry unmapped OTHER status; none is ACTIVE
- TX water_bbl is 100% NULL by source design, not a pipeline drop
- EOG is the largest operator at 2.19B bbl only after merging two spellings
- 93.5% of OK rows are one zero-volume 2026-02 master snapshot; the rest are IP tests back to 1950
- TX oil concentrates in multi-API leases (65% of oil, 21% of rows); gas in single-API rows (81% of gas)
- NM trails TX and OK by a full month (2026-01 vs 2026-02) despite same-week pulls

Open questions left:

- TX: what do the 37,244 never-producing well-grain wells look like in the bronze OG_WELL_COMPLETION file (completion counts, OIL_GAS_CODE) - dry holes, uncompleted leases, or a mapping artifact?
- NM: how are the 11,343,522 water-reporting well-months distributed by year and well vintage - did water reporting ramp after a certain year, and is it concentrated in pre-2010 mature wells?
- decline_curve_inputs: how many wells in total have initial_oil_rate = 1 bbl, and how many have initial_oil_rate below 10 bbl - is the 1-bbl turn-in common enough to warrant a floor rule?
- OK: what distinguishes the 945 zero-volume IP-test rows (31,411 non-snapshot rows minus 30,466 positive) - do they correspond to completions with blank test rates in the xlsx?
- Operators: extend the normalized reference to the top-50 families across all states and quantify the oil hidden by spelling variants outside the EOG family (e.g. Chevron's 3 spellings, XTO's 3).

## Round 2 — 2026-09-12T22-21-13

- NM water reporting begins in 1992 and coverage keeps shifting
- 37,244 TX well-grain wells never produce; 60% first appear in 1993
- 35% of decline-curve wells start at 0 bbl oil; the floor is 0, not 1
- A third of OK's zero-volume IP-test rows sit on plugged-and-abandoned wells
- 1.75B bbl of oil is hidden in 1,038 multi-spelling operator families
- 2.59M NM rows report volume with days_produced = 0
- initial_gor is a peak ratio; 139,689 entities exceed 10k scf/bbl, max 1.12e9
- The warehouse's oldest rows are 1950 OK IP tests, not monthly production

Open questions left:

- NM: what distinguishes the 8,046,463 well-months where water_bbl is NULL (41.5% of NM rows) - do NULL-water months concentrate before 1993 or on dry-gas wells, and does treating NULL as 0 change the water trend?
- days_produced: are the 2,592,599 zero-day NM rows concentrated in a small set of wells that never report days, or spread across shut-in months - count distinct wells with any zero-day row vs wells whose rows are all zero-day.
- OK: do the 275 P&A wells with zero-volume IP tests also have positive-volume IP rows (plugged after production), and why do the 5 completions-only wells (from 35-037-23715, 1983-06, to 35-095-20527, 2020-01) not appear in the 2026-02 master snapshot?
- TX: of the 22,447 never-producing wells first seen in 1993, how many appear in the bronze OG_WELL_COMPLETION file with an OIL_GAS_CODE (drilled but never reported) - a join the gold queries cannot do.
- Operators: extend the dedup to legal-form suffixes (Inc/Co/Company/LP/WTP LP) and quantify the oil that merges beyond the 1.75B - e.g., OXY USA INC (600.6M bbl) + OXY USA WTP LP (326.0M bbl), DEVON ENERGY PRODUCTION COMPANY LP (570.5M) + DEVON ENERGY PRODUCTION CO LP (482.6M).
- Reporting gaps: 437,184 entities (49.8% of 878,193) miss at least one calendar month, 9,298,128 months in total - split by state and entity_type to separate genuine missing production months (TX/NM) from sparse IP-test entities (OK).

## Round 3 — 2026-09-12T22-33-39

- NM NULL-water months are a post-2000 phenomenon, not a pre-1992 gap
- NM zero-day rows spread across 64k wells, not a small never-reporting set
- Most OK P&A wells with IP-test rows produced before plugging
- Legal-form suffix variants hide ~3B bbl across 12+ operator families
- Two-thirds of TX never-producing well-grain wells still carry status NEW
- NM producing wells and oil grew ~11x from 1993 to 2025
- NM days_produced clusters at full months, with 146k single-day rows
- Top 1% of TX well-grain wells hold ~16% of well-grain oil

Open questions left:

- NM: do the 5,591 wells that never report positive days (O2) carry any positive volume at all - i.e. is it a volume-bearing 'never-days' cohort, and which operators/counties dominate it?
- OK: for the 89 P&A wells with both zero- and positive-volume IP rows (O3), what is the row order - positive IP rows before the zero rows, consistent with plugging after production?
- TX: cross-check the 23,928 never-producing NEW-status wells (O5) against lease-grain rows (same operator/county or lease) - is their production recorded at lease grain instead of well grain?
- Operators: quantify the total oil in legal-suffix families beyond the top 12 (O4) and audit false merges (e.g. names where 'co' is part of a word, TEXACO-like cases) and 'L.P.' vs 'LP' variants.
- NM: are the 146,279 single-day rows (O7) concentrated in specific years/fields (spud months of a drilling program), and do those wells then ramp to full months?
- TX: how does the well-grain oil distribution (O8) vary by vintage or basin - is concentration driven by a few mature fields?
