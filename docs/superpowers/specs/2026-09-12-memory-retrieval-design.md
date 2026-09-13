# Memory retrieval, slice 1: searchable memory with a shared delivery budget

Date: 2026-09-12. Repository revision at design time: 4235617. Status: approved design, awaiting implementation plan.

## Problem

Runs start by injecting a slice of the memory wiki into the system prompt, bounded by
a character budget (8 000 for the explorer configs). As the ledger grows, more records
compete for the same space and relevant material is displaced. Digests carry
observation titles with no distinction between an observed result, an interpretation,
and an open hypothesis, so a round can inherit an interpretation as settled knowledge.
Observed today: the real-data scope page lists "TX water_bbl is 100% NULL by source
design, not a pipeline drop" as a plain bullet from run 2026-09-12T22-08-57, and rounds
2 and 3 recalled it in that form. Automatic retention writes such records already
marked `promoted` at confidence 0.9, while an agent's own candidate waits at 0.4 for a
human verdict. Two forms of acceptance exist and only one is reviewed.

## Goal

Memory that agents query, with a small startup brief. Three layers:

| Layer | Contains | Access |
|---|---|---|
| Archive | run directories, ledger history, wiki | a person opens a reference; the wiki stays the readable view |
| Searchable memory | one record per finding, procedure, decision, or open question, with scope, snapshot, claim, and verification | `memory_search`, then `memory_get` on chosen ids |
| Working context | assignment, constraints, a seeded brief, retrieval instructions | supplied at startup; retrieval adds to it under a shared budget |

## Scope of this slice

In: the record schema below, a pinned FTS5 index, two agent tools with scope and budget
enforcement, a search-mode startup brief, claim status in the explorer contract, per-
observation retention with separate verification, a legacy migration, and a retrieval
benchmark with its own memory store.

Out (slice 2): working-context checkpoints, compaction or fresh sessions at a phase
boundary, incremental indexing. Retrieved text stays in the conversation until then.

What this slice controls and does not control:

- It bounds the characters memory tools deliver per run. It does not measure model
  context. The run summary reports delivered characters and pi's token counts side by
  side so the two can be compared.
- All budgeted access runs through the extension boundary. Direct reads of the ledger,
  wiki, and index by `read`, `ls`, `grep`, `find`, or `bash` are refused by the existing
  path guard: absolute paths outside the workspace, `..` climbs, and `$ARBITER_HOME`
  indirection are all denied (verified against `lib/path-policy.mjs` at design time). The
  unit tests of this slice pin those five cases so the property is checked, not assumed.

## Record schema

Existing fields stay: `id`, `ts`, `scope`, `kind`, `text`, `evidence`, `confidence`,
`source`, `status`. New fields:

| Field | Written by | Meaning |
|---|---|---|
| `claim` | the author | `observed`, `interpreted`, `hypothesis`, `unreviewed` (legacy narrative), `procedure`, `episode` |
| `settlement_criterion` | the author | required non-empty for `interpreted` and `hypothesis`: what evidence would settle it. Never counts as evidence. |
| `verification` | deterministic code only | `{ query_sha, snapshot, reproduced, by }` where `by` is an oracle reference such as `oracle:<run>#1`. Absent when nothing was verified. |
| `snapshot` | supervisor at launch, stamped by retention | identifier of the data the claim was made against (see below) |
| `summary` | author or retention | one line, at most 160 characters, shown in search results |
| `superseded_by` | migration, consolidation | id of the record that replaced this one; default search skips superseded records |

`status` (candidate, promoted, tombstoned) remains the human-acceptance state and is
orthogonal to `claim`. A record may say `claim: observed` and carry no `verification`;
search results show both so the gap is visible.

Snapshot identifier: for a task with mounts, `<mount name>@<sha256 of the sorted list of
(relative path, size, mtime) under the mount target, first 12 hex>`; for a seed task,
`seed:<task>@<same hash over ws-builder data files>`. The supervisor computes it at
launch, logs it in the audit (`snapshot`) and summary (`summary.snapshot`), and passes it
to the extension as `ARBITER_SNAPSHOT`. Two runs on the same unchanged data share the
identifier; a re-fetched warehouse gets a new one.

## Ledger resolution and index

`lib/memory-index.mjs`:

- `resolveLedger(home)` folds `memory/records.jsonl` into current records: `update` ops
  applied, `promote` and `tombstone` applied to `status`, `superseded_by` honoured.
  Returns `{ revision, records }` where `revision` is the sha256 of the ledger file
  content (first 12 hex).
- `buildIndex(home, resolved)` writes `memory/index/<revision>.sqlite` using
  `node:sqlite` (Node 26; FTS5 with `bm25()` confirmed available). Tables: `records`
  (all fields, JSON for arrays) and an FTS5 virtual table over `summary` and `text` with
  `id` as an unindexed column. Building is idempotent: an existing file for the revision
  is reused.
- `search(indexPath, { query, scopes, kinds, claim, snapshot, allSnapshots, limit })`
  and `get(indexPath, { ids, scopes })` are the only readers, shared by the extension,
  the supervisor's seed, and the CLI.

Build moments: the supervisor before any agent starts, and `tools/memory.mjs index` on
demand. Never inside an agent turn (`DatabaseSync` is synchronous). A run pins its
revision through `ARBITER_MEMORY_INDEX=<path>` for its whole duration; retention at
finish appends to the ledger and the next run resolves the next revision.

## Tools

`ext/memory-ext.ts`, loaded with `-e` for parent roles and from `<workspace>/.pi/extensions/`
for workers (the same route the path guard uses). Both tool names are added to
`ORCHESTRATOR_TOOLS` and `WORKER_TOOLS` in `lib/patterns.mjs`; pi's `--tools` flag and the
worker definition's `tools:` line are allowlists, so registration alone does not expose a
tool.

`memory_search({ query, kinds?, claim?, all_snapshots?, limit? })`, limit at most 10:
returns rows `id · scope · kind · claim · verified (yes/no) · snapshot · compatible (yes/no)
· summary · evidence count · date · score`. Defaults exclude tombstoned, superseded, and
snapshot-incompatible records; `all_snapshots: true` includes historical records, each
row still naming its snapshot. Rows are formatted as plain text, at most 200 characters
each.

`memory_get({ ids })`, at most 5 ids: returns full text, claim, settlement criterion,
verification, evidence references, scope, snapshot. At most 4 000 characters per call;
a record longer than 1 500 characters is truncated with the remaining length stated.

Scope: `ARBITER_MEMORY_SCOPES` (the same list recall uses: `repo:<r>`, `task:<t>`,
`global`) filters both operations. A `get` for an id outside the allowed scopes answers
"not found" so ids cannot be used to read across scopes.

Budget: `ARBITER_MEMORY_BUDGET` characters per run and `ARBITER_MEMORY_LEDGER`, an
append-only JSONL file in the run directory. The supervisor writes the first line for the
startup seed. Each call appends `{ ts, tool, chars, query | ids }`. Before answering, the
extension sums the file; if the answer would exceed the budget it refuses with the
remaining amount and no rows. Because the file is per run, the orchestrator, every
worker, and every resumed worker share one allowance. Each call is also reported through
the guard kit into the lifecycle file so `summary.memory.calls` records
`{ searches, gets, chars, budget, refused }`.

## Startup brief

Config gains `memory.mode`: `inject` (today's behaviour, default) or `search`. In
search mode the memory block of the system prompt is:

1. the assignment and constraints as today (spec, hints);
2. a seeded search of at most 2 000 characters: query = spec title + the text of the
   latest same-scope `question` records; run by the supervisor through `search()` at the
   pinned revision; rows in the search format, prefixed by a line stating the revision,
   the number shown, and the number matched;
3. retrieval instructions: how to search, that ids can be fetched, that rows are
   references and not evidence, and the remaining budget.

The seed's characters are charged to the budget. Workers receive the same block through
the worker definition.

## Explorer contract and oracle

Each observation in `exploration.json` gains `claim` (`observed`, `interpreted`,
`hypothesis`), `settlement_criterion` (required non-empty when claim is not observed),
and optional `evidence_refs` (memory ids consulted). The oracle enforces structure and
reproduction only: observed claims must reproduce from their query (existing check), the
other claims must carry a criterion, evidence refs must resolve in the pinned index. It
emits a per-observation report (`details: [{ index, reproduced, query_sha }]`) that
retention reads. Whether a classification is honest remains judgment; the benchmark tests
it in a controlled fixture. Applies to `dw-explore` and `dw-explore-real`; contract docs
updated.

## Retention

At finish of a passing explorer run, `retainFromRun` writes:

- one `semantic` record per observation: `summary` = title, `text` = title, observation,
  why it matters; `claim` and `settlement_criterion` from the author; `verification` from
  the oracle report; `snapshot` from the run; `evidence` = run and oracle references;
- one `question` record per open question, `claim: hypothesis`, criterion = the question;
- the episodic record as today but without the title digest.

Consolidation keeps merging near-duplicates by text similarity and stays blind to
`claim`, so a merge never changes a classification; when two merged records disagree on
claim, the merged record keeps the weaker one (hypothesis < interpreted < observed) and
lists both in evidence.

Migration: `tools/memory.mjs migrate-digests` emits one `semantic` record per title in
every legacy "Findings digest" episodic record, `claim: unreviewed`, evidence = the
original run, `snapshot` unknown, and appends an update op setting `superseded_by` on
the digest record. Idempotent: a second run emits nothing.

Wiki: the Explorations index renders each finding with its claim and a verified mark;
lint gains a rule flagging `observed` records without `verification`.

## Benchmark: `tasks/dw-water-bench`

Own memory directory (`ARBITER_MEMORY_DIR` override) so the real store is untouched.
Fixture built by `tasks/dw-water-bench/fixture/make.py` from a copy of the real ledger
plus:

- 300 unrelated synthetic records across scopes;
- R1: observed NULL TX water on the compatible snapshot, verified;
- R2: the revealing case, "missing by source design" labelled `observed`, backed only by
  the NULL query, verified reproduction of that query;
- R3: a historical record on an incompatible snapshot claiming water present;
- R4: a loader inspection record whose evidence supports the source explanation (the TX
  source header lacks a water column), worded so the startup seed does not return it; the
  builder runs the seed query and asserts R4 is absent from the top rows;
- R5: a loader record on another snapshot that does not support it.

Workspace: the TX source header file and the loader mapping, so the header fact is
checkable in the run. Deliverable `finding.json`: `claim`, `settlement_criterion`,
`evidence_refs`, `checks` (queries or file inspections with results).

Oracle passes only if: `evidence_refs` include R4 and resolve at the compatible snapshot;
R3 and R5 are not cited as support; the causal claim is not `observed` unless `checks`
contains a reproduced header inspection; the memory call ledger shows at least one `get`
issued from a worker session; `summary.memory.calls.chars` is within budget. The
three measurements: evidence found, unresolved interpretation preserved, budget held.
Each configuration runs three times.

Worker attribution: the extension records the calling session id if pi-subagents
exposes it in the tool context; if it does not, the worker brief requires the fetched
record text to be quoted in the deliverable and the oracle checks it against the ledger.
The implementation plan settles which.

## Testing

Unit: resolver folding; index build and reuse; ranking with scope and snapshot filters;
budget accounting with several concurrent writers; refusal at exhaustion; scope-denied
get answers "not found"; the five path-guard denials for memory paths; explorer contract
checks; retention splitting and verification stamping; consolidation claim rule;
migration idempotence.

Live: one `dw-explore-real` run in search mode compared with the last injection run
(startup characters, calls, oracle result, wall time); then the benchmark, three runs.

## Files

New: `lib/memory-index.mjs`, `ext/memory-ext.ts`, `tasks/dw-water-bench/`,
`test/memory-index.test.mjs`, `test/memory-ext.test.mjs`.
Changed: `lib/memory.mjs`, `lib/wiki.mjs`, `lib/patterns.mjs`, `supervisor.mjs`,
`tools/memory.mjs`, `tasks/dw-explore/oracle/explore_check.py` (shared by
`dw-explore-real`), `docs/dw/contract-explore.md`, `configs/orch-dw-explore-27b.json`,
`configs/orch-dw-explore-real-27b.json`, `docs/backlog.md`.
