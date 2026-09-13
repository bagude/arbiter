import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";
import { checkFinding } from "../tasks/dw-water-bench/oracle/checks.mjs";

const SNAP = "seed:dw-water-bench@test";
const COLUMNS = ["LEASE_NO", "DISTRICT_NO", "CYCLE_YEAR_MONTH", "LEASE_OIL_PROD_VOL", "LEASE_GAS_PROD_VOL", "LEASE_COND_PROD_VOL", "LEASE_CSGD_PROD_VOL", "OPERATOR_NO", "OPERATOR_NAME"];

function index() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-bench-"));
	const log = path.join(dir, "records.jsonl");
	const R = (id, over) => makeRecord({ id, scope: "repo:data-warehousers-bench", kind: "semantic", source: "supervisor", ts: 1, evidence: ["run:r", "oracle:r#1"], ...over });
	appendLog(log, [
		R("m_bench_r1", { claim: "observed", snapshot: SNAP, text: "NULL count" }),
		R("m_bench_r2", { claim: "observed", snapshot: SNAP, text: "by source design" }),
		R("m_bench_r3", { claim: "observed", snapshot: "old@0", text: "old water" }),
		R("m_bench_r4", { claim: "interpreted", settlement_criterion: "x", snapshot: SNAP, text: "header inspection" }),
	]);
	return buildIndex(dir, resolveLedger(log));
}

const good = () => ({
	claim: "interpreted",
	conclusion: "The header has no water column while the loader maps one; NULL at the source, not dropped by the loader.",
	settlement_criterion: "a loader run against a header with LEASE_WATER_PROD_VOL",
	evidence_refs: ["m_bench_r1", "m_bench_r4"],
	checks: [{ kind: "header", file: "data/tx/OG_LEASE_CYCLE.header.csv", columns: COLUMNS, has_water_column: false }],
});
const ledger = (lines) => lines;
const workerGet = { tool: "get", role: "worker:a", chars: 900, records: 1 };
const names = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

test("a correct finding passes every benchmark check", () => {
	const checks = checkFinding(good(), { snapshot: SNAP, budget: 6000, ledger: ledger([workerGet]), indexFile: index() });
	assert.deepEqual(names(checks), []);
});

test("citing the mislabelled R2 as support fails", () => {
	const f = good();
	f.evidence_refs.push("m_bench_r2");
	assert.deepEqual(names(checkFinding(f, { snapshot: SNAP, budget: 6000, ledger: ledger([workerGet]), indexFile: index() })), ["no_mislabelled_support"]);
});

test("worker_fetched needs a worker get that delivered a record", () => {
	const idx = index();
	const notFound = { tool: "get", role: "worker:a", chars: 14, records: 0 };
	assert.deepEqual(names(checkFinding(good(), { snapshot: SNAP, budget: 6000, ledger: ledger([notFound]), indexFile: idx })), ["worker_fetched"]);
	const orchestratorOnly = { tool: "get", role: "orchestrator", chars: 900, records: 2 };
	assert.deepEqual(names(checkFinding(good(), { snapshot: SNAP, budget: 6000, ledger: ledger([orchestratorOnly]), indexFile: idx })), ["worker_fetched"]);
});

test("an observed cause without a reproduced header check fails, and a foreign-snapshot citation fails", () => {
	const idx = index();
	const f = good();
	f.claim = "observed";
	f.checks = [];
	assert.ok(names(checkFinding(f, { snapshot: SNAP, budget: 6000, ledger: ledger([workerGet]), indexFile: idx })).includes("cause_not_observed_without_check"));
	const g = good();
	g.evidence_refs.push("m_bench_r3");
	const failing = names(checkFinding(g, { snapshot: SNAP, budget: 6000, ledger: ledger([workerGet]), indexFile: idx }));
	assert.ok(failing.includes("no_foreign_snapshot_support") && failing.includes("refs_on_snapshot"), failing.join());
});
