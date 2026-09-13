# repo:data-warehousers-real

1 fact(s), 4 run(s) in history, 4 candidate(s). Runs: [[runs/2026-09-12T21-53-54]], [[runs/2026-09-12T22-08-57]], [[runs/2026-09-12T22-21-13]], [[runs/2026-09-12T22-33-39]].

## Facts

- [procedural] dw-explore-real: delegation that passed the oracle — worker 1: You are writing the deliverables for a data-exploration task on a read-only oil & gas warehouse snapshot. (m_f32e902f6bc6, conf 0.99, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1 [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1 [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1 [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)

## Digests

- [[runs/2026-09-12T22-33-39]] Findings digest: O1 NM NULL-water months are a post-2000 phenomenon, not a pre-1992 gap | O2 NM zero-day rows spread across 64k wells, not a small never-reporting set | O3 Most OK P&A wells with IP-test rows produced before plugging | O4 Legal-form suffix variants hide ~3B bbl across 12+ operator families | O5 Two-thirds of TX never-producing well-grain wells still carry status NEW | O6 NM producing wells and oil grew ~11x from 1993 to 2025 | O7 NM days_produced clusters at full months, with 146k single-day rows | O8 Top 1% of TX well-grain wells hold ~16% of well-grain oil || next: NM: do the 5,591 wells that never report positive days (O2) carry any positive volume at all - i.e. is it a volume-bearing 'never-days' coho | OK: for the 89 P&A wells with both zero- and positive-volume IP rows (O3), what is the row order - positive IP rows before the zero rows, co | TX: cross-check the 23,928 never-producing NEW-status wells (O5) against lease-grain rows (same operator/county or lease) - is their product | Operators: quantify the total oil in legal-suffix families beyond the top 12 (O4) and audit false merges (e.g. names where 'co' is part of a | NM: are the 146,279 single-day rows (O7) concentrated in specific years/fields (spud months of a drilling program), and do those wells then (m_bf489bc6eb60)
- [[runs/2026-09-12T22-21-13]] Findings digest: O1 NM water reporting begins in 1992 and coverage keeps shifting | O2 37,244 TX well-grain wells never produce; 60% first appear in 1993 | O3 35% of decline-curve wells start at 0 bbl oil; the floor is 0, not 1 | O4 A third of OK's zero-volume IP-test rows sit on plugged-and-abandoned wells | O5 1.75B bbl of oil is hidden in 1,038 multi-spelling operator families | O6 2.59M NM rows report volume with days_produced = 0 | O7 initial_gor is a peak ratio; 139,689 entities exceed 10k scf/bbl, max 1.12e9 | O8 The warehouse's oldest rows are 1950 OK IP tests, not monthly production || next: NM: what distinguishes the 8,046,463 well-months where water_bbl is NULL (41.5% of NM rows) - do NULL-water months concentrate before 1993 o | days_produced: are the 2,592,599 zero-day NM rows concentrated in a small set of wells that never report days, or spread across shut-in mont | OK: do the 275 P&A wells with zero-volume IP tests also have positive-volume IP rows (plugged after production), and why do the 5 completion | TX: of the 22,447 never-producing wells first seen in 1993, how many appear in the bronze OG_WELL_COMPLETION file with an OIL_GAS_CODE (dril | Operators: extend the dedup to legal-form suffixes (Inc/Co/Company/LP/WTP LP) and quantify the oil that merges beyond the 1.75B - e.g., OXY (m_e30859d1aafd)
- [[runs/2026-09-12T22-08-57]] Findings digest: O1 Three quarters of TX zero-volume well-months are shut-in months of otherwise-pro | O2 Top-10 extreme oil_rate_pct_of_initial wells all start at exactly 1 bbl | O3 94% of OK wells with IP-test volume carry unmapped OTHER status; none is ACTIVE | O4 TX water_bbl is 100% NULL by source design, not a pipeline drop | O5 EOG is the largest operator at 2.19B bbl only after merging two spellings | O6 93.5% of OK rows are one zero-volume 2026-02 master snapshot; the rest are IP te | O7 TX oil concentrates in multi-API leases (65% of oil, 21% of rows); gas in single | O8 NM trails TX and OK by a full month (2026-01 vs 2026-02) despite same-week pulls || next: TX: what do the 37,244 never-producing well-grain wells look like in the bronze OG_WELL_COMPLETION file (completion counts, OIL_GAS_CODE) -  | NM: how are the 11,343,522 water-reporting well-months distributed by year and well vintage - did water reporting ramp after a certain year, | decline_curve_inputs: how many wells in total have initial_oil_rate = 1 bbl, and how many have initial_oil_rate below 10 bbl - is the 1-bbl  | OK: what distinguishes the 945 zero-volume IP-test rows (31,411 non-snapshot rows minus 30,466 positive) - do they correspond to completions | Operators: extend the normalized reference to the top-50 families across all states and quantify the oil hidden by spelling variants outside (m_6c03c5e8deae)
- [[runs/2026-09-12T21-53-54]] Findings digest: O1 TX is stored at both well and lease grain; NM and OK are well-only | O2 No TX lease-month appears in both the well and the lease grain | O3 93.5% of OK rows are one pull-month well-master snapshot | O4 Largest OK 'production' months are round-number IP tests | O5 29.5% of well-months carry no positive volume and miss decline_curve_inputs | O6 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi | O7 EOG is split across two operator spellings, hiding the largest operator | O8 days_produced is populated only for NM and the OK IP-test rows || next: TX: does the zero-volume well-month share (34.2% of well rows) coincide with months where the same lease has a positive lease-grain row — i. | Identify the wells behind the extreme oil_rate_pct_of_initial values (top 10 wells by max pct; overall max is 5777400%) and check whether th | OK: characterize the 426646 master wells with NULL vintage via well_status (producing / shut-in / dry) and test whether the 28275 IP-tested  | Water: TX water_bbl is 100% NULL while NM carries 31072845552 bbl — is water reported for TX in the source file but dropped by the pipeline, | Operator names: build a normalized operator reference from the punctuation-variant families found (EOG 2192690624 bbl across 2 main spelling (m_dc548352a618)

## Explorations

32 distinct observation title(s) across every exploration of this scope, newest first.

- NM NULL-water months are a post-2000 phenomenon, not a pre-1992 gap ([[runs/2026-09-12T22-33-39]])
- NM zero-day rows spread across 64k wells, not a small never-reporting set ([[runs/2026-09-12T22-33-39]])
- Most OK P&A wells with IP-test rows produced before plugging ([[runs/2026-09-12T22-33-39]])
- Legal-form suffix variants hide ~3B bbl across 12+ operator families ([[runs/2026-09-12T22-33-39]])
- Two-thirds of TX never-producing well-grain wells still carry status NEW ([[runs/2026-09-12T22-33-39]])
- NM producing wells and oil grew ~11x from 1993 to 2025 ([[runs/2026-09-12T22-33-39]])
- NM days_produced clusters at full months, with 146k single-day rows ([[runs/2026-09-12T22-33-39]])
- Top 1% of TX well-grain wells hold ~16% of well-grain oil ([[runs/2026-09-12T22-33-39]])
- NM water reporting begins in 1992 and coverage keeps shifting ([[runs/2026-09-12T22-21-13]])
- 37,244 TX well-grain wells never produce; 60% first appear in 1993 ([[runs/2026-09-12T22-21-13]])
- 35% of decline-curve wells start at 0 bbl oil; the floor is 0, not 1 ([[runs/2026-09-12T22-21-13]])
- A third of OK's zero-volume IP-test rows sit on plugged-and-abandoned wells ([[runs/2026-09-12T22-21-13]])
- 1.75B bbl of oil is hidden in 1,038 multi-spelling operator families ([[runs/2026-09-12T22-21-13]])
- 2.59M NM rows report volume with days_produced = 0 ([[runs/2026-09-12T22-21-13]])
- initial_gor is a peak ratio; 139,689 entities exceed 10k scf/bbl, max 1.12e9 ([[runs/2026-09-12T22-21-13]])
- The warehouse's oldest rows are 1950 OK IP tests, not monthly production ([[runs/2026-09-12T22-21-13]])
- Three quarters of TX zero-volume well-months are shut-in months of otherwise-pro ([[runs/2026-09-12T22-08-57]])
- Top-10 extreme oil_rate_pct_of_initial wells all start at exactly 1 bbl ([[runs/2026-09-12T22-08-57]])
- 94% of OK wells with IP-test volume carry unmapped OTHER status; none is ACTIVE ([[runs/2026-09-12T22-08-57]])
- TX water_bbl is 100% NULL by source design, not a pipeline drop ([[runs/2026-09-12T22-08-57]])
- EOG is the largest operator at 2.19B bbl only after merging two spellings ([[runs/2026-09-12T22-08-57]])
- 93.5% of OK rows are one zero-volume 2026-02 master snapshot; the rest are IP te ([[runs/2026-09-12T22-08-57]])
- TX oil concentrates in multi-API leases (65% of oil, 21% of rows); gas in single ([[runs/2026-09-12T22-08-57]])
- NM trails TX and OK by a full month (2026-01 vs 2026-02) despite same-week pulls ([[runs/2026-09-12T22-08-57]])
- TX is stored at both well and lease grain; NM and OK are well-only ([[runs/2026-09-12T21-53-54]])
- No TX lease-month appears in both the well and the lease grain ([[runs/2026-09-12T21-53-54]])
- 93.5% of OK rows are one pull-month well-master snapshot ([[runs/2026-09-12T21-53-54]])
- Largest OK 'production' months are round-number IP tests ([[runs/2026-09-12T21-53-54]])
- 29.5% of well-months carry no positive volume and miss decline_curve_inputs ([[runs/2026-09-12T21-53-54]])
- 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi ([[runs/2026-09-12T21-53-54]])
- EOG is split across two operator spellings, hiding the largest operator ([[runs/2026-09-12T21-53-54]])
- days_produced is populated only for NM and the OK IP-test rows ([[runs/2026-09-12T21-53-54]])

## History

- dw-explore-real via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 769.2s; 1 workers, 4 probes, 1 done attempt. Oracle: 14/14. (m_bf489bc6eb60, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- dw-explore-real via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 745.2s; 1 workers, 9 probes, 1 done attempt. Oracle: 14/14. (m_e30859d1aafd, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- dw-explore-real via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 735.1s; 1 workers, 6 probes, 1 done attempt. Oracle: 14/14. (m_6c03c5e8deae, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- dw-explore-real via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 842.4s; 1 workers, 13 probes, 1 done attempt. Oracle: 14/14. (m_dc548352a618, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)

## Candidates

- [semantic, agent] dw-explore-real: the 2,592,599 "zero-day NM rows" are ALL rows with days_produced=0 (only 117,277 of them carry volume), and when normalizing operator names for dedup, apply lower() BEFORE stripping [^a-z0-9] — most TX operator names are all-caps, so stripping first destroys the name (this is why a suffix-family query can silently return zero rows). (m_d9c505687146, conf 0.4, evidence: [[runs/2026-09-12T22-33-39]] mail:2026-09-12T22-33-39#6)
- [semantic, agent] dw-explore-real: production_monthly has NO duplicate (entity_key, state, production_date) keys (all multiplicity=1 across TX/NM/OK); earlier-looking "92M extra rows" was a bug in a group-by-(entity_key,state)-only query, not a data issue. (m_04e1ea454218, conf 0.4, evidence: [[runs/2026-09-12T22-21-13]] mail:2026-09-12T22-21-13#8)
- [semantic, agent] dw-explore-real run 2026-09-12T22-08-57 findings digest: O1 73.2% of TX zero-volume well-months (14,478,076 of 19,764,792) belong to 236,819 wells that produce in other months; 37,244 well entities never produce | O2 all top-10 extreme oil_rate_pct_of_initial wells (max 5,777,400%, NM 30-025-53125) have initial_oil_rate = exactly 1 bbl | O3 426,646 of OK's 454,921 master wells have NULL vintage; of 28,275 IP-tested wells 26,624 are status OTHER and zero OK rows are ACTIVE | O4 TX water_bbl NULL (m_3469b155870c, conf 0.4, evidence: [[runs/2026-09-12T22-08-57]] mail:2026-09-12T22-08-57#8)
- [semantic, agent] In the dw-explore-real workspace's DuckDB build, regexp_replace(x, '[^A-Za-z0-9]', '') only strips whitespace and leaves punctuation like ',' and '.' intact (verified with a literal), so operator-name normalization queries must use nested replace() literal substitutions instead of character-class regex. (m_befbdb0fb832, conf 0.4, evidence: [[runs/2026-09-12T21-53-54]] mail:2026-09-12T21-53-54#13)
