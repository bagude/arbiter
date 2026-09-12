# data-warehousers: tiered oracles

The user's oil & gas medallion pipeline (`C:\Users\user\Downloads\claude_playground\data-warehousers`, read-only) rebuilt as three arbiter tasks with one oracle per layer. Design: `docs/superpowers/specs/2026-09-12-dw-tiered-oracles-design.md`. Rule: no oracle takes an expected value from the pipeline's own code.

| Tier | Contract | Task | Truth |
|---|---|---|---|
| bronze | `contract-bronze.md` | `tasks/dw-bronze` | the bytes on disk: sha256 against the remote, independent record counts, manifest truth, idempotence |
| silver | `contract-silver.md` | `tasks/dw-silver` | an independent minimal reader over the same bronze (`oracle/reference/silver.py`) plus hand-traced `labels.json` |
| gold | `contract-gold.md` | `tasks/dw-gold` | independent recomputation from oracle-passed silver, 10 assertions, TX county rollup reconciliation |

- Seed: `tools/dw/carve.py` carves a real slice (TX county 421, NM 40 wells, OK Alfalfa) into `tasks/dw-bronze/ws-builder/remote/`; `tasks/dw-seed/CARVE-nm.json` records the carve. Downstream workspaces carry the reference output of the tier below (`dw-silver/ws-builder/data/bronze`, `dw-gold/ws-builder/data/silver`).
- Audit of the real bronze: `bronze-audit-real.md` (15/29 checks pass; TX has no production table, NM wells and production are partial, OK's manifest contradicts its directory).
- Verify all three oracles: `node tools/verify-task.mjs dw-bronze dw-silver dw-gold` (reference passes, stub fails, probe answers).
- Run: `node supervisor.mjs --config configs/orch-dw-<tier>-27b.json`; memory scope `repo:data-warehousers` (`"repo"` in the config).
- Python for agents and oracles: `uv run --no-project --python 3.13 --with-requirements requirements.txt python …` (pins in `tasks/dw-seed/requirements.txt`).

Open decisions for the user (spec §10): re-fetch TX `OG_LEASE_CYCLE`; NM multi-pool ruling (sum, default); OK as wells + completions only (default); the new `wells`/`completions` columns.
