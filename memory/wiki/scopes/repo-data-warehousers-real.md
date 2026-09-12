# repo:data-warehousers-real

1 fact(s), 1 run(s) in history, 1 candidate(s). Runs: [[runs/2026-09-12T21-53-54]].

## Facts

- [procedural] dw-explore-real: delegation that passed the oracle — worker 1: You are writing the deliverables for a data-exploration task on a read-only oil & gas warehouse snapshot. (m_f32e902f6bc6, conf 0.7, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)

## Digests

- [[runs/2026-09-12T21-53-54]] Findings digest: O1 TX is stored at both well and lease grain; NM and OK are well-only | O2 No TX lease-month appears in both the well and the lease grain | O3 93.5% of OK rows are one pull-month well-master snapshot | O4 Largest OK 'production' months are round-number IP tests | O5 29.5% of well-months carry no positive volume and miss decline_curve_inputs | O6 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi | O7 EOG is split across two operator spellings, hiding the largest operator | O8 days_produced is populated only for NM and the OK IP-test rows || next: TX: does the zero-volume well-month share (34.2% of well rows) coincide with months where the same lease has a positive lease-grain row — i. | Identify the wells behind the extreme oil_rate_pct_of_initial values (top 10 wells by max pct; overall max is 5777400%) and check whether th | OK: characterize the 426646 master wells with NULL vintage via well_status (producing / shut-in / dry) and test whether the 28275 IP-tested  | Water: TX water_bbl is 100% NULL while NM carries 31072845552 bbl — is water reported for TX in the source file but dropped by the pipeline, | Operator names: build a normalized operator reference from the punctuation-variant families found (EOG 2192690624 bbl across 2 main spelling (m_dc548352a618)

## Explorations

8 distinct observation title(s) across every exploration of this scope, newest first.

- TX is stored at both well and lease grain; NM and OK are well-only ([[runs/2026-09-12T21-53-54]])
- No TX lease-month appears in both the well and the lease grain ([[runs/2026-09-12T21-53-54]])
- 93.5% of OK rows are one pull-month well-master snapshot ([[runs/2026-09-12T21-53-54]])
- Largest OK 'production' months are round-number IP tests ([[runs/2026-09-12T21-53-54]])
- 29.5% of well-months carry no positive volume and miss decline_curve_inputs ([[runs/2026-09-12T21-53-54]])
- 42.7% of decline-curve rows have no oil-rate baseline; 9.3% exceed 100% of initi ([[runs/2026-09-12T21-53-54]])
- EOG is split across two operator spellings, hiding the largest operator ([[runs/2026-09-12T21-53-54]])
- days_produced is populated only for NM and the OK IP-test rows ([[runs/2026-09-12T21-53-54]])

## History

- dw-explore-real via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 842.4s; 1 workers, 13 probes, 1 done attempt. Oracle: 14/14. (m_dc548352a618, conf 0.9, evidence: [[runs/2026-09-12T21-53-54]] oracle:2026-09-12T21-53-54#1)

## Candidates

- [semantic, agent] In the dw-explore-real workspace's DuckDB build, regexp_replace(x, '[^A-Za-z0-9]', '') only strips whitespace and leaves punctuation like ',' and '.' intact (verified with a literal), so operator-name normalization queries must use nested replace() literal substitutions instead of character-class regex. (m_befbdb0fb832, conf 0.4, evidence: [[runs/2026-09-12T21-53-54]] mail:2026-09-12T21-53-54#13)
