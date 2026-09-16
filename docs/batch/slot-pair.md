# Slot pair: one slot vs two unified slots (2026-09-16)

Same task (raid), same config (`configs/orch-raid-27b-bg-compact80k.json`: workers default to background, supervisor compaction at 80k tokens, worker thinking off), same launcher except the 27B preset's `parallel` (1 vs 2 with `kv-unified = true`, `-c 131072` shared). The foreground baseline from `docs/batch/cache-ram-diet.md` is the reference. Numbers from `node tools/context-trace.mjs <run>`; prefill/decode seconds come from llama-server's per-call timings (new in pi as of today), so the baseline has none.

| run | slots | outcome | wall | orch calls | orch hit | orch fresh | mean retained | compactions | worker↔orch overlap | orch output tok | orch prefill s | orch decode s | evictions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 04-40-50 foreground baseline | 1 | pass 47/47 | 27 min | 36 | 0.961 | 99k | 0.969 | 1 | 0 s | 108k | — | — | 0 |
| 11-19-15 A: bg + compact 80k | 1 | pass 47/47 | 60 min | 63 | 0.915 | 339k | 0.910 | 4 | 311 s | 233k | 173 | 2399 | 9 |
| 12-21-21 B: bg + compact 80k | 2 unified | pass 47/47 (2nd claim; one worker failed and was replaced) | 65 min | 91 | 0.914 | 549k | 0.930 | 2 | 89 s | 185k | 315 | 2075 | 8 |

**What the second slot did:** worker-vs-orchestrator queueing overlap fell from 311 s to 89 s and compactions from 4 to 2, but host-cache evictions did not stop (8 vs 9): with a 131k unified pool an orchestrator near 118k plus a worker at 40k+ does not fit, so states still spill to host RAM. Hit ratio and wall time did not improve. N=1 per arm and run B had a failed worker, so treat the direction as suggestive only.

**What the pair actually revealed (decisive):** on this box prefill is a small share of the orchestrator's inference time. Run A: 173 s prefill vs 2399 s decode; run B: 315 s vs 2075 s. Even 549k fresh tokens cost ~5 minutes; generating 185k–233k output tokens cost ~35–40 minutes. The cache work done today (24 GiB host cache, diet removed) fixed the part that was broken, and what remains is output volume: the background-worker configuration doubled the orchestrator's output versus the foreground baseline (233k vs 108k) because it keeps generating while workers run. MTP draft acceptance was 0.66–0.69 in these runs.

**Decisions:** launcher reverted to `parallel = 1` (no `kv-unified`), `cache-ram 24576` kept; `roles.worker.background` stays `false` by default; `compactAtTokens 80000` not adopted. Next lever is decode: fewer and shorter orchestrator turns (probe batching, less narration), not more cache. A short task (glob/semver/lru) should be used for any further infra A/B; raid is for behaviour.
