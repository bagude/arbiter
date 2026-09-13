# Memory Retrieval (slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "inject a slice of the wiki at startup" with memory that agents query through two budgeted tools, records that separate the author's claim from what code verified, and a benchmark that proves retrieval finds evidence and keeps hypotheses unsettled.

**Architecture:** The append-only ledger `memory/records.jsonl` stays the source of truth. A resolver folds it into current records and builds a pinned SQLite FTS5 index per ledger revision. A pi extension (`ext/memory-ext.ts`) exposes `memory_search` and `memory_get` to the orchestrator and to workers, reading that index through pure library code (`lib/memory-index.mjs`, `lib/memory-tools.mjs`) and charging a per-run append-only budget ledger. The supervisor computes a snapshot id, builds the index before agents start, seeds a 2 000-char brief, and at finish retains one record per observation with the oracle's verification stamped separately from the author's claim. A benchmark task with its own memory store measures the result.

**Tech Stack:** Node 26 (`node:sqlite` with FTS5 and `bm25()`), `node:test`, TypeScript pi extensions (loaded by pi with tsx), Python 3.13 via `uv` for the explorer checker, DuckDB for the data.

**Spec:** `docs/superpowers/specs/2026-09-12-memory-retrieval-design.md`

## Global Constraints

- Work in `C:\Users\user\open_harnessess\pi\arbiter` on `master`. Never touch `C:\Users\user\open_harnessess\pi\pi` (the pi checkout) or the data-warehousers repo in Downloads.
- Commit with `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit …`; never write git config. End every commit message with the two attribution lines shown in Task 1 step 6.
- Run tests with `node --test "test/**/*.test.mjs"` from the arbiter directory. All existing tests must keep passing.
- `node:sqlite` prints an ExperimentalWarning on Node 26; that is expected. Suppress it in test runs with `--no-warnings=ExperimentalWarning` if it clutters output.
- Bash heredocs on this Windows Git Bash mangle backslashes; write files with the Write/Edit tools, not heredocs, whenever the content contains a backslash.
- Character budgets are exact values from the spec: search rows at most 200 chars each and at most 10 rows; `memory_get` at most 5 ids, 4 000 chars per call, 1 500 chars per record; startup seed at most 2 000 chars; summary at most 160 chars.
- Claim values: `observed`, `interpreted`, `hypothesis`, `unreviewed`, `procedure`, `episode`. Status values stay `candidate`, `promoted`, `tombstoned`.
- Never build the index inside an agent turn. The supervisor builds it before launching agents; the CLI builds it on demand.
- The path guard must keep refusing `memory/` reads. Task 5 pins that with tests; do not loosen `lib/path-policy.mjs`.

---

## File map

| File | Responsibility |
|---|---|
| `lib/memory.mjs` (modify) | record schema (`claim`, `settlement_criterion`, `verification`, `snapshot`, `summary`, `superseded_by`), `question` kind, fold ops for the new fields, retention per observation, consolidation claim rule |
| `lib/memory-index.mjs` (new) | `resolveLedger`, `indexPath`, `buildIndex`, `search`, `get`, `formatRows`, `formatRecords` |
| `lib/memory-budget.mjs` (new) | append-only per-run budget ledger: `charge`, `spent` |
| `lib/memory-tools.mjs` (new) | pure handlers behind the two tools: `readToolEnv`, `searchTool`, `getTool`, `RETRIEVAL_HINT` |
| `lib/memory-brief.mjs` (new) | `seededBrief` for the search-mode startup block |
| `lib/snapshot.mjs` (new) | `snapshotId({ name, dir })` |
| `ext/memory-ext.ts` (new) | pi extension registering `memory_search` and `memory_get`; thin adapter over `lib/memory-tools.mjs`; reports calls to the lifecycle file |
| `ext/guard-kit.ts` (modify) | add `emit(ev, ctx, data)` for non-guard lifecycle events |
| `lib/workers.mjs` (modify) | fold `memory:*` lifecycle events into `tracker.memory` |
| `lib/patterns.mjs` (modify) | add the two tool names to `ORCHESTRATOR_TOOLS` and `WORKER_TOOLS` |
| `supervisor.mjs` (modify) | snapshot id, index build and pin, search-mode brief, env for the extension, workspace install of the extension, oracle result JSON kept, retention inputs, summary fields, `memoryDir` config override |
| `lib/wiki.mjs` (modify) | Explorations from semantic records with claim and verified marks; lint rule `observed-unverified` |
| `tools/memory.mjs` (modify) | `index`, `search`, `migrate-digests` commands |
| `tools/campaign.mjs` (modify) | seed the novelty tally from semantic record summaries |
| `tasks/dw-explore/oracle/explore_check.py` (modify) | `claim`, `settlement_criterion`, `evidence_refs` checks; `details` per observation |
| `tasks/dw-explore-real/oracle/validate.mjs`, `tasks/dw-explore/oracle/validate.mjs` (modify) | pass `details` through |
| `tasks/dw-explore/spec.md`, `tasks/dw-explore-real/spec.md`, `tasks/dw-explore/worker.md`, `tasks/dw-explore-real/worker.md`, `docs/dw/contract-explore.md` (modify) | the contract change |
| `tasks/dw-water-bench/` (new) | benchmark task: spec, worker.md, ws-builder, oracle, fixture builder, reference |
| `configs/orch-dw-explore-real-27b.json`, `configs/orch-dw-explore-27b.json` (modify), `configs/orch-dw-water-bench-27b.json` (new) | memory mode and budgets |
| `test/memory.test.mjs`, `test/wiki.test.mjs`, `test/path-policy.test.mjs` (modify); `test/memory-index.test.mjs`, `test/memory-budget.test.mjs`, `test/memory-tools.test.mjs`, `test/memory-brief.test.mjs`, `test/snapshot.test.mjs`, `test/workers-memory.test.mjs` (new) | tests |

---

### Task 1: Record schema — claim, settlement criterion, verification, snapshot, summary, superseded_by

**Files:**
- Modify: `lib/memory.mjs:64-118` (`KINDS`, `makeRecord`, `foldLog`)
- Test: `test/memory.test.mjs`

**Interfaces:**
- Produces: `CLAIMS` (array), `makeRecord({ …existing, claim?, settlement_criterion?, verification?, snapshot?, summary?, superseded_by? })`, `summarize(text)` → string ≤ 160 chars, `foldLog` applying `update` ops for `claim`, `verification`, `superseded_by`, `snapshot`, `summary`. `KINDS` gains `"question"`.

- [ ] **Step 1: Write the failing tests**

Append to `test/memory.test.mjs`:

```js
import { CLAIMS, summarize } from "../lib/memory.mjs";

test("makeRecord defaults claim by kind and validates claims and criteria", () => {
	assert.deepEqual(CLAIMS, ["observed", "interpreted", "hypothesis", "unreviewed", "procedure", "episode"]);
	assert.equal(rec({ kind: "episodic" }).claim, "episode");
	assert.equal(rec({ kind: "procedural" }).claim, "procedure");
	assert.equal(rec({ kind: "semantic" }).claim, "unreviewed");
	assert.equal(rec({ kind: "question", claim: "hypothesis", settlement_criterion: "a loader inspection" }).claim, "hypothesis");
	assert.throws(() => rec({ kind: "semantic", claim: "certain" }), /claim/);
	assert.throws(() => rec({ kind: "semantic", claim: "interpreted" }), /settlement_criterion/);
	assert.throws(() => rec({ kind: "semantic", claim: "hypothesis", settlement_criterion: "  " }), /settlement_criterion/);
	const ok = rec({ kind: "semantic", claim: "observed", text: "TX water_bbl is NULL in every row. The loader never sees it.", snapshot: "data-warehousers@abc123def456" });
	assert.equal(ok.settlement_criterion, undefined);
	assert.equal(ok.snapshot, "data-warehousers@abc123def456");
	assert.equal(ok.summary, "TX water_bbl is NULL in every row.");
	assert.equal(ok.verification, undefined);
	assert.equal(ok.superseded_by, undefined);
});

test("summarize keeps the first sentence within 160 chars", () => {
	assert.equal(summarize("Short one. Second sentence."), "Short one.");
	const long = "x".repeat(400);
	assert.equal(summarize(long).length, 160);
	assert.equal(summarize("  padded  "), "padded");
});

test("foldLog applies update ops for claim, verification, superseded_by, snapshot and summary", () => {
	const r = rec({ id: "m_a", kind: "semantic", claim: "observed", text: "t" });
	const folded = foldLog([
		r,
		{ op: "update", id: "m_a", ts: 2, claim: "interpreted", settlement_criterion: "check the loader", verification: { query_sha: "abcd", snapshot: "s@1", reproduced: true, by: "oracle:r1#1" }, snapshot: "s@1", summary: "new summary" },
		{ op: "update", id: "m_a", ts: 3, superseded_by: "m_b" },
		{ op: "update", id: "m_a", ts: 4, claim: "not-a-claim" },
	]);
	const out = folded.get("m_a");
	assert.equal(out.claim, "interpreted", "an invalid claim in an op is ignored");
	assert.equal(out.settlement_criterion, "check the loader");
	assert.deepEqual(out.verification, { query_sha: "abcd", snapshot: "s@1", reproduced: true, by: "oracle:r1#1" });
	assert.equal(out.snapshot, "s@1");
	assert.equal(out.summary, "new summary");
	assert.equal(out.superseded_by, "m_b");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/memory.test.mjs`
Expected: FAIL — `CLAIMS` and `summarize` are not exported; `claim` is undefined on records.

- [ ] **Step 3: Implement the schema**

In `lib/memory.mjs` replace the `KINDS` line and `makeRecord`:

```js
export const KINDS = ["episodic", "semantic", "procedural", "question"];
export const SOURCES = ["supervisor", "oracle", "agent", "human"];
// The author's classification of a finding. Orthogonal to `status` (human acceptance)
// and to `verification` (what deterministic code established).
export const CLAIMS = ["observed", "interpreted", "hypothesis", "unreviewed", "procedure", "episode"];
const DEFAULT_CLAIM = { episodic: "episode", procedural: "procedure", semantic: "unreviewed", question: "hypothesis" };
const NEEDS_CRITERION = new Set(["interpreted", "hypothesis"]);

/** One line for search results: the first sentence, at most 160 characters. */
export function summarize(text) {
	const t = String(text ?? "").trim().replace(/\s+/g, " ");
	const m = /^(.+?[.!?])(\s|$)/.exec(t);
	return (m ? m[1] : t).slice(0, 160);
}

export function makeRecord({ id, scope, kind, text, evidence = [], confidence = 0.5, source, status, ts = Date.now(), claim, settlement_criterion, verification, snapshot, summary, superseded_by }) {
	if (!KINDS.includes(kind)) throw new Error(`memory record kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
	if (!validScope(scope)) throw new Error(`memory record scope must be "global", "task:<name>" or "repo:<name>", got ${JSON.stringify(scope)}`);
	if (!SOURCES.includes(source)) throw new Error(`memory record source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
	const c = claim ?? DEFAULT_CLAIM[kind];
	if (!CLAIMS.includes(c)) throw new Error(`memory record claim must be one of ${CLAIMS.join(", ")}, got ${JSON.stringify(claim)}`);
	const criterion = typeof settlement_criterion === "string" ? settlement_criterion.trim() : "";
	if (NEEDS_CRITERION.has(c) && !criterion) throw new Error(`a ${c} claim needs a non-empty settlement_criterion`);
	const hostVouched = (source === "supervisor" || source === "oracle") && evidence.some((e) => String(e).startsWith("oracle:"));
	return {
		id: id ?? `m_${randomBytes(6).toString("hex")}`,
		ts,
		scope,
		kind,
		text: String(text).trim(),
		summary: summary ? String(summary).trim().slice(0, 160) : summarize(text),
		claim: c,
		...(criterion ? { settlement_criterion: criterion } : {}),
		...(verification ? { verification } : {}),
		...(snapshot ? { snapshot } : {}),
		...(superseded_by ? { superseded_by } : {}),
		evidence: [...evidence],
		confidence,
		source,
		status: status ?? (hostVouched ? "promoted" : "candidate"),
	};
}
```

In `foldLog`, extend the `update` branch:

```js
			else if (entry.op === "update") {
				out.set(entry.id, {
					...r,
					...(Array.isArray(entry.evidence) ? { evidence: [...entry.evidence] } : {}),
					...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
					...(typeof entry.text === "string" ? { text: entry.text } : {}),
					...(typeof entry.scope === "string" && validScope(entry.scope) ? { scope: entry.scope } : {}),
					...(CLAIMS.includes(entry.claim) ? { claim: entry.claim } : {}),
					...(typeof entry.settlement_criterion === "string" ? { settlement_criterion: entry.settlement_criterion } : {}),
					...(entry.verification && typeof entry.verification === "object" ? { verification: entry.verification } : {}),
					...(typeof entry.snapshot === "string" ? { snapshot: entry.snapshot } : {}),
					...(typeof entry.summary === "string" ? { summary: entry.summary.slice(0, 160) } : {}),
					...(typeof entry.superseded_by === "string" ? { superseded_by: entry.superseded_by } : {}),
				});
			}
```

Legacy records on disk have no `claim`; readers must treat a missing claim as `unreviewed` for semantic records and as the kind default otherwise. Add and export:

```js
/** Claim of a record that may predate the field. */
export function claimOf(r) {
	return CLAIMS.includes(r?.claim) ? r.claim : DEFAULT_CLAIM[r?.kind] ?? "unreviewed";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/memory.test.mjs`
Expected: PASS. Then `node --test "test/**/*.test.mjs"` — all pass (existing tests never pass `claim`, so defaults apply).

- [ ] **Step 5: Update the memory schema page**

`lib/wiki.mjs` renders `memory/wiki/SCHEMA.md`; find the schema text (grep `SCHEMA` in `lib/wiki.mjs` or `lib/memory.mjs`) and add one paragraph:

```
claim — the author's classification: observed, interpreted, hypothesis, unreviewed (legacy narrative), procedure, episode. settlement_criterion — for interpreted and hypothesis: what evidence would settle it; never counts as evidence. verification — written only by deterministic code: { query_sha, snapshot, reproduced, by }. snapshot — the data the claim was made against. summary — one line for search results. superseded_by — id of the record that replaced this one; default search skips superseded records. status stays the human-acceptance state and is orthogonal to claim.
```

- [ ] **Step 6: Commit**

```bash
git add lib/memory.mjs lib/wiki.mjs test/memory.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: record schema gains claim, settlement_criterion, verification, snapshot, summary, superseded_by; question kind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 2: Ledger resolver and pinned FTS5 index

**Files:**
- Create: `lib/memory-index.mjs`
- Test: `test/memory-index.test.mjs`

**Interfaces:**
- Consumes: `foldLog`, `readLog`, `claimOf` from `lib/memory.mjs`.
- Produces:
  - `resolveLedger(logFile)` → `{ revision: string, records: Map<id, record> }`; revision = first 12 hex of sha256 of the file bytes, `"empty"` when the file is missing or empty.
  - `indexPath(memoryDir, revision)` → `<memoryDir>/index/<revision>.sqlite`.
  - `buildIndex(memoryDir, resolved)` → the index path; no-op when the file exists.
  - `search(indexFile, { query, scopes, kinds = null, claim = null, snapshot = null, allSnapshots = false, limit = 10 })` → `Row[]` where `Row = { id, scope, kind, claim, verified: boolean, snapshot: string|null, compatible: "yes"|"no"|"unknown", summary, evidenceCount, ts, score }`.
  - `get(indexFile, { ids, scopes })` → `record[]` (full records, only those inside `scopes`, in the order requested, missing ids skipped).
  - `formatRows(rows)` → string, one line per row, each line ≤ 200 chars.
  - `formatRecords(records, { perRecord = 1500, total = 4000 })` → string.
  - `ftsQuery(text)` → the FTS5 MATCH expression (terms OR-joined, quoted).

- [ ] **Step 1: Write the failing tests**

Create `test/memory-index.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, indexPath, buildIndex, search, get, formatRows, formatRecords, ftsQuery } from "../lib/memory-index.mjs";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-index-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@aaaaaaaaaaaa";
	const rec = (over) => makeRecord({ scope: "repo:dw", kind: "semantic", source: "supervisor", confidence: 0.9, evidence: ["run:r1", "oracle:r1#1"], ts: 1000, ...over });
	appendLog(log, [
		rec({ id: "m_null", claim: "observed", text: "TX water_bbl is 100% NULL in every production_monthly row.", snapshot: S, verification: { query_sha: "q1", snapshot: S, reproduced: true, by: "oracle:r1#1" } }),
		rec({ id: "m_design", claim: "observed", text: "TX water is missing by source design, not a loader drop.", snapshot: S }),
		rec({ id: "m_old", claim: "observed", text: "TX water_bbl carried values in the 2025 pull.", snapshot: "dw@bbbbbbbbbbbb" }),
		rec({ id: "m_loader", claim: "interpreted", settlement_criterion: "compare the OG_LEASE_CYCLE header with the loader mapping", text: "The loader maps water_bbl from a column the OG_LEASE_CYCLE header does not carry.", snapshot: S }),
		rec({ id: "m_legacy", text: "NM gas concentrates in three counties." }),
		rec({ id: "m_other", scope: "task:orbit", claim: "observed", text: "orbit stage 3 water loop converges." }),
		rec({ id: "m_q", kind: "question", claim: "hypothesis", settlement_criterion: "inspect the loader", text: "Is TX water dropped by the loader?" }),
		{ op: "tombstone", id: "m_old", ts: 2000, reason: "stale" },
		{ op: "update", id: "m_legacy", ts: 2001, superseded_by: "m_null" },
	]);
	return { dir, log, S };
}

test("resolveLedger folds ops and hashes the file; buildIndex is idempotent", () => {
	const { dir, log } = fixture();
	const resolved = resolveLedger(log);
	assert.match(resolved.revision, /^[0-9a-f]{12}$/);
	assert.equal(resolved.records.get("m_old").status, "tombstoned");
	assert.equal(resolved.records.get("m_legacy").superseded_by, "m_null");
	assert.equal(resolveLedger(path.join(dir, "missing.jsonl")).revision, "empty");
	const p = buildIndex(dir, resolved);
	assert.equal(p, indexPath(dir, resolved.revision));
	assert.ok(fs.existsSync(p));
	const mtime = fs.statSync(p).mtimeMs;
	assert.equal(buildIndex(dir, resolved), p);
	assert.equal(fs.statSync(p).mtimeMs, mtime, "an existing index is reused");
});

test("ftsQuery quotes and OR-joins terms and drops punctuation", () => {
	assert.equal(ftsQuery('TX water_bbl NULL: source or loader?'), '"tx" OR "water_bbl" OR "null" OR "source" OR "or" OR "loader"');
	assert.equal(ftsQuery(""), "");
});

test("search ranks by bm25, filters scope, skips tombstoned and superseded, flags snapshots", () => {
	const { dir, log, S } = fixture();
	const p = buildIndex(dir, resolveLedger(log));
	const rows = search(p, { query: "TX water loader", scopes: ["repo:dw"], snapshot: S });
	const ids = rows.map((r) => r.id);
	assert.ok(ids.includes("m_null") && ids.includes("m_design") && ids.includes("m_loader"));
	assert.ok(!ids.includes("m_old"), "tombstoned records are skipped");
	assert.ok(!ids.includes("m_legacy"), "superseded records are skipped");
	assert.ok(!ids.includes("m_other"), "scope filter applies");
	const nullRow = rows.find((r) => r.id === "m_null");
	assert.equal(nullRow.verified, true);
	assert.equal(nullRow.compatible, "yes");
	assert.equal(rows.find((r) => r.id === "m_design").verified, false, "claim observed without verification shows unverified");
	const qRow = search(p, { query: "loader", scopes: ["repo:dw"], snapshot: S }).find((r) => r.id === "m_q");
	assert.equal(qRow.compatible, "unknown", "a record without a snapshot is unknown, not excluded");
	assert.equal(search(p, { query: "water", scopes: ["repo:dw"], snapshot: S, kinds: ["question"] }).map((r) => r.id).join(), "m_q");
	assert.equal(search(p, { query: "water", scopes: ["repo:dw"], snapshot: S, claim: "interpreted" }).map((r) => r.id).join(), "m_loader");
	assert.equal(search(p, { query: "water", scopes: ["repo:dw"], snapshot: S, limit: 1 }).length, 1);
	assert.equal(search(p, { query: "", scopes: ["repo:dw"] }).length, 0);
});

test("search excludes incompatible snapshots unless allSnapshots, and then names them", () => {
	const { dir, log, S } = fixture();
	appendLog(log, [makeRecord({ id: "m_hist", scope: "repo:dw", kind: "semantic", source: "supervisor", claim: "observed", text: "TX water_bbl carried values in the 2024 pull.", snapshot: "dw@cccccccccccc", ts: 3000 })]);
	const p = buildIndex(dir, resolveLedger(log));
	assert.ok(!search(p, { query: "water", scopes: ["repo:dw"], snapshot: S }).some((r) => r.id === "m_hist"));
	const withAll = search(p, { query: "water", scopes: ["repo:dw"], snapshot: S, allSnapshots: true }).find((r) => r.id === "m_hist");
	assert.equal(withAll.compatible, "no");
	assert.equal(withAll.snapshot, "dw@cccccccccccc");
});

test("get returns full records inside the allowed scopes only, in request order", () => {
	const { dir, log } = fixture();
	const p = buildIndex(dir, resolveLedger(log));
	const out = get(p, { ids: ["m_loader", "m_other", "m_nope", "m_null"], scopes: ["repo:dw"] });
	assert.deepEqual(out.map((r) => r.id), ["m_loader", "m_null"]);
	assert.equal(out[0].settlement_criterion, "compare the OG_LEASE_CYCLE header with the loader mapping");
	assert.deepEqual(out[1].verification, { query_sha: "q1", snapshot: "dw@aaaaaaaaaaaa", reproduced: true, by: "oracle:r1#1" });
	assert.deepEqual(out[1].evidence, ["run:r1", "oracle:r1#1"]);
});

test("formatRows and formatRecords respect the character limits", () => {
	const { dir, log, S } = fixture();
	const p = buildIndex(dir, resolveLedger(log));
	const text = formatRows(search(p, { query: "water", scopes: ["repo:dw"], snapshot: S }));
	for (const line of text.split("\n")) assert.ok(line.length <= 200, line);
	assert.match(text, /m_null · repo:dw · semantic · observed · verified · dw@aaaaaaaaaaaa · compatible · TX water_bbl is 100% NULL/);
	assert.match(text, /m_design · repo:dw · semantic · observed · unverified/);
	const big = makeRecord({ id: "m_big", scope: "repo:dw", kind: "semantic", source: "human", text: "y".repeat(5000), ts: 1 });
	const out = formatRecords([big, big, big], { perRecord: 1500, total: 4000 });
	assert.ok(out.length <= 4000, `total ${out.length}`);
	assert.match(out, /\(truncated; 3500 more chars\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/memory-index.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/memory-index.mjs`**

```js
// Searchable memory: the append-only ledger resolved into current records and
// indexed in SQLite FTS5, one file per ledger revision. A run pins one revision so
// search results cannot shift mid-investigation; the file is built by the supervisor
// before agents start or by the CLI — never inside an agent turn (DatabaseSync is
// synchronous). Readers: the extension (ext/memory-ext.ts), the supervisor's seeded
// brief, and tools/memory.mjs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { foldLog, readLog, claimOf } from "./memory.mjs";

export function resolveLedger(logFile) {
	if (!fs.existsSync(logFile)) return { revision: "empty", records: new Map() };
	const bytes = fs.readFileSync(logFile);
	if (!bytes.length) return { revision: "empty", records: new Map() };
	const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	return { revision, records: foldLog(readLog(logFile)) };
}

export function indexPath(memoryDir, revision) {
	return path.join(memoryDir, "index", `${revision}.sqlite`);
}

const SCHEMA = `
CREATE TABLE records (
  id TEXT PRIMARY KEY, scope TEXT, kind TEXT, claim TEXT, status TEXT, snapshot TEXT,
  summary TEXT, text TEXT, ts INTEGER, evidence TEXT, verification TEXT,
  settlement_criterion TEXT, superseded_by TEXT, source TEXT, confidence REAL, extra TEXT
);
CREATE VIRTUAL TABLE fts USING fts5(summary, text, id UNINDEXED);
`;

export function buildIndex(memoryDir, { revision, records }) {
	const file = indexPath(memoryDir, revision);
	if (fs.existsSync(file)) return file;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const db = new DatabaseSync(tmp);
	db.exec(SCHEMA);
	const ins = db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
	const fts = db.prepare("INSERT INTO fts (summary, text, id) VALUES (?,?,?)");
	db.exec("BEGIN");
	for (const r of records.values()) {
		const { id, scope, kind, status, snapshot, summary, text, ts, evidence, verification, settlement_criterion, superseded_by, source, confidence, ...extra } = r;
		delete extra.claim;
		ins.run(id, scope, kind, claimOf(r), status ?? "candidate", snapshot ?? null, summary ?? "", text ?? "", ts ?? 0, JSON.stringify(evidence ?? []), verification ? JSON.stringify(verification) : null, settlement_criterion ?? null, superseded_by ?? null, source ?? "", confidence ?? 0, JSON.stringify(extra));
		fts.run(summary ?? "", text ?? "", id);
	}
	db.exec("COMMIT");
	db.close();
	fs.renameSync(tmp, file);
	return file;
}

export function ftsQuery(text) {
	const terms = String(text ?? "").toLowerCase().match(/[a-z0-9_%.]+/g) ?? [];
	return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function rowToRecord(row) {
	const extra = row.extra ? JSON.parse(row.extra) : {};
	return {
		...extra,
		id: row.id, scope: row.scope, kind: row.kind, claim: row.claim, status: row.status,
		...(row.snapshot ? { snapshot: row.snapshot } : {}),
		summary: row.summary, text: row.text, ts: row.ts,
		evidence: JSON.parse(row.evidence || "[]"),
		...(row.verification ? { verification: JSON.parse(row.verification) } : {}),
		...(row.settlement_criterion ? { settlement_criterion: row.settlement_criterion } : {}),
		...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
		source: row.source, confidence: row.confidence,
	};
}

function compatibility(recordSnapshot, snapshot) {
	if (!recordSnapshot) return "unknown";
	if (!snapshot) return "unknown";
	return recordSnapshot === snapshot ? "yes" : "no";
}

export function search(indexFile, { query, scopes, kinds = null, claim = null, snapshot = null, allSnapshots = false, limit = 10 }) {
	const match = ftsQuery(query);
	if (!match || !Array.isArray(scopes) || !scopes.length) return [];
	const db = new DatabaseSync(indexFile, { readOnly: true });
	const where = [`fts MATCH ?`, `r.scope IN (${scopes.map(() => "?").join(",")})`, `r.status != 'tombstoned'`, `r.superseded_by IS NULL`];
	const args = [match, ...scopes];
	if (Array.isArray(kinds) && kinds.length) { where.push(`r.kind IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
	if (claim) { where.push(`r.claim = ?`); args.push(claim); }
	const sql = `SELECT r.*, bm25(fts) AS score FROM fts JOIN records r ON r.id = fts.id WHERE ${where.join(" AND ")} ORDER BY score, r.ts DESC LIMIT ?`;
	const n = Math.max(1, Math.min(10, Number(limit) || 10));
	// Over-fetch so a snapshot filter applied in JS still fills the page.
	const rows = db.prepare(sql).all(...args, allSnapshots ? n : n * 4);
	db.close();
	const out = [];
	for (const row of rows) {
		const compatible = compatibility(row.snapshot, snapshot);
		if (!allSnapshots && compatible === "no") continue;
		out.push({
			id: row.id, scope: row.scope, kind: row.kind, claim: row.claim,
			verified: Boolean(row.verification && JSON.parse(row.verification).reproduced),
			snapshot: row.snapshot ?? null, compatible,
			summary: row.summary, evidenceCount: JSON.parse(row.evidence || "[]").length, ts: row.ts, score: row.score,
		});
		if (out.length >= n) break;
	}
	return out;
}

export function get(indexFile, { ids, scopes }) {
	if (!Array.isArray(ids) || !ids.length || !Array.isArray(scopes) || !scopes.length) return [];
	const db = new DatabaseSync(indexFile, { readOnly: true });
	const stmt = db.prepare(`SELECT * FROM records WHERE id = ? AND scope IN (${scopes.map(() => "?").join(",")})`);
	const out = [];
	for (const id of ids.slice(0, 5)) {
		const row = stmt.get(String(id), ...scopes);
		if (row) out.push(rowToRecord(row));
	}
	db.close();
	return out;
}

export function formatRows(rows) {
	return rows
		.map((r) => {
			const date = r.ts ? new Date(r.ts).toISOString().slice(0, 10) : "?";
			const compat = r.compatible === "yes" ? "compatible" : r.compatible === "no" ? "OTHER SNAPSHOT" : "snapshot unknown";
			const head = `${r.id} · ${r.scope} · ${r.kind} · ${r.claim} · ${r.verified ? "verified" : "unverified"} · ${r.snapshot ?? "-"} · ${compat} · `;
			const tail = ` · ${r.evidenceCount} ev · ${date}`;
			return `${head}${r.summary.slice(0, Math.max(0, 200 - head.length - tail.length))}${tail}`.slice(0, 200);
		})
		.join("\n");
}

export function formatRecords(records, { perRecord = 1500, total = 4000 } = {}) {
	const parts = [];
	let used = 0;
	for (const r of records) {
		const body = r.text.length > perRecord ? `${r.text.slice(0, perRecord)} (truncated; ${r.text.length - perRecord} more chars)` : r.text;
		const block = [
			`### ${r.id} · ${r.scope} · ${r.kind} · claim: ${r.claim}${r.snapshot ? ` · snapshot: ${r.snapshot}` : ""}`,
			r.verification ? `verification: ${JSON.stringify(r.verification)}` : "verification: none",
			r.settlement_criterion ? `settlement_criterion: ${r.settlement_criterion}` : "",
			`evidence: ${r.evidence.join(", ") || "none"}`,
			body,
		].filter(Boolean).join("\n");
		if (used + block.length + 2 > total) {
			parts.push(`(budget for this call reached; ${records.length - parts.length} record(s) not shown)`);
			break;
		}
		parts.push(block);
		used += block.length + 2;
	}
	return parts.join("\n\n").slice(0, total);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/memory-index.test.mjs`
Expected: PASS (an ExperimentalWarning about `node:sqlite` is expected on stderr).

- [ ] **Step 5: Commit**

```bash
git add lib/memory-index.mjs test/memory-index.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: ledger resolver and pinned FTS5 index with scope, claim, kind and snapshot filters

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 3: Per-run budget ledger

**Files:**
- Create: `lib/memory-budget.mjs`
- Test: `test/memory-budget.test.mjs`

**Interfaces:**
- Produces: `charge(ledgerFile, { role, tool, chars, detail })` appends one JSON line and returns the new total; `spent(ledgerFile)` → `{ chars, calls: { search, get, seed }, refused, byRole: { [role]: chars } }`; `wouldExceed(ledgerFile, budget, chars)` → boolean.

- [ ] **Step 1: Write the failing tests**

Create `test/memory-budget.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { charge, spent, wouldExceed } from "../lib/memory-budget.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-budget-")), "memory-calls.jsonl");

test("charge appends and spent sums by tool and role; refusals are counted, not charged", () => {
	const f = tmp();
	assert.equal(spent(f).chars, 0, "a missing ledger is empty");
	assert.equal(charge(f, { role: "supervisor", tool: "seed", chars: 1200, detail: "seeded brief" }), 1200);
	assert.equal(charge(f, { role: "orchestrator", tool: "search", chars: 800, detail: "TX water loader" }), 2000);
	assert.equal(charge(f, { role: "worker:854e28b7", tool: "get", chars: 3000, detail: "m_a,m_b" }), 5000);
	charge(f, { role: "worker:854e28b7", tool: "refused", chars: 0, detail: "get m_c" });
	const s = spent(f);
	assert.equal(s.chars, 5000);
	assert.deepEqual(s.calls, { search: 1, get: 1, seed: 1 });
	assert.equal(s.refused, 1);
	assert.deepEqual(s.byRole, { supervisor: 1200, orchestrator: 800, "worker:854e28b7": 3000 });
	assert.equal(wouldExceed(f, 6000, 1000), false);
	assert.equal(wouldExceed(f, 6000, 1001), true);
});

test("several processes appending concurrently lose nothing", () => {
	const f = tmp();
	const script = `import { charge } from ${JSON.stringify(new URL("../lib/memory-budget.mjs", import.meta.url).href)}; for (let i = 0; i < 200; i++) charge(${JSON.stringify(f)}, { role: process.argv[1], tool: "get", chars: 1, detail: "" });`;
	const kids = ["a", "b", "c"].map((name) => spawnSync(process.execPath, ["--input-type=module", "-e", script, name], { encoding: "utf8" }));
	for (const k of kids) assert.equal(k.status, 0, k.stderr);
	assert.equal(spent(f).chars, 600);
	assert.equal(fs.readFileSync(f, "utf8").trim().split("\n").length, 600);
});
```

Note: the concurrent test spawns processes sequentially with `spawnSync`, so it proves each appender leaves whole lines; true simultaneity is exercised in the live run of Task 10.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/memory-budget.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/memory-budget.mjs`**

```js
// The run's memory delivery budget: one append-only JSONL file in the run directory.
// The supervisor charges the startup seed; every memory tool call appends what it
// delivered. Because the file is per run, the orchestrator, every worker and every
// resumed worker share one allowance, whichever process they run in. Characters are a
// delivery budget, not a context measurement.
import fs from "node:fs";

export function charge(ledgerFile, { role, tool, chars, detail = "" }) {
	fs.appendFileSync(ledgerFile, `${JSON.stringify({ ts: Date.now(), role: String(role ?? "unknown"), tool, chars: Number(chars) || 0, detail: String(detail).slice(0, 200) })}\n`);
	return spent(ledgerFile).chars;
}

export function spent(ledgerFile) {
	const out = { chars: 0, calls: {}, refused: 0, byRole: {} };
	if (!fs.existsSync(ledgerFile)) return out;
	for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.tool === "refused") {
			out.refused++;
			continue;
		}
		out.chars += e.chars;
		out.calls[e.tool] = (out.calls[e.tool] ?? 0) + 1;
		out.byRole[e.role] = (out.byRole[e.role] ?? 0) + e.chars;
	}
	return out;
}

export function wouldExceed(ledgerFile, budget, chars) {
	return spent(ledgerFile).chars + chars > budget;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/memory-budget.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/memory-budget.mjs test/memory-budget.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: per-run append-only delivery budget ledger shared across roles and sessions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 4: Tool handlers and the pi extension

**Files:**
- Create: `lib/memory-tools.mjs`, `ext/memory-ext.ts`
- Modify: `ext/guard-kit.ts:42-46` (add `emit`), `lib/workers.mjs:139-153` (fold `memory:*` events), `lib/workers.mjs:34-40` (`tracker.memory`)
- Test: `test/memory-tools.test.mjs`, `test/workers-memory.test.mjs`

**Interfaces:**
- Consumes: `search`, `get`, `formatRows`, `formatRecords` (Task 2); `charge`, `spent`, `wouldExceed` (Task 3); `report`/`roleFor` from `ext/guard-kit.ts`.
- Produces:
  - `readToolEnv(env)` → `{ indexFile, scopes: string[], budget: number, ledger: string, snapshot: string|null }` or `null` when `ARBITER_MEMORY_INDEX` is unset.
  - `searchTool(cfg, params, role)` → `{ text, chars, refused: boolean, rows: number }`.
  - `getTool(cfg, params, role)` → `{ text, chars, refused: boolean, records: number }`.
  - `RETRIEVAL_HINT` string (used by the brief in Task 6 too).
  - Lifecycle events `memory:search`, `memory:get`, `memory:refused` with `{ role, chars, detail }`; `tracker.memory = { searches, gets, refused, chars, byRole }`.

- [ ] **Step 1: Write the failing tests for the handlers**

Create `test/memory-tools.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";
import { spent } from "../lib/memory-budget.mjs";
import { readToolEnv, searchTool, getTool, RETRIEVAL_HINT } from "../lib/memory-tools.mjs";

function env(budget = 6000) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-tools-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@aaaaaaaaaaaa";
	const rec = (over) => makeRecord({ scope: "repo:dw", kind: "semantic", source: "supervisor", ts: 1000, evidence: ["run:r1", "oracle:r1#1"], ...over });
	appendLog(log, [
		rec({ id: "m_null", claim: "observed", text: "TX water_bbl is 100% NULL in every row.", snapshot: S, verification: { query_sha: "q", snapshot: S, reproduced: true, by: "oracle:r1#1" } }),
		rec({ id: "m_loader", claim: "interpreted", settlement_criterion: "compare header and loader", text: "The loader maps water_bbl from a column the header lacks. ".repeat(40), snapshot: S }),
		rec({ id: "m_other", scope: "task:orbit", claim: "observed", text: "orbit water loop." }),
	]);
	const indexFile = buildIndex(dir, resolveLedger(log));
	const ledger = path.join(dir, "memory-calls.jsonl");
	return { dir, ledger, cfg: readToolEnv({ ARBITER_MEMORY_INDEX: indexFile, ARBITER_MEMORY_SCOPES: JSON.stringify(["repo:dw", "global"]), ARBITER_MEMORY_BUDGET: String(budget), ARBITER_MEMORY_LEDGER: ledger, ARBITER_SNAPSHOT: S }) };
}

test("readToolEnv parses the environment and is null without an index", () => {
	assert.equal(readToolEnv({}), null);
	const { cfg } = env();
	assert.deepEqual(cfg.scopes, ["repo:dw", "global"]);
	assert.equal(cfg.budget, 6000);
	assert.equal(cfg.snapshot, "dw@aaaaaaaaaaaa");
	assert.ok(RETRIEVAL_HINT.includes("memory_search") && RETRIEVAL_HINT.includes("memory_get"));
});

test("searchTool returns formatted rows, charges the ledger, and enforces scope", () => {
	const { cfg, ledger } = env();
	const r = searchTool(cfg, { query: "TX water loader" }, "orchestrator");
	assert.equal(r.refused, false);
	assert.equal(r.rows, 2);
	assert.match(r.text, /m_null · repo:dw/);
	assert.ok(!r.text.includes("m_other"));
	assert.equal(r.chars, r.text.length);
	assert.equal(spent(ledger).chars, r.chars);
	assert.deepEqual(spent(ledger).byRole, { orchestrator: r.chars });
	const none = searchTool(cfg, { query: "zzzz" }, "orchestrator");
	assert.equal(none.rows, 0);
	assert.match(none.text, /no matching records/);
});

test("getTool returns full records within scope, answers not found across scope, and truncates", () => {
	const { cfg } = env();
	const r = getTool(cfg, { ids: ["m_loader", "m_other", "m_nope"] }, "worker:x");
	assert.equal(r.records, 1);
	assert.match(r.text, /### m_loader/);
	assert.match(r.text, /settlement_criterion: compare header and loader/);
	assert.match(r.text, /not found: m_other, m_nope/);
	assert.ok(r.text.length <= 4000);
	assert.match(r.text, /truncated; \d+ more chars/);
	assert.equal(getTool(cfg, { ids: [] }, "worker:x").text, "no ids given");
});

test("the budget is shared and refusals deliver nothing", () => {
	const { cfg, ledger } = env(900);
	const first = searchTool(cfg, { query: "water" }, "orchestrator");
	assert.equal(first.refused, false);
	const second = getTool(cfg, { ids: ["m_loader"] }, "worker:y");
	assert.equal(second.refused, true, "a fresh worker does not reset the allowance");
	assert.match(second.text, /memory budget: \d+ of 900 characters used/);
	assert.equal(second.chars, 0);
	assert.equal(spent(ledger).chars, first.chars);
	assert.equal(spent(ledger).refused, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/memory-tools.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/memory-tools.mjs`**

```js
// The two memory tools' behaviour, kept pure so it is unit-tested without pi:
// ext/memory-ext.ts is a thin adapter. Scope and budget are enforced here, on every
// call, from the environment the supervisor set.
import { search, get, formatRows, formatRecords } from "./memory-index.mjs";
import { charge, spent, wouldExceed } from "./memory-budget.mjs";

export const RETRIEVAL_HINT =
	"Memory is searchable. memory_search(query) lists matching records (id, scope, kind, claim, verified or not, snapshot, one-line summary); rows are references, not evidence. memory_get(ids) returns the full text, claim, settlement criterion, verification and evidence of up to 5 records. Both draw on one per-run character budget shared by every agent in the run; the tools state what remains. A claim marked 'verified' had its query reproduced by the oracle on the named snapshot; 'unverified' means nobody checked. interpreted and hypothesis records are not facts: their settlement_criterion says what would settle them.";

export function readToolEnv(env) {
	if (!env.ARBITER_MEMORY_INDEX) return null;
	let scopes = [];
	try {
		scopes = JSON.parse(env.ARBITER_MEMORY_SCOPES || "[]");
	} catch {
		scopes = [];
	}
	return {
		indexFile: env.ARBITER_MEMORY_INDEX,
		scopes,
		budget: Number(env.ARBITER_MEMORY_BUDGET) || 0,
		ledger: env.ARBITER_MEMORY_LEDGER || "",
		snapshot: env.ARBITER_MEMORY_SNAPSHOT || env.ARBITER_SNAPSHOT || null,
	};
}

function refusal(cfg, role, detail) {
	const s = spent(cfg.ledger);
	if (cfg.ledger) charge(cfg.ledger, { role, tool: "refused", chars: 0, detail });
	return { text: `memory budget: ${s.chars} of ${cfg.budget} characters used; this call would exceed it, so nothing was returned. Work from what you already retrieved.`, chars: 0, refused: true };
}

function deliver(cfg, role, tool, text, detail) {
	if (cfg.ledger && wouldExceed(cfg.ledger, cfg.budget, text.length)) return refusal(cfg, role, detail);
	const total = cfg.ledger ? charge(cfg.ledger, { role, tool, chars: text.length, detail }) : text.length;
	return { text: `${text}\n(memory budget: ${total} of ${cfg.budget} characters used)`, chars: text.length, refused: false };
}

export function searchTool(cfg, params, role) {
	const query = String(params?.query ?? "").trim();
	if (!query) return { text: "no query given", chars: 0, refused: false, rows: 0 };
	const rows = search(cfg.indexFile, {
		query,
		scopes: cfg.scopes,
		kinds: Array.isArray(params?.kinds) && params.kinds.length ? params.kinds : null,
		claim: params?.claim || null,
		snapshot: cfg.snapshot,
		allSnapshots: Boolean(params?.all_snapshots),
		limit: params?.limit ?? 10,
	});
	const body = rows.length ? formatRows(rows) : `no matching records for "${query}" in scopes ${cfg.scopes.join(", ")}`;
	return { ...deliver(cfg, role, "search", body, query), rows: rows.length };
}

export function getTool(cfg, params, role) {
	const ids = Array.isArray(params?.ids) ? params.ids.map(String).slice(0, 5) : [];
	if (!ids.length) return { text: "no ids given", chars: 0, refused: false, records: 0 };
	const records = get(cfg.indexFile, { ids, scopes: cfg.scopes });
	const found = new Set(records.map((r) => r.id));
	const missing = ids.filter((id) => !found.has(id));
	let body = records.length ? formatRecords(records, { perRecord: 1500, total: 3800 }) : "";
	if (missing.length) body += `${body ? "\n\n" : ""}not found: ${missing.join(", ")}`;
	return { ...deliver(cfg, role, "get", body, ids.join(",")), records: records.length };
}
```

(`formatRecords` is capped at 3 800 so the budget footer keeps the whole reply under 4 000.)

- [ ] **Step 4: Run the handler tests to verify they pass**

Run: `node --test test/memory-tools.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add `emit` to the guard kit**

In `ext/guard-kit.ts`, after `report`:

```ts
/** Append an arbitrary lifecycle event `{ role, ...data }` (no-op when unset). Used by the memory tools. */
export function emit(ev: string, ctx: Parameters<typeof roleFor>[0], data: Record<string, unknown>): void {
	if (!OUT) return;
	fs.appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), ev, data: { role: roleFor(ctx), ...data } })}\n`);
}
```

- [ ] **Step 6: Write the failing test for lifecycle folding**

Create `test/workers-memory.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker, applyLifecycleEvent } from "../lib/workers.mjs";

test("memory:* lifecycle events are tallied on the tracker and never decide anything", () => {
	const tracker = createTracker();
	const state = {};
	const timeline = [];
	const a = applyLifecycleEvent(tracker, state, timeline, { ev: "memory:search", data: { role: "orchestrator", chars: 812, detail: "TX water loader" }, now: 1 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "memory:get", data: { role: "worker:abc", chars: 2400, detail: "m_a,m_b" }, now: 2 });
	applyLifecycleEvent(tracker, state, timeline, { ev: "memory:refused", data: { role: "worker:abc", chars: 0, detail: "m_c" }, now: 3 });
	assert.equal(a.decision, null);
	assert.equal(a.audit[0].type, "memory");
	assert.match(a.audit[0].msg, /search 812 chars: TX water loader/);
	assert.deepEqual(tracker.memory, { searches: 1, gets: 1, refused: 1, chars: 3212, byRole: { orchestrator: 812, "worker:abc": 2400 } });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `node --test test/workers-memory.test.mjs`
Expected: FAIL — `tracker.memory` undefined.

- [ ] **Step 8: Fold memory events in `lib/workers.mjs`**

In `createTracker` add `memory: { searches: 0, gets: 0, refused: 0, chars: 0, byRole: {} },` after `guards: {}`. In `applyLifecycleEvent`, before the `guardMatch` block:

```js
	const memoryMatch = /^memory:(search|get|refused)$/.exec(ev);
	if (memoryMatch) {
		const kind = memoryMatch[1];
		const { role: reported = "unknown", chars = 0, detail = "" } = data ?? {};
		const role = workerIdForTranscriptName(tracker, String(reported));
		const m = tracker.memory;
		if (kind === "search") m.searches++;
		else if (kind === "get") m.gets++;
		else m.refused++;
		m.chars += Number(chars) || 0;
		if (kind !== "refused") m.byRole[role] = (m.byRole[role] ?? 0) + (Number(chars) || 0);
		audit.push({ agent: String(role), type: "memory", msg: `${kind} ${chars} chars: ${String(detail).slice(0, 160)}` });
		return { audit, decision: null };
	}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test test/workers-memory.test.mjs test/memory-tools.test.mjs`
Expected: PASS.

- [ ] **Step 10: Write `ext/memory-ext.ts`**

```ts
/**
 * memory-ext — the two memory tools, memory_search and memory_get, over the pinned
 * index the supervisor built for this run. Behaviour lives in lib/memory-tools.mjs
 * (scope and budget enforced there on every call); this file registers the tools
 * with pi and reports each call to the lifecycle file. Parents load it via `-e`;
 * pi-subagents workers load the copy under <workspace>/.pi/extensions/.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const tools = await import(kit.homeUrl(home, "lib", "memory-tools.mjs"));

export default function (pi: ExtensionAPI) {
	const cfg = tools.readToolEnv(process.env);
	if (!cfg) return; // memory mode off for this run: register nothing
	const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, isError });

	pi.registerTool({
		name: "memory_search",
		label: "Search memory",
		description: `Search the run's memory (scopes ${cfg.scopes.join(", ")}). Returns up to 10 rows: id · scope · kind · claim · verified/unverified · snapshot · compatibility · summary · evidence count · date. Rows are references, not evidence; fetch ids with memory_get. Records from other data snapshots are hidden unless all_snapshots is true. Every call draws on the run's shared character budget of ${cfg.budget}.`,
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query; terms are matched against summaries and full text and ranked." }),
			kinds: Type.Optional(Type.Array(Type.Union([Type.Literal("semantic"), Type.Literal("question"), Type.Literal("procedural"), Type.Literal("episodic")]))),
			claim: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("interpreted"), Type.Literal("hypothesis"), Type.Literal("unreviewed")])),
			all_snapshots: Type.Optional(Type.Boolean({ description: "Include records made against other data snapshots (each row names its snapshot)." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const r = tools.searchTool(cfg, params, role);
			kit.emit(r.refused ? "memory:refused" : "memory:search", ctx, { chars: r.chars, detail: params.query });
			return text(r.text, false);
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Get memory records",
		description: "Fetch up to 5 memory records by id: full text, claim, settlement criterion, verification (what the oracle reproduced, on which snapshot), evidence references. At most 4000 characters per call; ids outside this run's scopes answer 'not found'. Draws on the shared budget.",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const r = tools.getTool(cfg, params, role);
			kit.emit(r.refused ? "memory:refused" : "memory:get", ctx, { chars: r.chars, detail: params.ids.join(",") });
			return text(r.text, false);
		},
	});
}
```

Check that `@sinclair/typebox` resolves the same way `ext/mail-ext.ts` imports `Type` (copy its import line exactly if it differs).

- [ ] **Step 11: Smoke the extension loads in pi**

Run from the arbiter directory (replace the index path with any index built by the tests, e.g. copy one from a test's tmp dir, or run `node tools/memory.mjs index` after Task 7; for now build one inline):

```bash
node --input-type=module -e "import { resolveLedger, buildIndex } from './lib/memory-index.mjs'; console.log(buildIndex('memory', resolveLedger('memory/records.jsonl')))"
```

Then, with `ARBITER_HOME` set to the arbiter directory, `ARBITER_MEMORY_INDEX` set to that path, `ARBITER_MEMORY_SCOPES='["repo:data-warehousers-real"]'`, `ARBITER_MEMORY_BUDGET=6000`, `ARBITER_MEMORY_LEDGER=<scratch file>`:

```bash
node ../pi/packages/coding-agent/node_modules/.bin/tsx ../pi/packages/coding-agent/src/cli.ts --help >/dev/null
```

is not enough to prove registration; instead run pi in print mode with the extension and a local model: `node <pi entry used by supervisor.mjs launch()> --provider llama.cpp --model qwen3-27b -e ext/memory-ext.ts -t memory_search,memory_get -p "Call memory_search with query 'TX water' and then stop."` (copy the exact entry path from `supervisor.mjs` `launch()`). Expected: the ledger file gains one `search` line and the output shows rows. If the model is not running, skip this step and rely on the live run in Task 10.

- [ ] **Step 12: Commit**

```bash
git add lib/memory-tools.mjs ext/memory-ext.ts ext/guard-kit.ts lib/workers.mjs test/memory-tools.test.mjs test/workers-memory.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory tools: memory_search and memory_get as a pi extension with scope and shared-budget enforcement; calls reported to the lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 5: Snapshot id, seeded brief, tool lists, and path-guard pins

**Files:**
- Create: `lib/snapshot.mjs`, `lib/memory-brief.mjs`
- Modify: `lib/patterns.mjs:5-7`, `test/path-policy.test.mjs`
- Test: `test/snapshot.test.mjs`, `test/memory-brief.test.mjs`

**Interfaces:**
- Produces: `snapshotId({ name, dir })` → `"<name>@<12 hex>"`; `seededBrief({ indexFile, scopes, snapshot, query, budgetChars = 2000, revision })` → `{ text, ids, chars, matched }`; `ORCHESTRATOR_TOOLS` and `WORKER_TOOLS` include `memory_search` and `memory_get`.

- [ ] **Step 1: Write the failing tests**

Create `test/snapshot.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotId } from "../lib/snapshot.mjs";

test("snapshotId hashes relative paths, sizes and mtimes; unchanged data gives the same id", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-snap-"));
	fs.mkdirSync(path.join(dir, "gold"));
	fs.writeFileSync(path.join(dir, "gold", "warehouse.duckdb"), "abc");
	fs.writeFileSync(path.join(dir, "README.md"), "hi");
	const a = snapshotId({ name: "data-warehousers", dir });
	assert.match(a, /^data-warehousers@[0-9a-f]{12}$/);
	assert.equal(snapshotId({ name: "data-warehousers", dir }), a);
	fs.writeFileSync(path.join(dir, "gold", "warehouse.duckdb"), "abcd");
	assert.notEqual(snapshotId({ name: "data-warehousers", dir }), a);
	assert.equal(snapshotId({ name: "seed:x", dir: path.join(dir, "missing") }), "seed:x@none");
});
```

Create `test/memory-brief.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";
import { seededBrief } from "../lib/memory-brief.mjs";

test("seededBrief lists ranked rows within the budget and carries the retrieval hint", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-brief-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@aaaaaaaaaaaa";
	const recs = [];
	for (let i = 0; i < 30; i++) recs.push(makeRecord({ id: `m_${String(i).padStart(3, "0")}`, scope: "repo:dw", kind: "semantic", source: "supervisor", claim: "observed", snapshot: S, ts: i, text: `TX water finding number ${i} about reporting grain and loader mapping.` }));
	appendLog(log, recs);
	const resolved = resolveLedger(log);
	const indexFile = buildIndex(dir, resolved);
	const b = seededBrief({ indexFile, scopes: ["repo:dw"], snapshot: S, query: "TX water loader", budgetChars: 700, revision: resolved.revision });
	assert.ok(b.chars <= 700, `chars ${b.chars}`);
	assert.equal(b.text.length, b.chars);
	assert.ok(b.ids.length >= 1 && b.ids.length < 10, `shown ${b.ids.length}`);
	assert.equal(b.matched, 10, "matched counts the rows the search returned (capped at 10)");
	assert.match(b.text, new RegExp(`## MEMORY \\(searchable; index ${resolved.revision}; ${b.ids.length} of 10 matches shown\\)`));
	assert.match(b.text, /memory_search/);
	const empty = seededBrief({ indexFile, scopes: ["task:none"], snapshot: S, query: "anything", budgetChars: 2000, revision: resolved.revision });
	assert.deepEqual(empty.ids, []);
	assert.match(empty.text, /0 of 0 matches shown/);
});
```

Append to `test/path-policy.test.mjs` (keep its existing imports; `decidePath` is already imported there):

```js
test("memory store paths are refused through every route (retrieval goes through the tools)", () => {
	const root = "C:/Users/x/arbiter/runs/.ws-1/ws-builder";
	const cases = [
		["read", { path: "C:/Users/x/arbiter/memory/records.jsonl" }],
		["bash", { command: "cat C:/Users/x/arbiter/memory/records.jsonl" }],
		["bash", { command: "cat ../../memory/records.jsonl" }],
		["bash", { command: "cat $ARBITER_HOME/memory/records.jsonl" }],
		["read", { path: "../../memory/index/abc.sqlite" }],
	];
	for (const [tool, input] of cases) assert.equal(decidePath({ root, tool, input }).ok, false, `${tool} ${JSON.stringify(input)}`);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test test/snapshot.test.mjs test/memory-brief.test.mjs test/path-policy.test.mjs`
Expected: the first two FAIL (module not found); the path-policy addition PASSES already (it pins existing behaviour).

- [ ] **Step 3: Implement `lib/snapshot.mjs`**

```js
// The data a claim was made against, as one identifier: name plus a hash of the
// relative paths, sizes and mtimes of every file under `dir`. Two runs on unchanged
// data share it; a re-fetched warehouse gets a new one. Cheap even for a 9 GB
// snapshot because it never reads file contents.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function walk(dir, base, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, base, out);
		else if (e.isFile()) {
			const st = fs.statSync(p);
			out.push(`${path.relative(base, p).replace(/\\/g, "/")}\t${st.size}\t${Math.round(st.mtimeMs)}`);
		}
	}
}

export function snapshotId({ name, dir }) {
	if (!dir || !fs.existsSync(dir)) return `${name}@none`;
	const lines = [];
	walk(dir, dir, lines);
	return `${name}@${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`;
}
```

- [ ] **Step 4: Implement `lib/memory-brief.mjs`**

```js
// The search-mode startup block: a seeded search at the pinned revision, formatted
// like a memory_search reply, within a small budget, followed by the retrieval hint.
// Run by the supervisor through the same search() the tools use, so it is
// deterministic per ledger revision.
import { search, formatRows } from "./memory-index.mjs";
import { RETRIEVAL_HINT } from "./memory-tools.mjs";

export function seededBrief({ indexFile, scopes, snapshot, query, budgetChars = 2000, revision }) {
	const rows = search(indexFile, { query, scopes, snapshot, limit: 10 });
	const hint = `\n\n${RETRIEVAL_HINT}`;
	const shown = [];
	const ids = [];
	const header = (n) => `## MEMORY (searchable; index ${revision}; ${n} of ${rows.length} matches shown)\n\n`;
	for (const row of rows) {
		const line = formatRows([row]);
		const candidate = header(shown.length + 1) + [...shown, line].join("\n") + hint;
		if (candidate.length > budgetChars) break;
		shown.push(line);
		ids.push(row.id);
	}
	const text = (header(shown.length) + (shown.length ? shown.join("\n") : "(no matches; search for what you need)") + hint).slice(0, budgetChars);
	return { text, ids, chars: text.length, matched: rows.length };
}
```

- [ ] **Step 5: Add the tools to the role tool lists**

In `lib/patterns.mjs`:

```js
export const BUILDER_TOOLS = "read,bash,edit,write,ls,grep,find,send_mail";
export const ORCHESTRATOR_TOOLS = "read,ls,grep,send_mail,subagent,steer_subagent,get_subagent_result,memory_search,memory_get";
export const WORKER_TOOLS = ["read", "bash", "edit", "write", "ls", "grep", "find", "memory_search", "memory_get"];
```

A run in inject mode (no index) registers no memory tools, and pi ignores allowlisted names that no extension provides; confirm by grepping pi's `--tools` handling (`../pi/packages/coding-agent/src/main.ts:535`) that unknown names are filtered and not fatal. If they are fatal, make the supervisor append the two names only when `CONFIG.memory?.mode === "search"` (Task 6 step 3 shows where).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.mjs"`
Expected: PASS. If `test/patterns.test.mjs` or a smoke asserts the exact tool strings, update those assertions to the new lists.

- [ ] **Step 7: Commit**

```bash
git add lib/snapshot.mjs lib/memory-brief.mjs lib/patterns.mjs test/snapshot.test.mjs test/memory-brief.test.mjs test/path-policy.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: snapshot id, seeded startup brief, memory tools in both role tool lists; path guard pins memory paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 6: Supervisor wiring — index pin, search mode, env, summary

**Files:**
- Modify: `supervisor.mjs` at the memory block (lines 144-162), `launch()` env (around 262-277), the worker-definition block (1131-1145), `runOracle` result parsing (the `JSON.parse(lastLine)` block), summary assembly (line 1055), finish retention (line 1061), and the top-level config/paths section (`memoryPaths(here)` at line 149).

**Interfaces:**
- Consumes: `resolveLedger`, `buildIndex`, `indexPath` (Task 2); `charge` (Task 3); `snapshotId` (Task 5); `seededBrief` (Task 5); `RETRIEVAL_HINT` (Task 4).
- Produces: env `ARBITER_MEMORY_INDEX`, `ARBITER_MEMORY_SCOPES`, `ARBITER_MEMORY_BUDGET`, `ARBITER_MEMORY_LEDGER`, `ARBITER_SNAPSHOT` for every launched pi process (also exported into `process.env` so oracle children inherit them); `summary.snapshot`; `summary.memory = { mode, recall, injected, revision, seedChars, budget, calls }`; `lastOracleResult` kept for Task 7; config keys `memory.mode` (`inject` default | `search`), `memory.budgetChars`, `memory.retrievalChars` (default 6000), `memoryDir` (optional, relative to the arbiter directory).

- [ ] **Step 1: Config and paths**

Near line 149 replace `const MEMORY = memoryPaths(here);` with:

```js
// A config may point memory at another directory (the benchmark's fixture store), so
// a run never pollutes the real ledger. Relative to the arbiter checkout.
const MEMORY_HOME = CONFIG.memoryDir ? path.resolve(here, CONFIG.memoryDir) : here;
const MEMORY = memoryPaths(MEMORY_HOME);
const MEMORY_MODE = CONFIG.memory ? CONFIG.memory.mode ?? "inject" : "off";
```

Check `memoryPaths` (lib/memory.mjs:20) derives `dir` as `<home>/memory`; the benchmark's `memoryDir` therefore points at the parent of a `memory/` folder (`tasks/dw-water-bench/store`). `renderAll(here)` calls in the memory block and at finish must become `renderAll(MEMORY_HOME)`; `loadRunSummaries(MEMORY_HOME)` reads `<home>/runs`, which for the benchmark store does not exist and yields an empty map — acceptable.

- [ ] **Step 2: Snapshot id at launch**

After the mounts are installed (the block that logs `mounts`, around line 113-122), add:

```js
import { snapshotId } from "./lib/snapshot.mjs";
// … after installMounts:
const SNAPSHOT = MOUNTS.length
	? snapshotId({ name: path.basename(MOUNTS[0].target), dir: MOUNTS[0].target })
	: snapshotId({ name: `seed:${TASK_NAME}`, dir: fs.existsSync(path.join(TASK, "ws-builder", "data")) ? path.join(TASK, "ws-builder", "data") : path.join(TASK, "ws-builder") });
log({ type: "snapshot", msg: SNAPSHOT });
```

(`MOUNTS` is the array `installMounts` returned; check its element shape in `lib/mounts.mjs` — it carries `target` as an absolute path.)

- [ ] **Step 3: Replace the memory block (lines 144-162)**

```js
const MEMORY_INJECTED = [];
let MEMORY_TEXT = "";
let MEMORY_INDEX = "";
let MEMORY_REVISION = "";
let MEMORY_SEED_CHARS = 0;
const MEMORY_LEDGER = path.join(RUN, "memory-calls.jsonl");
const MEMORY_SCOPES = ["global", `task:${TASK_NAME}`, ...(CONFIG.repo ? [`repo:${CONFIG.repo}`] : [])];
const RETRIEVAL_BUDGET = CONFIG.memory?.retrievalChars ?? 6000;
if (MEMORY_MODE === "inject") {
	const { text, ids } = recall({ pages: renderAll(MEMORY_HOME), scopes: MEMORY_SCOPES, budgetChars: CONFIG.memory.budgetChars });
	if (text) {
		for (const role of Object.keys(prompts)) prompts[role] = `${prompts[role]}\n\n${text}`;
		MEMORY_INJECTED.push(...ids);
		MEMORY_TEXT = text;
	}
} else if (MEMORY_MODE === "search") {
	// Build (or reuse) the index for the current ledger revision before any agent
	// exists, and pin it for the run. renderAll keeps the wiki current for humans.
	renderAll(MEMORY_HOME);
	const resolved = resolveLedger(MEMORY.log);
	MEMORY_REVISION = resolved.revision;
	MEMORY_INDEX = buildIndex(MEMORY.dir, resolved);
	const questions = [...resolved.records.values()]
		.filter((r) => r.kind === "question" && r.status !== "tombstoned" && MEMORY_SCOPES.includes(r.scope))
		.sort((a, b) => b.ts - a.ts)
		.slice(0, 5)
		.map((r) => r.text);
	const specTitle = (/^#\s*(.+)$/m.exec(taskContext) ?? [])[1] ?? TASK_NAME;
	const brief = seededBrief({ indexFile: MEMORY_INDEX, scopes: MEMORY_SCOPES, snapshot: SNAPSHOT, query: `${specTitle} ${questions.join(" ")}`, budgetChars: CONFIG.memory.budgetChars ?? 2000, revision: MEMORY_REVISION });
	for (const role of Object.keys(prompts)) prompts[role] = `${prompts[role]}\n\n${brief.text}`;
	MEMORY_INJECTED.push(...brief.ids);
	MEMORY_TEXT = brief.text;
	MEMORY_SEED_CHARS = brief.chars;
	fs.writeFileSync(MEMORY_LEDGER, "");
	charge(MEMORY_LEDGER, { role: "supervisor", tool: "seed", chars: brief.chars, detail: `seeded brief, ${brief.ids.length} of ${brief.matched} matches` });
	log({ type: "memory_index", msg: `index ${MEMORY_REVISION} (${resolved.records.size} records); seed ${brief.chars} chars, ${brief.ids.length} rows; retrieval budget ${RETRIEVAL_BUDGET}` });
	// Oracle children and workers inherit these from the supervisor's environment.
	Object.assign(process.env, { ARBITER_MEMORY_INDEX: MEMORY_INDEX, ARBITER_MEMORY_SCOPES: JSON.stringify(MEMORY_SCOPES), ARBITER_MEMORY_BUDGET: String(RETRIEVAL_BUDGET), ARBITER_MEMORY_LEDGER: MEMORY_LEDGER, ARBITER_SNAPSHOT: SNAPSHOT });
}
```

Add the imports at the top: `import { resolveLedger, buildIndex } from "./lib/memory-index.mjs"; import { charge, spent } from "./lib/memory-budget.mjs"; import { seededBrief } from "./lib/memory-brief.mjs";`. `taskContext` is the spec text already assembled for the prompt (see line 129-143); if it is named differently there, use that name.

- [ ] **Step 4: Launch env and the extension**

In `launch()` (the env object around line 262-277) add:

```js
			ARBITER_MEMORY_INDEX: MEMORY_INDEX,
			ARBITER_MEMORY_SCOPES: JSON.stringify(MEMORY_SCOPES),
			ARBITER_MEMORY_BUDGET: String(RETRIEVAL_BUDGET),
			ARBITER_MEMORY_LEDGER: MEMORY_LEDGER,
			ARBITER_SNAPSHOT: SNAPSHOT,
```

In the args array, next to the existing `"-e", path.join(here, "ext", "mail-ext.ts")` entries, add `"-e", path.join(here, "ext", "memory-ext.ts")` for every role when `MEMORY_MODE === "search"` (the extension registers nothing when the index env is empty, so loading it unconditionally is also safe; load it unconditionally for simplicity). In the `GUARDS` array (line 69-74) add `path.join(here, "ext", "memory-ext.ts")` so `installWorkspaceExtension` copies it for workers.

- [ ] **Step 5: Keep the oracle's parsed result**

In `runOracle`, after `({ pass, total } = result);` add `lastOracleResult = { ...result, attempt: doneAttempts };` and declare `let lastOracleResult = null;` next to `let lastProbeHash`. Also write it to disk: `fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));`.

- [ ] **Step 6: Summary and retention inputs**

Replace line 1055 with:

```js
	summary.snapshot = SNAPSHOT;
	summary.memory = {
		mode: MEMORY_MODE,
		recall: CONFIG.memory ? CONFIG.memory : null,
		injected: MEMORY_INJECTED,
		revision: MEMORY_REVISION || null,
		seedChars: MEMORY_SEED_CHARS,
		budget: MEMORY_MODE === "search" ? RETRIEVAL_BUDGET : null,
		calls: MEMORY_MODE === "search" ? { ...tracker.memory, ledger: spent(MEMORY_LEDGER) } : null,
	};
```

At line 1061, retention is called as `retainFromRun({ summary, timeline })`; leave it for now — Task 7 changes the call to pass the deliverable and oracle result.

- [ ] **Step 7: Verify with a search-mode smoke run**

Create `configs/orch-pathnorm-27b-search.json` by copying `configs/orch-pathnorm-27b.json` (or whichever small task config exists; `pathnorm` ran in 316 s) and setting `"memory": { "mode": "search", "budgetChars": 2000, "retrievalChars": 6000 }`. Launch detached:

```powershell
Set-Location C:\Users\user\open_harnessess\pi\arbiter; Start-Process -FilePath node -ArgumentList "supervisor.mjs","--config","configs/orch-pathnorm-27b-search.json" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\run-search-smoke.log"
```

Expected in the run's `audit.jsonl`: a `snapshot` line, a `memory_index` line, and in `summary.json`: `memory.mode === "search"`, `memory.revision` set, `memory.calls.ledger.chars >= seedChars`, and no crash. The orchestrator may or may not call the tools on this task; that is fine here. Delete the smoke config afterwards or keep it under `configs/` with a `_note`.

- [ ] **Step 8: Run all tests, then commit**

```bash
node --test "test/**/*.test.mjs"
git add supervisor.mjs configs/orch-pathnorm-27b-search.json
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "supervisor: memory search mode — snapshot id, pinned index, seeded brief, tool env, memory calls in the summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 7: Explorer contract, oracle details, and per-observation retention

**Files:**
- Modify: `tasks/dw-explore/oracle/explore_check.py:118-162, 196-226`; `tasks/dw-explore/oracle/validate.mjs` and `tasks/dw-explore-real/oracle/validate.mjs` (pass `details`); `tasks/dw-explore/spec.md`, `tasks/dw-explore-real/spec.md`, `tasks/dw-explore/worker.md`, `tasks/dw-explore-real/worker.md`, `docs/dw/contract-explore.md`; `tasks/dw-explore/oracle/reference/make.py` and `tasks/dw-explore-real/oracle/reference/make.py` (reference observations gain the fields); `lib/memory.mjs:205-250` (`retainFromRun`), `lib/memory.mjs:170-192` (`consolidate`); `supervisor.mjs:1061` (retention call)
- Test: `test/memory.test.mjs`; `node tools/verify-task.mjs dw-explore`

**Interfaces:**
- Produces: checker result `{ checks, pass, total, digest, details: [{ id, reproduced: bool, query_sha: str, claim: str }] }`; `retainFromRun({ summary, timeline, deliverable = null, oracle = null, ts })` where `deliverable` is the parsed `src/exploration.json` (or null) and `oracle` is `lastOracleResult`; `consolidate` emits `claim` in its update op when merged records disagree.

- [ ] **Step 1: Write the failing retention and consolidation tests**

Append to `test/memory.test.mjs`:

```js
test("retainFromRun writes one record per observation with the author's claim and the oracle's verification, plus question records", () => {
	const summary = { runId: "r9", task: "dw-explore-real", reason: "SUCCESS: oracle passed", wallSec: 800, workers: 1, doneAttempts: 1, mailByKind: { probe: 3 }, snapshot: "data-warehousers@abc123abc123", config: { pattern: "orchestrator", repo: "data-warehousers-real", roles: { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" } } } };
	const timeline = [{ kind: "oracle", from: "supervisor", body: "Oracle run #1: 14/14 — 14/14 reproduction checks" }];
	const deliverable = {
		observations: [
			{ id: "O1", title: "TX water_bbl is 100% NULL", observation: "All 73.3M TX rows have NULL water_bbl.", why_it_matters: "water cut is unavailable", claim: "observed", query: "select count(*) from production_monthly where state='TX' and water_bbl is null", result: [[73300000]] },
			{ id: "O2", title: "TX water is missing by source design", observation: "The OG_LEASE_CYCLE file carries no water column.", why_it_matters: "not a loader bug", claim: "interpreted", settlement_criterion: "compare the OG_LEASE_CYCLE header with the loader mapping", evidence_refs: ["m_null"], query: "select 1", result: [[1]] },
		],
		next_questions: ["Does the TX loader map any fluid column to water_bbl?"],
	};
	const oracle = { pass: 14, total: 14, details: [{ id: "O1", reproduced: true, query_sha: "aaaa", claim: "observed" }, { id: "O2", reproduced: true, query_sha: "bbbb", claim: "interpreted" }] };
	const out = retainFromRun({ summary, timeline, deliverable, oracle, ts: 5 });
	const sem = out.filter((r) => r.kind === "semantic");
	assert.equal(sem.length, 2);
	assert.equal(sem[0].claim, "observed");
	assert.equal(sem[0].summary, "TX water_bbl is 100% NULL");
	assert.deepEqual(sem[0].verification, { query_sha: "aaaa", snapshot: "data-warehousers@abc123abc123", reproduced: true, by: "oracle:r9#1" });
	assert.equal(sem[0].snapshot, "data-warehousers@abc123abc123");
	assert.equal(sem[0].scope, "repo:data-warehousers-real");
	assert.equal(sem[0].status, "promoted");
	assert.equal(sem[1].claim, "interpreted");
	assert.equal(sem[1].settlement_criterion, "compare the OG_LEASE_CYCLE header with the loader mapping");
	assert.ok(sem[1].evidence.includes("memory:m_null"));
	assert.match(sem[1].text, /^TX water is missing by source design — The OG_LEASE_CYCLE file carries no water column\. \(why: not a loader bug\)$/);
	const q = out.filter((r) => r.kind === "question");
	assert.equal(q.length, 1);
	assert.equal(q[0].claim, "hypothesis");
	assert.equal(q[0].settlement_criterion, "Does the TX loader map any fluid column to water_bbl?");
	const ep = out.find((r) => r.kind === "episodic");
	assert.ok(!/digest/i.test(ep.text), "the episodic record no longer carries a title digest");
	assert.equal(ep.snapshot, "data-warehousers@abc123abc123");
});

test("retainFromRun without a deliverable behaves as before (episodic only, plus procedural on success with spawns)", () => {
	const summary = { runId: "r1", task: "orbit", reason: "SUCCESS: oracle passed", wallSec: 10, workers: 1, doneAttempts: 1, config: { pattern: "orchestrator", roles: {} } };
	const out = retainFromRun({ summary, timeline: [{ kind: "spawn", to: "worker:1", body: "Build stage 1. Then stop." }], ts: 1 });
	assert.deepEqual(out.map((r) => r.kind), ["episodic", "procedural"]);
});

test("consolidate keeps the weaker claim when merged records disagree", () => {
	const a = rec({ id: "m_a", kind: "semantic", claim: "observed", text: "TX water_bbl is null in every row of the snapshot", ts: 1, source: "supervisor" });
	const b = rec({ id: "m_b", kind: "semantic", claim: "hypothesis", settlement_criterion: "check the loader", text: "TX water_bbl is null in every row of the snapshot!", ts: 2, source: "supervisor" });
	const ops = consolidate([a, b], { ts: 3 });
	const upd = ops.find((o) => o.op === "update" && o.id === "m_a");
	assert.equal(upd.claim, "hypothesis");
	assert.equal(upd.settlement_criterion, "check the loader");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/memory.test.mjs`
Expected: FAIL — no semantic records, no `claim` on the update op.

- [ ] **Step 3: Implement retention and the consolidation rule**

In `lib/memory.mjs`, change `retainFromRun`'s signature to `export function retainFromRun({ summary, timeline, deliverable = null, oracle = null, ts = Date.now() })`, remove the `digests`/`digest` computation and the `digest` part, and after building `out` (before the procedural block) add:

```js
	const snapshot = summary.snapshot;
	if (snapshot) out[0].snapshot = snapshot;
	const observations = Array.isArray(deliverable?.observations) ? deliverable.observations.filter((o) => o && typeof o === "object") : [];
	if (String(summary.reason).startsWith("SUCCESS") && observations.length) {
		const details = new Map((oracle?.details ?? []).map((d) => [d.id, d]));
		const by = verdicts.length ? `oracle:${runId}#${verdicts[verdicts.length - 1].n}` : `oracle:${runId}`;
		for (const o of observations) {
			const d = details.get(o.id);
			const refs = Array.isArray(o.evidence_refs) ? o.evidence_refs.map((r) => `memory:${r}`) : [];
			out.push(
				makeRecord({
					scope,
					kind: "semantic",
					claim: CLAIMS.includes(o.claim) ? o.claim : "unreviewed",
					settlement_criterion: o.settlement_criterion,
					summary: String(o.title ?? "").slice(0, 160),
					text: `${o.title} — ${o.observation}${o.why_it_matters ? ` (why: ${o.why_it_matters})` : ""}`,
					...(d ? { verification: { query_sha: d.query_sha, snapshot, reproduced: Boolean(d.reproduced), by } } : {}),
					snapshot,
					evidence: [...evidence, ...refs],
					confidence: 0.9,
					source: "supervisor",
					ts,
				}),
			);
		}
		for (const q of Array.isArray(deliverable.next_questions) ? deliverable.next_questions : []) {
			if (typeof q !== "string" || !q.trim()) continue;
			out.push(makeRecord({ scope, kind: "question", claim: "hypothesis", settlement_criterion: q.trim(), text: q.trim(), snapshot, evidence, confidence: 0.5, source: "supervisor", ts }));
		}
	}
```

Keep `evidence` as computed today (`run:` and `oracle:` refs) so these records are host-vouched and land as `promoted`, matching today's acceptance semantics for supervisor writes. (Whether automatic retention should promote at all is a policy question the spec leaves as is.)

In `consolidate`, inside the inner loop after `merged.add(newer.id)`, track the weaker claim:

```js
const RANK = { observed: 3, interpreted: 2, hypothesis: 1, unreviewed: 0, procedure: 0, episode: 0 };
// … before the inner loop:
		let claim = older.claim;
		let criterion = older.settlement_criterion;
// … inside, after merged.add(newer.id):
			if ((RANK[newer.claim] ?? 0) < (RANK[claim] ?? 0)) {
				claim = newer.claim;
				criterion = newer.settlement_criterion ?? criterion;
			}
// … and when pushing the update op:
		if (tombstones.length) ops.push({ op: "update", id: older.id, ts, evidence, confidence, ...(claim !== older.claim ? { claim, ...(criterion ? { settlement_criterion: criterion } : {}) } : {}) }, ...tombstones);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/memory.test.mjs`
Expected: PASS.

- [ ] **Step 5: Extend the explorer checker**

In `tasks/dw-explore/oracle/explore_check.py`, add near the top:

```python
import hashlib
CLAIMS = ("observed", "interpreted", "hypothesis")
ID_RE = re.compile(r"^m_[0-9a-f]{12}$")


def query_sha(q: str) -> str:
    return hashlib.sha256(" ".join(str(q).lower().split()).encode("utf-8")).hexdigest()[:16]


def memory_ids_exist(ids, index_path):
    """Which of `ids` resolve in the pinned memory index (None when no index was given)."""
    if not index_path:
        return None
    import sqlite3
    con = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    try:
        found = set()
        for i in ids:
            if con.execute("select 1 from records where id = ?", (i,)).fetchone():
                found.add(i)
        return found
    finally:
        con.close()
```

In `check_observation(o, db)` change the signature to `check_observation(o, db, index_path=None)` and, after the confidence check, add:

```python
    claim = o.get("claim")
    if claim not in CLAIMS:
        bad.append("claim must be one of observed, interpreted, hypothesis")
    elif claim != "observed":
        sc = o.get("settlement_criterion")
        if not (isinstance(sc, str) and sc.strip()):
            bad.append(f"a {claim} claim needs a non-empty settlement_criterion (what evidence would settle it)")
    refs = o.get("evidence_refs", [])
    if refs is not None:
        if not (isinstance(refs, list) and all(isinstance(r, str) and ID_RE.match(r) for r in refs)):
            bad.append("evidence_refs must be a list of memory ids like m_0123456789ab")
        elif refs:
            found = memory_ids_exist(refs, index_path)
            if found is not None:
                missing = [r for r in refs if r not in found]
                if missing:
                    bad.append(f"evidence_refs not in this run's memory index: {', '.join(missing)}")
```

In `main()`: add `ap.add_argument("--memory-index", default=os.environ.get("ARBITER_MEMORY_INDEX", ""))` (import `os`), pass `a.memory_index` to every `check_observation` call, and build `details`:

```python
    details = []
    for o in obs:
        oid = o.get("id") if isinstance(o, dict) else "?"
        bad = check_observation(o, db, a.memory_index)
        ck.add(f"observation {oid}", not bad, "; ".join(bad) or "reproduces")
        details.append({"id": oid, "reproduced": not bad, "query_sha": query_sha(o.get("query", "")) if isinstance(o, dict) else "", "claim": o.get("claim") if isinstance(o, dict) else None})
```

and in `Checks.result` accept and include details: `def result(self, digest="", details=None): … return {"checks": self.items, "pass": p, "total": len(self.items), "digest": digest, "details": details or []}`; call `ck.result(digest, details)` at the end of `main()`.

In both `validate.mjs` files change the final line to `out({ pass: res.pass, total: res.total, summary: summary.slice(0, 4000), details: res.details ?? [] });`.

- [ ] **Step 6: Update the contract docs, specs, worker prompts, and references**

In `docs/dw/contract-explore.md` section 2 add the fields to the example observation and in section 3 add rules:

```
3. `claim` is one of `observed` (the result rows show it), `interpreted` (the rows plus an explanation the rows do not establish), `hypothesis` (a conjecture worth checking). `interpreted` and `hypothesis` need a non-empty `settlement_criterion`: what evidence would settle it. The oracle checks the structure; it cannot check honesty. What it did establish is stamped separately as `verification` on the retained record.
4. `evidence_refs` (optional) lists memory record ids (`m_…`) the observation relied on; each must resolve in the run's memory index.
```

and replace section 5 with: retention writes one record per observation (claim, criterion, verification, snapshot) and one per open question; the next run searches them with `memory_search`.

In `tasks/dw-explore/spec.md` and `tasks/dw-explore-real/spec.md`, add to the JSON example after `"why_it_matters"`: `"claim": "observed | interpreted | hypothesis", "settlement_criterion": "required unless observed", "evidence_refs": ["m_…"],` and to the mechanical rules the same two rules. Replace the sentence about "a MEMORY section with earlier explorations" with: "Your prompt carries a MEMORY section listing a few earlier records; `memory_search` and `memory_get` reach the rest. Records marked verified had their query reproduced; interpreted and hypothesis records are not facts — their settlement_criterion says what would settle them. Go where earlier observed findings did not, and take open questions as starting points."

In both `worker.md` files, add one paragraph: "Every observation carries `claim`: `observed` when the rows show it outright, `interpreted` when you add an explanation the rows alone do not establish, `hypothesis` for a conjecture. The two non-observed kinds need a `settlement_criterion`. Label honestly: a NULL count is observed; *why* it is NULL is interpreted until something checks the source. You can `memory_search` and `memory_get` earlier records; cite the ids you relied on in `evidence_refs`."

In both `oracle/reference/make.py`, add `"claim": "observed"` to every generated observation (they are pure query facts).

- [ ] **Step 7: Verify the task packages**

Run: `node tools/verify-task.mjs dw-explore` and `node tools/verify-task.mjs dw-explore-real`.
Expected: both references pass (their observations are `observed`). Then a negative check: copy `tasks/dw-explore/oracle/reference` output workspace to a temp dir, delete `"claim"` from one observation, run the checker directly (`uv run --no-project --python 3.13 --with-requirements tasks/dw-explore/ws-builder/requirements.txt python tasks/dw-explore/oracle/explore_check.py <tmpws> --data tasks/dw-explore/ws-builder`) and confirm the observation check fails with "claim must be one of".

- [ ] **Step 8: Pass the deliverable to retention in the supervisor**

At `supervisor.mjs:1061` replace the call with:

```js
		let deliverable = null;
		try {
			const f = path.join(WS.workspace, "src", "exploration.json");
			if (fs.existsSync(f)) deliverable = JSON.parse(fs.readFileSync(f, "utf8"));
		} catch {
			deliverable = null;
		}
		appendLog(MEMORY.log, retainFromRun({ summary, timeline, deliverable, oracle: lastOracleResult }));
```

- [ ] **Step 9: Run all tests and commit**

```bash
node --test "test/**/*.test.mjs"
git add lib/memory.mjs supervisor.mjs tasks/dw-explore tasks/dw-explore-real docs/dw/contract-explore.md test/memory.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "explorer: claim, settlement_criterion, evidence_refs in the contract; oracle emits per-observation details; retention writes one record per observation with verification stamped separately

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 8: Wiki, lint, CLI, migration, campaign seeding

**Files:**
- Modify: `lib/wiki.mjs:69-85` (`explorationLines`), `lib/wiki.mjs:302-330` (`lint`), `tools/memory.mjs` (commands), `tools/campaign.mjs:108-130` (`seedFromRuns` memory titles), `lib/memory.mjs` (add `migrateDigests`)
- Test: `test/wiki.test.mjs`, `test/memory.test.mjs`

**Interfaces:**
- Produces: `migrateDigests(records, { ts })` → ops and records to append (`{ appends: record[], ops: op[] }`); CLI `node tools/memory.mjs index`, `node tools/memory.mjs search "<query>" [--scope s]...`, `node tools/memory.mjs migrate-digests`; lint finding kind `observed-unverified`; Explorations lines `- [claim ✓|·] title (run link)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/wiki.test.mjs` (inside the file's fixture style):

```js
test("Explorations lists per-observation records with claim and verified marks, and legacy digests only when not superseded", () => {
	const records = foldLog([
		rec({ id: "m_o1", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", summary: "TX water_bbl is 100% NULL", text: "TX water_bbl is 100% NULL — all rows.", snapshot: "dw@1", verification: { query_sha: "a", snapshot: "dw@1", reproduced: true, by: "oracle:r5#1" }, evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 90 }),
		rec({ id: "m_o2", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "interpreted", settlement_criterion: "check the loader", summary: "TX water is missing by source design", text: "TX water is missing by source design — …", evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 91 }),
		rec({ id: "m_7", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS. Findings digest: O1 Two wells hold 60% of oil || next: x?", evidence: ["run:r3", "oracle:r3#1"], source: "supervisor", ts: 70 }),
		rec({ id: "m_8", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS. Findings digest: O1 Only NM has production", evidence: ["run:r4", "oracle:r4#1"], source: "supervisor", ts: 80 }),
		{ op: "update", id: "m_8", ts: 81, superseded_by: "m_x" },
	]);
	const pages = buildPages({ records, runSummaries: new Map(), now: 100 * DAY });
	const page = pages.get("scopes/repo-dw");
	assert.match(page, /- \[observed ✓\] TX water_bbl is 100% NULL \(\[\[runs\/r5\]\]\)/);
	assert.match(page, /- \[interpreted ·\] TX water is missing by source design \(\[\[runs\/r5\]\]\) — settles by: check the loader/);
	assert.match(page, /- \[unreviewed ·\] Two wells hold 60% of oil/);
	assert.ok(!page.includes("Only NM has production"), "a superseded digest is not listed");
});

test("lint flags observed records without verification", () => {
	const records = foldLog([
		rec({ id: "m_v", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", text: "verified thing", verification: { query_sha: "a", snapshot: "dw@1", reproduced: true, by: "oracle:r5#1" }, evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 1 }),
		rec({ id: "m_u", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", text: "unverified thing", evidence: ["run:r5"], source: "agent", ts: 2 }),
	]);
	const findings = lint({ records, runSummaries: new Map(), now: 100 * DAY });
	const f = findings.filter((x) => x.rule === "observed-unverified");
	assert.deepEqual(f.map((x) => x.id), ["m_u"]);
});
```

Append to `test/memory.test.mjs`:

```js
import { migrateDigests } from "../lib/memory.mjs";

test("migrateDigests splits legacy digests into unreviewed records once", () => {
	const legacy = rec({ id: "m_d", kind: "episodic", scope: "repo:dw", source: "supervisor", status: "promoted", evidence: ["run:r3", "oracle:r3#1"], text: "dw-explore via orchestrator: SUCCESS in 800s. Oracle: 17/17. Findings digest: O1 Two wells hold 60% of oil | O2 December 1992 holds 76% || next: is 1992 a catch-up?" });
	const first = migrateDigests(foldLog([legacy]), { ts: 9 });
	assert.equal(first.appends.length, 2);
	assert.equal(first.appends[0].claim, "unreviewed");
	assert.equal(first.appends[0].summary, "Two wells hold 60% of oil");
	assert.deepEqual(first.appends[0].evidence, ["run:r3", "oracle:r3#1"]);
	assert.equal(first.appends[0].scope, "repo:dw");
	assert.deepEqual(first.ops, [{ op: "update", id: "m_d", ts: 9, superseded_by: first.appends[0].id }]);
	const again = migrateDigests(foldLog([legacy, ...first.appends, ...first.ops]), { ts: 10 });
	assert.deepEqual(again, { appends: [], ops: [] });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/wiki.test.mjs test/memory.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**

`lib/memory.mjs` — add:

```js
const DIGEST_RE = /Findings digest: (.+)$/s;
/** Split legacy "Findings digest" episodic records into per-title semantic records, claim unreviewed, and supersede the digest. */
export function migrateDigests(records, { ts = Date.now() } = {}) {
	const appends = [];
	const ops = [];
	for (const r of records instanceof Map ? records.values() : records) {
		if (r.kind !== "episodic" || r.superseded_by || r.status === "tombstoned") continue;
		const m = DIGEST_RE.exec(r.text);
		if (!m) continue;
		const titles = m[1].split("||")[0].split(" | ").map((p) => p.replace(/^O\d+\s+/, "").trim()).filter(Boolean);
		if (!titles.length) continue;
		const made = titles.map((title) => makeRecord({ scope: r.scope, kind: "semantic", claim: "unreviewed", summary: title, text: title, evidence: [...r.evidence], confidence: r.confidence, source: "supervisor", status: r.status, ts }));
		appends.push(...made);
		ops.push({ op: "update", id: r.id, ts, superseded_by: made[0].id });
	}
	return { appends, ops };
}
```

`lib/wiki.mjs` — replace `explorationLines(history)` with a version that takes all scope records:

```js
function explorationLines(scopeRecords) {
	const out = [];
	const seen = new Set();
	const runOf = (r) => (r.evidence ?? []).map(String).find((e) => e.startsWith("run:"))?.slice(4);
	const live = [...scopeRecords].filter((r) => r.status !== "tombstoned" && !r.superseded_by).sort((a, b) => b.ts - a.ts);
	for (const r of live) {
		if (r.kind === "semantic") {
			const title = (r.summary || r.text).trim();
			const key = title.toLowerCase();
			if (!title || seen.has(key)) continue;
			seen.add(key);
			const runId = runOf(r);
			const mark = r.verification?.reproduced ? "✓" : "·";
			const settle = r.settlement_criterion ? ` — settles by: ${r.settlement_criterion}` : "";
			out.push(`- [${claimOf(r)} ${mark}] ${title}${runId ? ` (${link(`runs/${runId}`)})` : ""}${settle}`);
		} else if (r.kind === "episodic") {
			const m = /Findings digest: (.+)$/s.exec(r.text);
			if (!m) continue;
			const runId = runOf(r);
			for (const part of m[1].split("||")[0].split(" | ")) {
				const title = part.replace(/^O\d+\s+/, "").trim();
				const key = title.toLowerCase();
				if (!title || seen.has(key)) continue;
				seen.add(key);
				out.push(`- [unreviewed ·] ${title}${runId ? ` (${link(`runs/${runId}`)})` : ""}`);
			}
		}
	}
	return out;
}
```

and at line 143 pass the scope's full record list instead of `history` (check what variable holds the scope's records there; `history` is the episodic subset today). Import `claimOf` from `./memory.mjs` (watch for a circular import: `memory.mjs` re-exports `recall` from `wiki.mjs`; ES module cycles are fine for function references used at call time, but if a top-level evaluation breaks, move `claimOf` into a tiny `lib/claims.mjs` and import it from both).

Add the lint rule inside `lint()` next to the existing rules:

```js
	for (const r of records.values()) {
		if (r.status !== "tombstoned" && r.kind === "semantic" && claimOf(r) === "observed" && !r.verification?.reproduced) findings.push({ rule: "observed-unverified", id: r.id, scope: r.scope, msg: "claims observed but nothing reproduced it; either verify (a run whose oracle reproduces the query) or relabel as interpreted/hypothesis" });
	}
```

and render it in `renderLint` like the others.

`tools/memory.mjs` — add commands:

```js
		case "index": {
			const resolved = resolveLedger(paths.log);
			const file = buildIndex(paths.dir, resolved);
			console.log(`index ${resolved.revision}: ${resolved.records.size} records → ${path.relative(home, file)}`);
			break;
		}
		case "search": {
			const query = rest.filter((a) => !a.startsWith("--")).join(" ");
			const scopes = rest.flatMap((a, i) => (a === "--scope" ? [rest[i + 1]] : []));
			const resolved = resolveLedger(paths.log);
			const file = buildIndex(paths.dir, resolved);
			console.log(formatRows(search(file, { query, scopes: scopes.length ? scopes : ["global"], allSnapshots: true })));
			break;
		}
		case "migrate-digests": {
			const { appends, ops } = migrateDigests(foldLog(readLog(paths.log)));
			appendLog(paths.log, [...appends, ...ops]);
			console.log(`${appends.length} finding record(s) written, ${ops.length} digest(s) superseded`);
			break;
		}
```

(`rest`, `paths`, `home` follow the file's existing conventions; read its top 25 lines and match names.)

`tools/campaign.mjs` — in `seedFromRuns`, replace the memory-title loop with one that reads both shapes:

```js
		for (const line of fs.readFileSync(log, "utf8").split("\n")) {
			let r;
			try { r = JSON.parse(line); } catch { continue; }
			if (r?.scope !== scope || r?.op) continue;
			if (r.kind === "semantic" && r.summary) { seen.titles.push(tokens(r.summary)); fromMemory++; continue; }
			const m = /Findings digest: (.+)$/s.exec(r?.text ?? "");
			if (!m) continue;
			for (const part of m[1].split("||")[0].split(" | ")) { seen.titles.push(tokens(part.replace(/^O\d+\s+/, ""))); fromMemory++; }
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Migrate the real ledger and render**

```bash
node tools/memory.mjs migrate-digests
node tools/memory.mjs render
node tools/memory.mjs lint
node tools/memory.mjs index
```

Expected: one finding record per legacy title (roughly 100 from the campaign digests), the Explorations sections now show `[unreviewed ·]` marks, lint reports `observed-unverified` for nothing yet (no observed records exist before the first search-mode explorer run), and `memory/index/<rev>.sqlite` exists. Add `memory/index/` to `.gitignore` (indexes are derived).

- [ ] **Step 6: Commit**

```bash
git add lib/memory.mjs lib/wiki.mjs tools/memory.mjs tools/campaign.mjs test/wiki.test.mjs test/memory.test.mjs memory/records.jsonl memory/wiki .gitignore
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: wiki shows claim and verified marks; lint observed-unverified; CLI index/search/migrate-digests; legacy digests migrated as unreviewed findings; campaign seeds from finding summaries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 9: Benchmark task `dw-water-bench`

**Files:**
- Create: `tasks/dw-water-bench/spec.md`, `tasks/dw-water-bench/worker.md`, `tasks/dw-water-bench/ws-builder/README.md`, `tasks/dw-water-bench/ws-builder/data/tx/OG_LEASE_CYCLE.header.csv`, `tasks/dw-water-bench/ws-builder/data/tx/loader_mapping.json`, `tasks/dw-water-bench/ws-builder/src/.keep`, `tasks/dw-water-bench/oracle/validate.mjs`, `tasks/dw-water-bench/oracle/probe.mjs`, `tasks/dw-water-bench/oracle/reference/make.py`, `tasks/dw-water-bench/fixture/make.mjs`, `configs/orch-dw-water-bench-27b.json`
- Generated (committed): `tasks/dw-water-bench/store/memory/records.jsonl`
- Test: `node tools/verify-task.mjs dw-water-bench`; `node tasks/dw-water-bench/fixture/make.mjs` asserts the seed excludes R4.

**Interfaces:**
- Consumes: `snapshotId`, `seededBrief`, `resolveLedger`, `buildIndex`, `makeRecord`, `appendLog`.
- Produces: deliverable `src/finding.json`:

```json
{
  "question": "Is TX water_bbl NULL because the source carries no water column, or because the loader drops it?",
  "claim": "interpreted",
  "conclusion": "one paragraph",
  "settlement_criterion": "what would settle it",
  "evidence_refs": ["m_bench_r1", "m_bench_r4"],
  "checks": [{ "kind": "header", "file": "data/tx/OG_LEASE_CYCLE.header.csv", "columns": ["LEASE_NO", "..."], "has_water_column": false }]
}
```

- [ ] **Step 1: Workspace and spec**

`ws-builder/data/tx/OG_LEASE_CYCLE.header.csv` (one line):

```
LEASE_NO,DISTRICT_NO,CYCLE_YEAR_MONTH,LEASE_OIL_PROD_VOL,LEASE_GAS_PROD_VOL,LEASE_COND_PROD_VOL,LEASE_CSGD_PROD_VOL,OPERATOR_NO,OPERATOR_NAME
```

`ws-builder/data/tx/loader_mapping.json`:

```json
{ "state": "TX", "source": "OG_LEASE_CYCLE", "columns": { "oil_bbl": "LEASE_OIL_PROD_VOL", "gas_mcf": "LEASE_GAS_PROD_VOL", "water_bbl": "LEASE_WATER_PROD_VOL" } }
```

`ws-builder/README.md`: what the two files are, that `src/finding.json` is the deliverable, that memory tools are available, and that Python via uv is available (copy the uv line from `tasks/dw-explore-real/worker.md`).

`spec.md`:

```
# TX water_bbl is NULL: missing at the source, or dropped by the loader?

Answer that question for the data-warehousers warehouse using memory and the two files under data/tx/. Memory holds earlier findings, some observed and verified, some interpretations, some from other snapshots. Search it, fetch what matters, and inspect the files.

Deliverable: src/finding.json with question, claim (observed | interpreted | hypothesis), conclusion, settlement_criterion (required unless observed), evidence_refs (memory ids you relied on), and checks: each { "kind": "header", "file": "<path under data/>", "columns": [...], "has_water_column": true|false } is re-read by the host and must match the file.

Rules the host checks: evidence_refs resolve in this run's memory and are on this snapshot; a claim of observed for the cause is accepted only with a header check that reproduces; records from other snapshots or that contradict your header check must not be cited as support. A worker must fetch at least one record itself (delegate the file inspection and the write-up).
```

`worker.md`: the worker paragraph from Task 7 plus "Use memory_get on the ids the orchestrator names and on any you find; quote what they say in your report."

- [ ] **Step 2: Fixture builder `fixture/make.mjs`**

```js
// Builds the benchmark's memory store: today's real ledger plus 300 unrelated
// records and the controlled TX-water set. Asserts the startup seed does not hand
// the agent the necessary record (R4), so success needs a search and a fetch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecord, appendLog } from "../../../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../../../lib/memory-index.mjs";
import { seededBrief } from "../../../lib/memory-brief.mjs";
import { snapshotId } from "../../../lib/snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const STORE = path.join(here, "..", "store");
const LOG = path.join(STORE, "memory", "records.jsonl");
const SCOPE = "repo:data-warehousers-bench";
const SNAP = snapshotId({ name: "seed:dw-water-bench", dir: path.join(here, "..", "ws-builder", "data") });
const OLD = "data-warehousers@000000000000";

fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.copyFileSync(path.join(ROOT, "memory", "records.jsonl"), LOG);

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const topics = ["NM gas concentrates in", "OK master snapshot rows in", "decline curve initial rate for", "operator spelling variants in", "lease grain duplicates in", "county reconciliation for", "IP test volumes in", "shut-in months for"];
const places = ["Eddy county", "Lea county", "District 08", "Kingfisher", "Permian leases", "the 2019 vintage", "multi-API leases", "single-well leases"];
const filler = [];
for (let i = 0; i < 300; i++) {
	const t = `${topics[Math.floor(rnd() * topics.length)]} ${places[Math.floor(rnd() * places.length)]} is ${Math.floor(rnd() * 90)}% of the total.`;
	filler.push(makeRecord({ scope: i % 3 ? SCOPE : "repo:data-warehousers-real", kind: "semantic", claim: "observed", text: t, snapshot: i % 2 ? SNAP : OLD, evidence: ["run:bench-filler", "oracle:bench-filler#1"], confidence: 0.9, source: "supervisor", ts: 1_700_000_000_000 + i }));
}
const R = (id, over) => makeRecord({ id, scope: SCOPE, kind: "semantic", source: "supervisor", confidence: 0.9, evidence: ["run:2026-09-12T21-53-54", "oracle:2026-09-12T21-53-54#1"], ts: 1_789_250_000_000, ...over });
const controlled = [
	R("m_bench_r1", { claim: "observed", snapshot: SNAP, summary: "TX water_bbl is 100% NULL across all 73.3M production_monthly rows", text: "TX water_bbl is 100% NULL across all 73.3M production_monthly rows — select count(*) filter (where water_bbl is null) = count(*) for state = 'TX'.", verification: { query_sha: "9f1c2a7b0d3e4f56", snapshot: SNAP, reproduced: true, by: "oracle:2026-09-12T21-53-54#1" } }),
	R("m_bench_r2", { claim: "observed", snapshot: SNAP, summary: "TX water_bbl is 100% NULL by source design, not a pipeline drop", text: "TX water_bbl is 100% NULL by source design, not a pipeline drop — the same NULL count query as above.", verification: { query_sha: "9f1c2a7b0d3e4f56", snapshot: SNAP, reproduced: true, by: "oracle:2026-09-12T22-08-57#1" } }),
	R("m_bench_r3", { claim: "observed", snapshot: OLD, summary: "TX water_bbl carried values for 41% of lease-months in the 2025 pull", text: "TX water_bbl carried values for 41% of lease-months in the 2025 pull (older warehouse build).", verification: { query_sha: "1111222233334444", snapshot: OLD, reproduced: true, by: "oracle:2026-08-01T10-00-00#1" } }),
	R("m_bench_r4", { claim: "interpreted", snapshot: SNAP, settlement_criterion: "the column named in loader_mapping.json for the TX fluid field is absent from the OG_LEASE_CYCLE header", summary: "OG_LEASE_CYCLE header carries oil, gas, condensate and casinghead columns only", text: "Inspection of data/tx/OG_LEASE_CYCLE.header.csv: LEASE_OIL_PROD_VOL, LEASE_GAS_PROD_VOL, LEASE_COND_PROD_VOL, LEASE_CSGD_PROD_VOL are the fluid columns; loader_mapping.json maps the TX fluid field named LEASE_WATER_PROD_VOL, which the header does not list, so the mapped field is never populated." }),
	R("m_bench_r5", { claim: "interpreted", snapshot: OLD, settlement_criterion: "re-run the mapping check on the current header", summary: "Loader mapping for TX fluid fields matched the header in the 2025 build", text: "In the 2025 build the loader mapping for TX fluid fields matched the OG_LEASE_CYCLE header column for column." }),
];
appendLog(LOG, [...filler, ...controlled]);

const resolved = resolveLedger(LOG);
const index = buildIndex(path.join(STORE, "memory"), resolved);
const brief = seededBrief({ indexFile: index, scopes: ["global", "task:dw-water-bench", SCOPE], snapshot: SNAP, query: "TX water_bbl is NULL: missing at the source, or dropped by the loader?", budgetChars: 2000, revision: resolved.revision });
if (brief.ids.includes("m_bench_r4")) {
	console.error("fixture invalid: the startup seed already contains m_bench_r4; reword R4 or the spec title");
	process.exit(1);
}
console.log(`store built: ${resolved.records.size} records, revision ${resolved.revision}, snapshot ${SNAP}; seed rows: ${brief.ids.join(", ")}`);
```

Run: `node tasks/dw-water-bench/fixture/make.mjs`. Expected: exit 0 and a line naming the seed rows (R1 and R2 typically appear; R4 must not). If R4 appears, remove the word "loader" from R4's `text` (keep the mapping description in other words) and rerun.

Note the snapshot: the supervisor computes `seed:dw-water-bench@<hash of ws-builder/data>` for this task (Task 6 step 2), which is the same function over the same directory, so `SNAP` matches at run time. Rebuild the fixture whenever the two data files change.

- [ ] **Step 3: Oracle `oracle/validate.mjs`**

```js
#!/usr/bin/env node
/** Oracle for dw-water-bench: did the run find the evidence, keep the cause unsettled unless it checked, and stay within budget? */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const TASK_WS = path.join(here, "..", "ws-builder");
const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
const checks = [];
const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

let f = null;
try {
	f = JSON.parse(fs.readFileSync(path.join(ws, "src", "finding.json"), "utf8"));
} catch (e) {
	out({ pass: 0, total: 1, summary: `src/finding.json missing or invalid: ${e.message}` });
	process.exit(0);
}
const refs = Array.isArray(f.evidence_refs) ? f.evidence_refs.map(String) : [];
const indexFile = process.env.ARBITER_MEMORY_INDEX;
const snapshot = process.env.ARBITER_SNAPSHOT;
const rows = new Map();
if (indexFile && fs.existsSync(indexFile)) {
	const db = new DatabaseSync(indexFile, { readOnly: true });
	for (const id of refs) {
		const r = db.prepare("select id, snapshot, claim from records where id = ?").get(id);
		if (r) rows.set(id, r);
	}
	db.close();
}
add("refs_resolve", refs.length > 0 && refs.every((id) => rows.has(id)), `refs ${refs.join(",")}; resolved ${[...rows.keys()].join(",")}`);
add("cites_r4", refs.includes("m_bench_r4"), "the loader/header inspection record must be cited");
add("no_incompatible_support", !refs.includes("m_bench_r3") && !refs.includes("m_bench_r5"), "records from another snapshot must not support the conclusion");
add("refs_on_snapshot", refs.every((id) => !rows.get(id)?.snapshot || rows.get(id).snapshot === snapshot), `snapshot ${snapshot}`);
// The header check, re-read by the host.
const headerLine = fs.readFileSync(path.join(TASK_WS, "data", "tx", "OG_LEASE_CYCLE.header.csv"), "utf8").trim();
const actual = headerLine.split(",");
const hc = (Array.isArray(f.checks) ? f.checks : []).find((c) => c && c.kind === "header" && String(c.file).replace(/\\/g, "/").endsWith("data/tx/OG_LEASE_CYCLE.header.csv"));
const headerReproduced = Boolean(hc && Array.isArray(hc.columns) && hc.columns.join(",") === actual.join(",") && hc.has_water_column === actual.some((c) => /WATER/i.test(c)));
add("header_check_reproduces", headerReproduced, hc ? `claimed ${JSON.stringify(hc.columns)}` : "no header check filed");
const claim = String(f.claim);
add("claim_valid", ["observed", "interpreted", "hypothesis"].includes(claim), claim);
add("cause_not_observed_without_check", claim !== "observed" || headerReproduced, "observed is accepted for the cause only with a reproduced header check");
add("criterion_present", claim === "observed" || (typeof f.settlement_criterion === "string" && f.settlement_criterion.trim().length > 0), "");
// Retrieval evidence from the run's budget ledger.
const ledger = process.env.ARBITER_MEMORY_LEDGER;
const budget = Number(process.env.ARBITER_MEMORY_BUDGET) || 0;
let lines = [];
if (ledger && fs.existsSync(ledger)) lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const used = lines.filter((l) => l.tool !== "refused").reduce((a, l) => a + l.chars, 0);
add("worker_fetched", lines.some((l) => l.tool === "get" && String(l.role).startsWith("worker")), `roles: ${[...new Set(lines.map((l) => l.role))].join(",")}`);
add("within_budget", budget > 0 && used <= budget, `${used} of ${budget}`);
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
out({ pass, total: checks.length, summary: `${pass}/${checks.length}${failed.length ? `; failing: ${failed.join(" | ")}` : ""}`.slice(0, 4000), details: checks });
```

`oracle/probe.mjs`: accept cases `{ id, args: ["header", "<file>"] }` and print the header columns and whether a water column exists, and `{ id, args: ["finding"] }` running the same checks as validate on the current `src/finding.json` and reporting which fail; follow the argument and output conventions of `tasks/dw-explore-real/oracle/probe.mjs` (read it first and mirror its stdin/stdout contract exactly).

- [ ] **Step 4: Reference solution and config**

`oracle/reference/make.py` writes `src/finding.json` with claim `interpreted`, refs `["m_bench_r1", "m_bench_r4"]`, the header check with the nine columns and `has_water_column: false`, and a settlement criterion "a loader run against a header that includes LEASE_WATER_PROD_VOL populates water_bbl". `tools/verify-task.mjs` expects `make.py` to produce a passing workspace; since the oracle also reads the budget ledger and index from the environment, the verifier must run with `ARBITER_MEMORY_INDEX`, `ARBITER_SNAPSHOT`, `ARBITER_MEMORY_LEDGER` (a file with one `get` line from role `worker:ref`) and `ARBITER_MEMORY_BUDGET=6000` set. Add a `verify.env.json` next to `make.py` with those values (paths relative to the task) and teach `tools/verify-task.mjs` to load it when present:

```js
const envFile = path.join(taskDir, "oracle", "reference", "verify.env.json");
const extraEnv = fs.existsSync(envFile) ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(envFile, "utf8"))).map(([k, v]) => [k, path.isAbsolute(v) || !/^[A-Z_]*(INDEX|LEDGER)$/.test(k) ? v : path.resolve(taskDir, v)])) : {};
```

and pass `{ env: { ...process.env, ...extraEnv } }` to its spawn calls. The ledger fixture file `oracle/reference/memory-calls.jsonl` contains one line: `{"ts":0,"role":"worker:ref","tool":"get","chars":900,"detail":"m_bench_r4"}`.

`configs/orch-dw-water-bench-27b.json`:

```json
{ "task": "dw-water-bench", "pattern": "orchestrator", "repo": "data-warehousers-bench", "memoryDir": "tasks/dw-water-bench/store",
  "memory": { "mode": "search", "budgetChars": 2000, "retrievalChars": 6000 },
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" }, "worker": { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 } },
  "caps": { "toolCalls": 200, "wallSec": 1500, "usd": 5, "doneAttempts": 5, "bashTimeoutSec": 120 },
  "_note": "Retrieval benchmark: memory pointed at the fixture store (tasks/dw-water-bench/store), never the real ledger. Rebuild the store with node tasks/dw-water-bench/fixture/make.mjs." }
```

Retention at finish appends to the fixture store's ledger; that is intended (the store is rebuilt by the fixture script before each measurement batch).

- [ ] **Step 5: Verify**

Run: `node tasks/dw-water-bench/fixture/make.mjs && node tools/verify-task.mjs dw-water-bench`
Expected: fixture built with R4 absent from the seed; verify reports the reference passing all checks.

- [ ] **Step 6: Commit**

```bash
git add tasks/dw-water-bench configs/orch-dw-water-bench-27b.json tools/verify-task.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "dw-water-bench: retrieval benchmark with a fixture memory store, controlled TX-water records, and an oracle for evidence found, cause unsettled, budget held

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

### Task 10: Live comparison and benchmark runs, backlog

**Files:**
- Modify: `configs/orch-dw-explore-real-27b.json`, `configs/orch-dw-explore-27b.json` (`"memory": { "mode": "search", "budgetChars": 2000, "retrievalChars": 6000 }`), `docs/backlog.md`
- Produces: run directories, `docs/batch/memory-slice1.md` with the comparison table.

- [ ] **Step 1: Switch the explorer configs to search mode**

Edit both configs' `memory` object as above. Commit them with the runs later.

- [ ] **Step 2: Run dw-explore-real once in search mode, detached**

```powershell
Set-Location C:\Users\user\open_harnessess\pi\arbiter; Start-Process -FilePath node -ArgumentList "supervisor.mjs","--config","configs/orch-dw-explore-real-27b.json" -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\run-explore-real-search.log"
```

Wait for `summary.json` (about 15 minutes). Record: reason, wallSec, `memory.seedChars`, `memory.calls` (searches, gets, refused, chars by role), oracle score, and how many observations carry each claim. Compare with the last injection run `2026-09-12T22-33-39` (8 000 injected chars, 14/14, 769 s).

- [ ] **Step 3: Run the benchmark three times, rebuilding the store before each**

```powershell
Set-Location C:\Users\user\open_harnessess\pi\arbiter
foreach ($i in 1,2,3) { node tasks/dw-water-bench/fixture/make.mjs; node supervisor.mjs --config configs/orch-dw-water-bench-27b.json *>> "$env:TEMP\bench-$i.log" }
```

(run the loop detached the same way if it must survive the session). For each run record the oracle's per-check results from `oracle-1/result.json`: `cites_r4`, `no_incompatible_support`, `cause_not_observed_without_check`, `worker_fetched`, `within_budget`, and `memory.calls`.

- [ ] **Step 4: Write the report and backlog entry**

`docs/batch/memory-slice1.md`: a table with one row per run (run id, task, mode, seed chars, searches, gets, refused, chars delivered, oracle, wall s) and one paragraph per benchmark run saying which of the three measurements held (evidence found, unresolved interpretation preserved, budget held). `docs/backlog.md`: under the memory item, note slice 1 done, the measured numbers, and slice 2 (checkpoint and compaction) as next.

- [ ] **Step 5: Commit**

```bash
git add configs docs/batch/memory-slice1.md docs/backlog.md memory/records.jsonl memory/wiki
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory slice 1 live: explorer in search mode vs injection, dw-water-bench x3; report and backlog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARXqt7PTkucWaELo5oEFRm"
```

---

## Self-review

**Spec coverage.** Schema → Task 1. Resolver and pinned index, build moments, no build in agent turns → Tasks 2 and 6. Tools, scope on both operations, snapshot compatibility, shared budget across roles and resumed workers, lifecycle reporting → Tasks 3, 4. Both roles receive the tools → Task 5 step 5 (tool lists) and Task 6 step 4 (extension installed in the workspace and loaded with `-e`). Startup brief in search mode, seed charged → Tasks 5 and 6. Explorer contract and oracle details → Task 7. Retention per observation with separate verification, question records, episodic without digest, consolidation claim rule → Task 7. Migration, wiki marks, lint rule, CLI → Task 8. Benchmark with fixture, R1–R5, seed excludes R4, worker fetch, budget, header check, incompatible snapshots not cited → Task 9. Path-guard denials pinned → Task 5. Live comparison and three benchmark runs → Task 10. Worker attribution is settled by `roleFor(ctx)` in the guard kit (Task 4), so the spec's fallback is not needed.

**Placeholders.** None; every code step carries code. Task 4 step 11 and Task 9 step 3 (probe) point at existing files to mirror, and name them.

**Type consistency.** `search()` row shape `{ id, scope, kind, claim, verified, snapshot, compatible, summary, evidenceCount, ts, score }` is used identically by `formatRows`, `seededBrief`, and the tests. `readToolEnv` returns `{ indexFile, scopes, budget, ledger, snapshot }` and both tool handlers read those names. `retainFromRun({ summary, timeline, deliverable, oracle, ts })` matches the supervisor call in Task 7 step 8. Lifecycle events `memory:search|get|refused` match between the extension (Task 4 step 10) and the folder (Task 4 step 8). Env names `ARBITER_MEMORY_INDEX`, `ARBITER_MEMORY_SCOPES`, `ARBITER_MEMORY_BUDGET`, `ARBITER_MEMORY_LEDGER`, `ARBITER_SNAPSHOT` are identical in Tasks 4, 6, 7 (checker), and 9 (oracle).
