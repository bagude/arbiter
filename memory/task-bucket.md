# memory — task:bucket

## Promoted

- [episodic] bucket via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 628.4s; 1 workers, 9 probes, 1 done attempt. Oracle: 53/53. (m_c1096bc60bd6, conf 0.9, evidence: run:2026-09-12T07-04-20, oracle:2026-09-12T07-04-20#1)
- [procedural] bucket: delegation that passed the oracle — worker 1: Implement a token-bucket rate limiter in `src/bucket.mjs` (the only deliverable file; you may also add `src/bucket.test. (m_c2751222844b, conf 0.7, evidence: run:2026-09-12T07-04-20, oracle:2026-09-12T07-04-20#1)

## Candidates

- [semantic] Supervisor probe scripts run in a sandboxed non-module eval (no import statements, no require, no Number.isInfinity), the harness cwd is the arbiter dir not the workspace, but globalThis persists across entries within one probe run — so load the ESM deliverable once via process.getBuiltinModule('node:module').createRequire(process.cwd()+'/p.cjs')('<absolute workspace path>/src/bucket.mjs').createBucket and reuse it in later entries. (m_8822c0fb9f26, conf 0.4, agent)
