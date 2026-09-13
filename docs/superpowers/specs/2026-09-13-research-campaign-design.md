# Research campaign: deep research on one paper, applied to the warehouse

Date: 2026-09-13. Revision at design time: 0d3ce48. Status: approved design.

## Goal

A campaign that works like deep research: a paper in, rounds of study that build a cited reading of it, rounds that apply its methods to the real warehouse, and one synthesis whose every claim cites a memory record or a page quote and whose oracle checks the citations. First subject: SPE 162910 (Okouma et al., "Practical Considerations for Decline Curve Analysis in Unconventional Reservoirs — Application of Recently Developed Rate-Time Relations"), 61 pages with a text layer; the warehouse offers 84 577 TX and 44 805 NM wells with at least 60 producing months, with rate, months on production and cumulative per row.

## Inputs

- `tasks/research-162910/paper/pages/p01.txt … p61.txt`: one file per page, extracted once by `tasks/research-162910/paper/extract.mjs` (pypdf through uv) and committed. `index.md` lists page → first heading. The PDF is not copied. Equations extract partly garbled; the study spec says so and asks for reconstructions from nomenclature and Appendix A to be labelled interpreted.
- The warehouse snapshot mounted read-only as in `dw-explore-real` (first mount, so the snapshot id matches existing findings), the paper mounted read-only as `paper/`.

## Memory

One scope for the campaign, `repo:research-162910` (each config's `repo`). New config field `memory.extraScopes: string[]`: additional scopes the run may read (seed, `memory_search`, `memory_get`) but never writes to; the apply and synthesis configs add `repo:data-warehousers-real`. Retention writes to the config's own scope as today.

## Shared checkers (`lib/research/`)

- `quotes.mjs`: `loadPages(dir)`, `normalize(text)` (collapse whitespace, unify dashes and quotes, strip soft hyphens), `verifyQuote(pages, page, quote)` → `{ ok, reason }`; a quote must be at least 40 characters and appear in the normalised page text.
- `snippets.mjs`: `checkSnippet(code)` refuses code that imports or names `os`, `sys`, `subprocess`, `socket`, `shutil`, `pathlib`, `open(`, `__import__`, `eval(`, `exec(`, `requests`, `urllib`; `runSnippet(code, { rowsFile, timeoutMs = 10000 })` runs it with `uv run --no-project --python 3.13 --with numpy,scipy python -I -c` in a scratch directory, environment reduced to PATH, stdin closed, and returns `{ stdout, ok, error }`. The snippet reads its rows from the JSON file named in `ROWS` (passed as argv[1]) and prints its result as one JSON line.
- `citations.mjs`: `resolveCitations(indexFile, scopes, ids)` → per id `{ found, claim, status, verified, snapshot }`; `citationRules(claim, records)` → problems: an `observed` claim may cite only records that are `observed` and verified; `interpreted` and `hypothesis` need a settlement criterion; tombstoned or superseded records may not be cited.

## Tasks

### `dw-paper-study` (phase A, rounds 1–2)

Deliverable `src/study.json`: `{ "paper": "SPE 162910", "claims": [ { id, claim, text, quotes: [{ page, text }], checks: [{ id, code, expect }], settlement_criterion? } ], "next_questions": [...] }`, 4–8 claims per round, plus `src/study.md`. Rules the oracle checks: every quote verifies; every check re-runs and prints `expect` (numbers within 1e-6); an observed claim has at least one quote or check; interpreted and hypothesis claims carry a criterion; claims cite at least three distinct pages across the round; ids unique; `next_questions` non-empty. Probe: `["quote", page, text]` and `["check", code, expect]`. Reference: three hand-written claims with real quotes and one check.

### `dw-paper-apply` (phase B, rounds 3–5)

The `dw-explore` contract plus, per observation: `model` in `MH | PLE | SE | DNG | LGM`, `compute: { code, expect }` where the code receives the observation's query rows and prints the fitted parameters as JSON, and `paper_refs: [claim ids or page numbers]`. The checker extends `explore_check.py`: query reproduces (10 s), snippet re-runs on the same rows within 10 s and prints values matching `expect` within 1e-4 relative, model named, claim structure as in slice 1. 5–8 observations. Reference: one NM well with 120 months, an exponential fit by least squares on log rate, deterministic.

### `dw-paper-synthesis` (phase C, once)

Deliverable `src/report.json`: `{ "question": ..., "claims": [ { id, claim, text, cites: [memory ids], quotes: [{ page, text }], settlement_criterion? } ], "unresolved": [...] }` and `src/report.md`. Oracle: every cited id resolves in the pinned index within the allowed scopes; citation rules hold; quotes verify; at least 6 claims, at least 2 observed, `unresolved` non-empty; every claim cites at least one record or quote. Reference: a report citing records from a fixture store (`tasks/dw-paper-synthesis/store`).

## Driver

`tools/research.mjs <name> --study 2 --apply 3`: runs the study config for N rounds, then the apply config for M rounds, then the synthesis config once; between rounds of a phase it applies the campaign runner's novelty brake (same query / same result rows / similar title, over `claims[].text` for study and `observations[].title` for apply); stops a phase early on an oracle failure but still runs the synthesis; writes `docs/batch/research-<name>.md` with per-round rows and the synthesis oracle detail. Logs under `runs/.research-<name>/`.

## Safety of re-executed snippets

Model-written code is re-run host-side by the oracle. The same code already ran inside the guarded workspace as the worker wrote it; the oracle re-run is bounded by the deny-list, isolated mode, a reduced environment, a scratch directory and a 10 s limit. It is not a sandbox; the deny-list is a tripwire, and the report says so.

## Files

New: `tasks/research-162910/paper/{extract.mjs,index.md,pages/}`, `lib/research/{quotes,snippets,citations}.mjs`, `tasks/dw-paper-study/`, `tasks/dw-paper-apply/`, `tasks/dw-paper-synthesis/`, `configs/orch-dw-paper-{study,apply,synthesis}-27b.json`, `tools/research.mjs`, tests. Changed: `lib/config.mjs` (`memory.extraScopes`), `supervisor.mjs` (read scopes), `tools/campaign.mjs` (export the brake), `docs/backlog.md`.
