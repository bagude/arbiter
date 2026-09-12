# task:tmpl

1 fact(s), 1 run(s) in history, 1 candidate(s). Runs: [[runs/2026-09-12T08-05-48]].

## Facts

- [procedural] tmpl: delegation that passed the oracle — worker 1: Implement `render(template, data)` in `src/tmpl.mjs` (ESM, keep the named export `export function render(template, data) (m_3da9ba563a25, conf 0.7, evidence: [[runs/2026-09-12T08-05-48]] oracle:2026-09-12T08-05-48#1)

## History

- tmpl via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 620.1s; 1 workers, 4 probes, 1 done attempt. Oracle: 64/64. (m_0c170d8eca4d, conf 0.9, evidence: [[runs/2026-09-12T08-05-48]] oracle:2026-09-12T08-05-48#1)

## Candidates

- [semantic, agent] Supervisor probes for render(template, data) require both args present (pass {} for data when testing template errors), and data must be encoded as a raw JSON object in the probe body — a JSON-escaped string data arg is silently treated as a non-owning context frame and renders "", which looks like a code bug but is a probe-encoding error. (m_ce408fac0b17, conf 0.4, evidence: [[runs/2026-09-12T08-05-48]] mail:2026-09-12T08-05-48#5)
