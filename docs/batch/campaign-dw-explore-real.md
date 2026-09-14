# Campaign dw-explore-real — explore ×3 (orch-dw-explore-real-27b.json)

1 round(s) run, 2 skipped, 0.24 h. Brake per phase: oracle failure, or novelty < 0.5 (same query, identical rows, or title Jaccard ≥ 0.4 against everything found before; seeded from 79 finding(s) in 10 run(s) on disk and 81 title(s) in memory). Budget: 331210 of 500000 tokens spent.

| phase | round | run | outcome | wall s | tokens | probes | mem search/get/refused | compactions | findings | novel | novelty |
|---|---|---|---|---|---|---|---|---|---|---|---|
| explore | 1 | 2026-09-14T17-16-44 | SUCCESS: oracle passed | 861.1 | 331210 | 6 | 0/2/0 | 0 | 8 | 6 | 0.75 |
| explore | 2 | — | skipped: remaining 168790 tokens below the median round (331210) | | | | | | | | |
| explore | 3 | — | skipped: remaining 168790 tokens below the median round (331210) | | | | | | | | |

## explore round 1 — 2026-09-14T17-16-44

- O1 [interpreted] NM collapses 99.99% in 2026-01, same pull window as TX's zero-volume tail
- O2 [observed] OK's 1950-2026 history is a single stamped master month, not production history
- O3 [observed] (similar title) days_produced is 100% NULL for all TX rows and all OK master rows
- O4 [observed] Gold passes the contract's structural assertions: no negative volumes, no duplicate keys, no index gaps
- O5 [observed] 7.1M rows belong to wells and leases that never produced; vintage is NULL for exactly them
- O6 [observed] 5.1M decline-curve rows (9.3%) report oil above 100% of the well's initial rate
- O7 [observed] The over-100% decline rows concentrate in wells with healthy initial rates, not tiny denominators
- O8 [observed] (same result) TX production is reported at two grains: 15.5M lease rows and 57.8M well rows in one table

Left open:

- Settle the TX lease-vs-well double-count question: join TX lease rows to well rows on (operator, field_name, month) and measure overlap, to decide whether TX state totals must filter entity_type.
- Check the NM silver parquet (data/real/silver/production/state=NM) and NM bronze manifests for 2025-12 and 2026-01: partial pull or real decline? This settles O1's interpretation.
- Sample over-100% wells with months_on_production > 60 and initial_oil_rate > 10 bbl and inspect their rate trajectories to distinguish re-completions and re-stimulation from reporting corrections (settles m_ab3a0836425f).
- Classify the 43,802 never-producing TX entities by well_status and check how many appear in the 2026-02 zero-volume pull: new leases awaiting first production, or abandoned?
- Verify whether OK's 31,411 IP-test rows reference wells present in the 454,916-row master (api_number overlap), and whether the IP xlsx holds multi-month tests that could be de-stamped into a real OK time series.
- Check the missing TX bronze manifest (the snapshot has no TX bronze directory): can the 2026-02-11 OG_LEASE_CYCLE.dsv zero-volume pull be re-verified against the RRC FTP history, or is a re-pull required?
