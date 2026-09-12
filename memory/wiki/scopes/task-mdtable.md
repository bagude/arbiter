# task:mdtable

2 fact(s), 2 run(s) in history, 0 candidate(s). Runs: [[runs/2026-09-12T07-14-49]].

## Facts

- [semantic] Supervisor probes require an explicit "fn" field per case ("renderTable" or "parseTable") and support expect:{"throws":"<ErrName>"}; identical-args cases are blocked after first probing, so re-verify with fresh equivalent args and surface exact error messages by setting a deliberately-wrong literal expect. (m_482121f731f9, conf 0.4, evidence: [[runs/2026-09-12T07-14-49]] mail:2026-09-12T07-14-49#7)
- [procedural] mdtable: delegation that passed the oracle — worker 1: You are building the deliverable for this task. (m_16982f50a3e2, conf 0.7, evidence: [[runs/2026-09-12T07-14-49]] oracle:2026-09-12T07-14-49#1)

## History

- human verdict on run 2026-09-12T07-14-49: accept — mdtable probe usage notes are accurate (m_47c3f99162a0, conf 0.95, evidence: [[runs/2026-09-12T07-14-49]])
- mdtable via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 657.3s; 1 workers, 6 probes, 1 done attempt. Oracle: 47/47. (m_b01dd794674e, conf 0.9, evidence: [[runs/2026-09-12T07-14-49]] oracle:2026-09-12T07-14-49#1)

## Candidates

(none)
