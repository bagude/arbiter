# repo:data-warehousers-real

33 fact(s), 0 run(s) in history, 4 candidate(s). Runs: [[runs/2026-09-12T21-53-54]], [[runs/2026-09-12T22-08-57]], [[runs/2026-09-12T22-21-13]], [[runs/2026-09-12T22-33-39]].

## Facts

- [semantic] TX is stored at both well and lease grain; NM and OK are well-only (m_ead88dee979c, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] No TX lease-month appears in both the well and the lease grain (m_c15ad0849703, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] 93.5% of OK rows are one pull-month well-master snapshot (m_07d48d54bc5a, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] Largest OK 'production' months are round-number IP tests (m_796ab18474a4, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] 29.5% of well-months carry no positive volume and miss decline_curve_inputs (m_479921c5d00e, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi (m_c4d975a2a6be, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] EOG is split across two operator spellings, hiding the largest operator (m_6cfcc9963422, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] days_produced is populated only for NM and the OK IP-test rows (m_82e2dabfa8b7, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)
- [semantic] Three quarters of TX zero-volume well-months are shut-in months of otherwise-pro (m_213ed30601be, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] Top-10 extreme oil_rate_pct_of_initial wells all start at exactly 1 bbl (m_7305e21f4e2f, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] 94% of OK wells with IP-test volume carry unmapped OTHER status; none is ACTIVE (m_7f803abb8e2e, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] TX water_bbl is 100% NULL by source design, not a pipeline drop (m_f5e7c757bf24, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] EOG is the largest operator at 2.19B bbl only after merging two spellings (m_791f3be03486, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] 93.5% of OK rows are one zero-volume 2026-02 master snapshot; the rest are IP te (m_b4f6dadf5288, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] TX oil concentrates in multi-API leases (65% of oil, 21% of rows); gas in single (m_1acb81dbe721, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] NM trails TX and OK by a full month (2026-01 vs 2026-02) despite same-week pulls (m_69ecaeeadd41, conf 0.9, evidence: [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1)
- [semantic] NM water reporting begins in 1992 and coverage keeps shifting (m_49af3aa4aa73, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] 37,244 TX well-grain wells never produce; 60% first appear in 1993 (m_986b4421cd60, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] 35% of decline-curve wells start at 0 bbl oil; the floor is 0, not 1 (m_ca820316e8d7, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] A third of OK's zero-volume IP-test rows sit on plugged-and-abandoned wells (m_b92963f1916e, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] 1.75B bbl of oil is hidden in 1,038 multi-spelling operator families (m_3f0a40ce10e3, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] 2.59M NM rows report volume with days_produced = 0 (m_54d9813f4572, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] initial_gor is a peak ratio; 139,689 entities exceed 10k scf/bbl, max 1.12e9 (m_94723cefe34b, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] The warehouse's oldest rows are 1950 OK IP tests, not monthly production (m_5c9fadec7845, conf 0.9, evidence: [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1)
- [semantic] NM NULL-water months are a post-2000 phenomenon, not a pre-1992 gap (m_f020d1813d20, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] NM zero-day rows spread across 64k wells, not a small never-reporting set (m_d08a64972927, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] Most OK P&A wells with IP-test rows produced before plugging (m_80cc4941bc3f, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] Legal-form suffix variants hide ~3B bbl across 12+ operator families (m_67c4df430ec1, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] Two-thirds of TX never-producing well-grain wells still carry status NEW (m_dc31e80c302b, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] NM producing wells and oil grew ~11x from 1993 to 2025 (m_82699ed6dc6d, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] NM days_produced clusters at full months, with 146k single-day rows (m_127b99810195, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [semantic] Top 1% of TX well-grain wells hold ~16% of well-grain oil (m_034d23f05a01, conf 0.9, evidence: [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)
- [procedural] dw-explore-real: delegation that passed the oracle — worker 1: You are writing the deliverables for a data-exploration task on a read-only oil & gas warehouse snapshot. (m_f32e902f6bc6, conf 0.99, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1 [[runs/2026-09-12T22-08-57]] oracle:2026-09-12T22-08-57#1 [[runs/2026-09-12T22-21-13]] oracle:2026-09-12T22-21-13#1 [[runs/2026-09-12T22-33-39]] oracle:2026-09-12T22-33-39#1)

## Explorations

32 distinct observation title(s) across every exploration of this scope, newest first.

- [unreviewed ·] TX is stored at both well and lease grain; NM and OK are well-only ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] No TX lease-month appears in both the well and the lease grain ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] 93.5% of OK rows are one pull-month well-master snapshot ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] Largest OK 'production' months are round-number IP tests ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] 29.5% of well-months carry no positive volume and miss decline_curve_inputs ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] EOG is split across two operator spellings, hiding the largest operator ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] days_produced is populated only for NM and the OK IP-test rows ([[runs/2026-09-12T21-53-54]])
- [unreviewed ·] Three quarters of TX zero-volume well-months are shut-in months of otherwise-pro ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] Top-10 extreme oil_rate_pct_of_initial wells all start at exactly 1 bbl ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] 94% of OK wells with IP-test volume carry unmapped OTHER status; none is ACTIVE ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] TX water_bbl is 100% NULL by source design, not a pipeline drop ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] EOG is the largest operator at 2.19B bbl only after merging two spellings ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] 93.5% of OK rows are one zero-volume 2026-02 master snapshot; the rest are IP te ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] TX oil concentrates in multi-API leases (65% of oil, 21% of rows); gas in single ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] NM trails TX and OK by a full month (2026-01 vs 2026-02) despite same-week pulls ([[runs/2026-09-12T22-08-57]])
- [unreviewed ·] NM water reporting begins in 1992 and coverage keeps shifting ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] 37,244 TX well-grain wells never produce; 60% first appear in 1993 ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] 35% of decline-curve wells start at 0 bbl oil; the floor is 0, not 1 ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] A third of OK's zero-volume IP-test rows sit on plugged-and-abandoned wells ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] 1.75B bbl of oil is hidden in 1,038 multi-spelling operator families ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] 2.59M NM rows report volume with days_produced = 0 ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] initial_gor is a peak ratio; 139,689 entities exceed 10k scf/bbl, max 1.12e9 ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] The warehouse's oldest rows are 1950 OK IP tests, not monthly production ([[runs/2026-09-12T22-21-13]])
- [unreviewed ·] NM NULL-water months are a post-2000 phenomenon, not a pre-1992 gap ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] NM zero-day rows spread across 64k wells, not a small never-reporting set ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] Most OK P&A wells with IP-test rows produced before plugging ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] Legal-form suffix variants hide ~3B bbl across 12+ operator families ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] Two-thirds of TX never-producing well-grain wells still carry status NEW ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] NM producing wells and oil grew ~11x from 1993 to 2025 ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] NM days_produced clusters at full months, with 146k single-day rows ([[runs/2026-09-12T22-33-39]])
- [unreviewed ·] Top 1% of TX well-grain wells hold ~16% of well-grain oil ([[runs/2026-09-12T22-33-39]])

## History

(no runs retained)

## Candidates

- [semantic, agent] dw-explore-real: the 2,592,599 "zero-day NM rows" are ALL rows with days_produced=0 (only 117,277 of them carry volume), and when normalizing operator names for dedup, apply lower() BEFORE stripping [^a-z0-9] — most TX operator names are all-caps, so stripping first destroys the name (this is why a suffix-family query can silently return zero rows). (m_d9c505687146, conf 0.4, evidence: [[runs/2026-09-12T22-33-39]] mail:2026-09-12T22-33-39#6)
- [semantic, agent] dw-explore-real: production_monthly has NO duplicate (entity_key, state, production_date) keys (all multiplicity=1 across TX/NM/OK); earlier-looking "92M extra rows" was a bug in a group-by-(entity_key,state)-only query, not a data issue. (m_04e1ea454218, conf 0.4, evidence: [[runs/2026-09-12T22-21-13]] mail:2026-09-12T22-21-13#8)
- [semantic, agent] dw-explore-real run 2026-09-12T22-08-57 findings digest: O1 73.2% of TX zero-volume well-months (14,478,076 of 19,764,792) belong to 236,819 wells that produce in other months; 37,244 well entities never produce | O2 all top-10 extreme oil_rate_pct_of_initial wells (max 5,777,400%, NM 30-025-53125) have initial_oil_rate = exactly 1 bbl | O3 426,646 of OK's 454,921 master wells have NULL vintage; of 28,275 IP-tested wells 26,624 are status OTHER and zero OK rows are ACTIVE | O4 TX water_bbl NULL (m_3469b155870c, conf 0.4, evidence: [[runs/2026-09-12T22-08-57]] mail:2026-09-12T22-08-57#8)
- [semantic, agent] In the dw-explore-real workspace's DuckDB build, regexp_replace(x, '[^A-Za-z0-9]', '') only strips whitespace and leaves punctuation like ',' and '.' intact (verified with a literal), so operator-name normalization queries must use nested replace() literal substitutions instead of character-class regex. (m_befbdb0fb832, conf 0.4, evidence: [[runs/2026-09-12T21-53-54]] mail:2026-09-12T21-53-54#13)
