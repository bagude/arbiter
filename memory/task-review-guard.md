# memory — task:review-guard

## Promoted

- [episodic] review-guard via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 972.5s; 1 workers, 2 probes, 1 done attempt. Oracle: 92/92. (m_49c957e8d786, conf 0.9, evidence: run:2026-09-12T08-24-41, oracle:2026-09-12T08-24-41#1)
- [procedural] review-guard: delegation that passed the oracle — worker 1: You are working in a shared workspace (Windows, cwd is the workspace root). (m_ba374dcffb49, conf 0.7, evidence: run:2026-09-12T08-24-41, oracle:2026-09-12T08-24-41#1)

## Candidates

- [semantic] Keep src/ files-only: the host-side probe runner crashes with EISDIR when a directory (e.g. a junction/symlink to a directory) exists under src/, so demonstration artifacts must be plain files, not links or subdirectories. (m_de2f7c2570c0, conf 0.4, agent)
