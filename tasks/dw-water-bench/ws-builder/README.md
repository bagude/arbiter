# dw-water-bench workspace

Question: is TX `water_bbl` NULL because the source carries no water column, or because the loader drops it?

- `data/tx/OG_LEASE_CYCLE.header.csv` — the header row of the Texas source file (read-only).
- `data/tx/loader_mapping.json` — which source column the TX loader maps to each warehouse column (read-only).
- `src/finding.json` — the deliverable (see the specification). Write nothing outside `src/`.

Memory is available through `memory_search` and `memory_get`. Search results are references; fetch a record to read it. Verified records had their query reproduced on the named snapshot; interpreted and hypothesis records are not facts.
