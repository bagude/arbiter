# Memory as a compiled wiki — design

Date: 2026-09-12. Replaces the flat `memory/<scope>.md` projections and the keyword-scored recall in `lib/memory.mjs` with a Karpathy-style wiki compiled deterministically from the evidence log. No retrieval engine, no embeddings, no graph store: the links are the graph.

## 1. Layers (unchanged in principle)

| layer | what | who vouches |
|---|---|---|
| raw | `runs/<id>/` (audit, bus, lifecycle, summary, transcript) | the supervisor's ledger |
| log | `memory/records.jsonl` — append-only records and ops; the source of truth | oracle evidence promotes; humans rule; agents only propose |
| wiki | `memory/wiki/` — Markdown pages **compiled** from the log and the run summaries; never hand-edited | the compiler (deterministic) |
| rules | contracts, specs, guards with tests | humans; the durable end state of a learning |

## 2. Wiki pages

```
memory/wiki/
  INDEX.md              one line per page, grouped: repos, tasks, global, guards, runs
  SCHEMA.md             how the wiki is organised and what may write where (static)
  LINT.md               the last lint report
  scopes/<scope>.md     global.md, task-<name>.md, repo-<name>.md
  runs/<run-id>.md      one page per run referenced by any record (from runs/<id>/summary.json when present)
  guards/<name>.md      one page per guard seen in any run summary (path, bash_timeout, context_diet…)
```

A scope page has three sections: **Facts** (promoted semantic and procedural records), **History** (promoted episodic records, newest first, each linking `[[runs/<id>]]` and carrying its digest), **Candidates** (unpromoted records with their source and id). A record line is `- <text> (<id>, conf <c>, evidence: [[runs/…]] oracle:… mail:…)`. A run page lists task, pattern, models, outcome, wall time, workers, done attempts, oracle verdicts, guard counts, memory injected, and links back to its scope page and guard pages. A guard page aggregates denies/rewrites per run with links.

Links use `[[relative/path]]` without the `.md` extension. Tombstoned records never appear.

## 3. Operations

- **Ingest** = retention at every `finish()` plus `consolidate()`, then `compileWiki()`. Also `node tools/memory.mjs render`.
- **Recall** = reading pages. `recall({ scopes, budgetChars })` returns, in order: the repo scope page, the task scope page, the global page — each truncated to Facts first, then History newest-first — until the budget is spent; plus the record ids it included (`summary.memory.injected` stays exact). No query scoring.
- **Lint** = `node tools/memory.mjs lint` → `LINT.md`: promoted records without oracle or human backing; evidence pointing at runs that no longer exist on disk; candidates older than 14 days with no verdict; near-duplicate texts across different scopes (possible contradiction or mis-scoping); scope pages with no runs. Lint reports; it never edits the log.
- **Propose** (agents) = unchanged: `kind="memory"` mail becomes a candidate record. Agents never write wiki pages.

## 4. What changes in code

- `lib/wiki.mjs` (new, pure): `buildPages({ records, runSummaries }) → Map<path, markdown>`, `recall({ pages, scopes, budgetChars }) → { text, ids }`, `lint({ records, runSummaries, now }) → findings[]`, `renderLint(findings)`.
- `lib/memory.mjs`: `renderAll(home)` compiles the wiki (reads `runs/*/summary.json`), removes the legacy `memory/<scope>.md`; `project()` and `renderMarkdown()` are deleted.
- `supervisor.mjs`: recall uses `recall()` over freshly compiled pages.
- `tools/memory.mjs`: `render` compiles; `recall <scope…>` shows what an agent gets; `lint` writes and prints the report.
- Tests: `test/wiki.test.mjs` on synthetic records and summaries; memory tests updated.

## 5. Not doing

Embeddings or a vector index (revisit at thousands of pages, as a disposable index over the wiki), a graph database, agent-written canonical pages, per-turn retrieval (a later guard on the `context` edge, if a paired run justifies it).
