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
	assert.equal(ftsQuery("TX water_bbl NULL: source or loader?"), '"tx" OR "water_bbl" OR "null" OR "source" OR "or" OR "loader"');
	assert.equal(ftsQuery(""), "");
});

test("search ranks by bm25, filters scope, skips tombstoned and superseded, flags snapshots", () => {
	const { dir, log, S } = fixture();
	const p = buildIndex(dir, resolveLedger(log));
	const rows = search(p, { query: "TX water loader", scopes: ["repo:dw"], snapshot: S });
	const ids = rows.map((r) => r.id);
	assert.ok(ids.includes("m_null") && ids.includes("m_design") && ids.includes("m_loader"), ids.join());
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
