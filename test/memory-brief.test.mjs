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
	const b = seededBrief({ indexFile, scopes: ["repo:dw"], snapshot: S, query: "TX water loader", budgetChars: 1500, revision: resolved.revision });
	assert.ok(b.chars <= 1500, `chars ${b.chars}`);
	assert.equal(b.text.length, b.chars);
	assert.ok(b.ids.length >= 1 && b.ids.length < 10, `shown ${b.ids.length}`);
	assert.equal(b.matched, 10, "matched counts the rows the search returned (capped at 10)");
	assert.match(b.text, new RegExp(`## MEMORY \\(searchable; index ${resolved.revision}; ${b.ids.length} of 10 matches shown\\)`));
	assert.match(b.text, /memory_search/);
	const empty = seededBrief({ indexFile, scopes: ["task:none"], snapshot: S, query: "anything", budgetChars: 2000, revision: resolved.revision });
	assert.deepEqual(empty.ids, []);
	assert.match(empty.text, /0 of 0 matches shown/);
});

test("seededBrief with status forwards it to search, excluding other statuses", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-brief-status-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@aaaaaaaaaaaa";
	appendLog(log, [
		makeRecord({ id: "m_cand", scope: "agent:scout", kind: "semantic", source: "agent", confidence: 0.4, snapshot: S, text: "scout candidate finding about the loader", status: "candidate" }),
		makeRecord({ id: "m_promoted", scope: "agent:scout", kind: "semantic", source: "supervisor", confidence: 0.9, snapshot: S, evidence: ["run:r1", "oracle:r1#1"], text: "scout promoted finding about the loader" }),
	]);
	const resolved = resolveLedger(log);
	const indexFile = buildIndex(dir, resolved);
	const b = seededBrief({ indexFile, scopes: ["agent:scout"], snapshot: S, query: "loader", budgetChars: 2000, revision: resolved.revision, status: "promoted" });
	assert.deepEqual(b.ids, ["m_promoted"]);
});
