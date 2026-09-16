# batch cache-ram-diet

Started 2026-09-16T04:40:50.290Z, finished 2026-09-16T06:29:55.319Z (1.82 h). 2 runs.

| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |
|---|---|---|---|---|---|---|---|---|---|
| raid | 2026-09-16T04-40-50 | SUCCESS: oracle passed | 47/47 | 1629.4 | 114 | 4 | 11 | 1 | bash_timeout:22 |
| raid | 2026-09-16T05-08-01 | stalled: 3 nudges without progress | 46/47 | 4911.4 | 183 | 4 | 35 | 1 | context_diet:148 bash_timeout:46 path:1 |

Successes: 1/2.

## Analysis (2026-09-16, from `node tools/context-trace.mjs <run>`)

Both runs on the 27B with worker thinking off and the launcher's host prompt cache raised from 8 GiB to 24 GiB (`--cache-ram 24576`). The first run is the no-guard baseline; the second is identical except `context_diet: true` (thinking drop + tool-result aging at 6 turns). Reference: `2026-09-15T13-22-13` was the same config as the baseline on the 8 GiB cache.

| run | cache | guards | outcome | orchestrator hit | orch fresh prefill | mean retained (orch) | calls with retained < 0.9 | orch inference s | wall s |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-15T13-22-13 | 8 GiB | none | SUCCESS 47/47 | 0.866 | 415k | — | 4 all-fresh after worker returns | 1261 | 1864 |
| 2026-09-16T04-40-50 | 24 GiB | none | SUCCESS 47/47 | 0.961 | 99k | 0.969 (35 calls) | 1 (post-compaction) | 1109 | 1629 |
| 2026-09-16T05-08-01 | 24 GiB | context_diet | stalled 46/47 | 0.861 | 709k | 0.795 (64 calls) | 36 | 3843 | 4911 |

**Item 1, cache-ram (confirmed):** with 24 GiB the server logged zero prompt-cache evictions during the baseline run (24 in the 8 GiB run), the orchestrator's fresh prefill fell from 415k to 99k tokens, and the only all-fresh call left is the one right after compaction. Keep the setting.

**Item 2, context-diet (confirmed harmful for prefix reuse on this server):** the diet rewrote the orchestrator's history on 63 of 65 calls (2007 thinking blocks dropped, 333 results aged, 1.9M chars ≈ 580k tokens removed from prompts) and in exchange the orchestrator re-prefilled 709k fresh tokens (7× the baseline), because chunk reuse is off on the 27B (q8_0 KV) and every mid-prefix edit invalidates everything after it. Mean prefix retained per call: 0.795 vs 0.969. Inference time 3.5× the baseline; the run also stalled at 46/47. N=1 per arm, and the stall inflates the diet run's call count, but the per-call retained ratio is independent of run length and is the clean signal.

Recommendation: leave `context_diet` off on llama.cpp. If context size must be cut, batch the edits (age many results at once at a checkpoint or compaction boundary) so the prefix stays byte-stable between batches, and prefer worker thinking off (already default in these configs) over post-hoc thinking drops. 14 evictions appeared later in this server session, during the diet run's longer tail (orchestrator peak 127k tokens ≈ 17 GiB at q8_0), so 24 GiB is enough for one large orchestrator plus workers but not much more.
