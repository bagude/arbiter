import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";
import { spent } from "../lib/memory-budget.mjs";
import { readToolEnv, searchTool, getTool, rememberTool, RETRIEVAL_HINT } from "../lib/memory-tools.mjs";

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

function remEnv(budget = 100000) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-remember-"));
	const rememberFile = path.join(dir, "remember.jsonl");
	const ledger = path.join(dir, "calls.jsonl");
	return { dir, rememberFile, ledger, cfg: { rememberFile, ledger, budget, workerReserve: 0 } };
}

test("rememberTool accepts up to 5 calls per worker role, then refuses the 6th and writes nothing more", () => {
	const { cfg, rememberFile } = remEnv();
	const state = new Map();
	for (let i = 1; i <= 5; i++) {
		const r = rememberTool(cfg, { text: `lesson number ${i} about the loader dropping null water_bbl rows`, evidence_refs: [`file:loader.py#${i}`] }, "worker:w1", state);
		assert.equal(r.refused, false);
		assert.match(r.text, new RegExp(`remembered as a candidate for review \\(${i} of 5 this run\\)`));
	}
	const sixth = rememberTool(cfg, { text: "one lesson too many for this particular worker run, entirely" }, "worker:w1", state);
	assert.equal(sixth.refused, true);
	assert.match(sixth.text, /remember limit reached \(5 per worker run\)/);
	const lines = fs
		.readFileSync(rememberFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(lines.length, 5);
	assert.ok(lines.every((l) => l.role === "worker:w1"));
	assert.deepEqual(lines[0].evidence_refs, ["file:loader.py#1"]);
	assert.equal(lines[0].chars, lines[0].text.length);
});

test("rememberTool refuses text outside 20-600 chars trimmed, and writes nothing", () => {
	const { cfg, rememberFile } = remEnv();
	const state = new Map();
	const short = rememberTool(cfg, { text: "   too short   " }, "worker:w1", state);
	assert.equal(short.refused, true);
	assert.match(short.text, /remember needs 20.?600 characters/);
	const long = rememberTool(cfg, { text: "x".repeat(601) }, "worker:w1", state);
	assert.equal(long.refused, true);
	assert.equal(fs.existsSync(rememberFile), false);
});

test("rememberTool refuses a non-worker role and writes nothing", () => {
	const { cfg, rememberFile } = remEnv();
	const r = rememberTool(cfg, { text: "a fine lesson about the loader that is long enough to pass" }, "orchestrator", new Map());
	assert.equal(r.refused, true);
	assert.match(r.text, /remember is for workers/);
	assert.equal(fs.existsSync(rememberFile), false);
});

test("rememberTool does not draw on the shared retrieval budget, even over a tiny budget", () => {
	const { cfg, ledger } = remEnv(30);
	const state = new Map();
	const text = "a lesson about the loader mapping columns wrong here";
	const r = rememberTool(cfg, { text }, "worker:w1", state);
	assert.equal(r.refused, false, "remember's own 5x600-char caps are the bound, not the shared retrieval budget");
	assert.equal(spent(ledger).chars, 0, "an accepted remember leaves the shared budget unchanged");
});

test("rememberTool still appends a ledger line for accounting, at zero chars", () => {
	const { cfg, ledger } = remEnv(5000);
	const text = "a lesson about the loader mapping columns wrong in this run";
	const r = rememberTool(cfg, { text }, "worker:w1", new Map());
	assert.equal(r.refused, false);
	assert.equal(spent(ledger).chars, 0);
	assert.equal(spent(ledger).calls.remember, 1);
});

test("every rememberTool refusal path (short text, non-worker, 6th call) leaves the remember file absent or unchanged", () => {
	const short = remEnv();
	rememberTool(short.cfg, { text: "   too short   " }, "worker:w1", new Map());
	assert.equal(fs.existsSync(short.rememberFile), false);

	const nonWorker = remEnv();
	rememberTool(nonWorker.cfg, { text: "a fine lesson about the loader that is long enough to pass" }, "orchestrator", new Map());
	assert.equal(fs.existsSync(nonWorker.rememberFile), false);

	const sixth = remEnv();
	const state = new Map();
	for (let i = 1; i <= 5; i++) rememberTool(sixth.cfg, { text: `lesson number ${i} about the loader dropping null water_bbl rows` }, "worker:w1", state);
	const before = fs.readFileSync(sixth.rememberFile, "utf8");
	rememberTool(sixth.cfg, { text: "one lesson too many for this particular worker run, entirely" }, "worker:w1", state);
	assert.equal(fs.readFileSync(sixth.rememberFile, "utf8"), before);
});

test("search returns five rows by default and up to ten on request", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-tools-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@aaaaaaaaaaaa";
	appendLog(log, Array.from({ length: 12 }, (_, i) => makeRecord({ id: `m_${String(i).padStart(12, "0")}`, scope: "repo:dw", kind: "semantic", source: "supervisor", claim: "observed", snapshot: S, ts: i, text: `TX water finding ${i} about the loader.` })));
	const indexFile = buildIndex(dir, resolveLedger(log));
	const cfg = readToolEnv({ ARBITER_MEMORY_INDEX: indexFile, ARBITER_MEMORY_SCOPES: JSON.stringify(["repo:dw"]), ARBITER_MEMORY_BUDGET: "20000", ARBITER_MEMORY_LEDGER: path.join(dir, "calls.jsonl"), ARBITER_SNAPSHOT: S });
	assert.equal(searchTool(cfg, { query: "water loader" }, "orchestrator").rows, 5);
	assert.equal(searchTool(cfg, { query: "water loader", limit: 10 }, "orchestrator").rows, 10);
});
