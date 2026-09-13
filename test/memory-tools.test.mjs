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
	assert.equal(r.chars, r.text.length - r.text.slice(r.text.lastIndexOf("\n(memory budget")).length, "chars counts the delivered body, not the budget footer");
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
	assert.ok(r.text.length <= 4000, `len ${r.text.length}`);
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

test("a worker reserve keeps part of the budget out of the orchestrator's reach; workers may use all of it", () => {
	const { cfg, ledger } = env(3000);
	cfg.workerReserve = 1200;
	const first = searchTool(cfg, { query: "water" }, "orchestrator"); // ~ hundreds of chars
	assert.equal(first.refused, false);
	const big = getTool(cfg, { ids: ["m_loader"] }, "orchestrator"); // ~1900 chars would cross 3000-1200
	assert.equal(big.refused, true, "the orchestrator cannot spend into the worker reserve");
	assert.match(big.text, /reserved for workers/);
	const worker = getTool(cfg, { ids: ["m_loader"] }, "worker:z");
	assert.equal(worker.refused, false, "a worker may spend the reserve");
	assert.ok(spent(ledger).chars <= 3000);
	assert.equal(readToolEnv({ ARBITER_MEMORY_INDEX: cfg.indexFile, ARBITER_MEMORY_WORKER_RESERVE: "2000" }).workerReserve, 2000);
	assert.equal(readToolEnv({ ARBITER_MEMORY_INDEX: cfg.indexFile }).workerReserve, 0);
});

test("a get charges the number of records it delivered", () => {
	const { cfg, ledger } = env();
	getTool(cfg, { ids: ["m_loader", "m_nope"] }, "worker:x");
	getTool(cfg, { ids: ["m_nope"] }, "worker:x");
	const lines = fs.readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines.map((l) => l.records), [1, 0]);
});
