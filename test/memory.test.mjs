import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, foldLog, readLog, appendLog, project, renderMarkdown, retainFromRun } from "../lib/memory.mjs";

const rec = (over) =>
	makeRecord({ scope: "task:orbit", kind: "episodic", text: "x", evidence: [], confidence: 0.5, source: "human", ts: 1000, ...over });

test("makeRecord fills id, status and defaults; auto-promotes supervisor/oracle records with oracle evidence", () => {
	const human = rec({ text: "a human note" });
	assert.match(human.id, /^m_[0-9a-f]{12}$/);
	assert.equal(human.status, "candidate");
	const sup = rec({ source: "supervisor", evidence: ["run:r1", "oracle:r1#1"] });
	assert.equal(sup.status, "promoted");
	const supNoOracle = rec({ source: "supervisor", evidence: ["run:r1"] });
	assert.equal(supNoOracle.status, "candidate");
	const agent = rec({ source: "agent", evidence: ["oracle:r1#1"] });
	assert.equal(agent.status, "candidate", "an agent never promotes its own writes");
	assert.throws(() => rec({ kind: "vibes" }), /kind/);
	assert.throws(() => rec({ scope: "nope" }), /scope/);
});

test("foldLog applies promote and tombstone ops in order and ignores unknown ids", () => {
	const a = rec({ id: "m_a", text: "A" });
	const b = rec({ id: "m_b", text: "B" });
	const log = [a, b, { op: "promote", id: "m_a", ts: 2000 }, { op: "tombstone", id: "m_b", ts: 3000, reason: "wrong" }, { op: "promote", id: "m_zzz", ts: 4000 }];
	const folded = foldLog(log);
	assert.equal(folded.get("m_a").status, "promoted");
	assert.equal(folded.get("m_b").status, "tombstoned");
	assert.equal(folded.get("m_b").tombstoneReason, "wrong");
	assert.equal(folded.size, 2);
});

test("appendLog/readLog round-trip an append-only JSONL file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-mem-"));
	const file = path.join(dir, "records.jsonl");
	assert.deepEqual(readLog(file), []);
	appendLog(file, [rec({ id: "m_1", text: "one" })]);
	appendLog(file, [{ op: "promote", id: "m_1", ts: 5 }]);
	const log = readLog(file);
	assert.equal(log.length, 2);
	assert.equal(foldLog(log).get("m_1").status, "promoted");
});

test("project: promoted records only, in scope, scored by query overlap then confidence, within the budget", () => {
	const records = foldLog([
		rec({ id: "m_1", status: "promoted", scope: "task:orbit", kind: "procedural", text: "orbit: split stages 1-2, 3-4, 5 across three workers; probe after every report", confidence: 0.9, ts: 10 }),
		rec({ id: "m_2", status: "promoted", scope: "global", kind: "semantic", text: "llama.cpp qwen3-27b omits bash timeouts", confidence: 0.6, ts: 20 }),
		rec({ id: "m_3", status: "candidate", scope: "task:orbit", kind: "episodic", text: "an unpromoted candidate about orbit stages", confidence: 0.9, ts: 30 }),
		rec({ id: "m_4", status: "promoted", scope: "task:glob", kind: "episodic", text: "glob: braces are the hard part", confidence: 0.9, ts: 40 }),
		rec({ id: "m_5", status: "tombstoned", scope: "task:orbit", kind: "semantic", text: "orbit stages wrong claim", confidence: 0.9, ts: 50 }),
	]);
	const { text, ids } = project({ records, scopes: ["global", "task:orbit"], query: "implement the orbit stages with workers", budgetChars: 10_000 });
	assert.deepEqual(ids, ["m_1", "m_2"]);
	assert.match(text, /^# MEMORY \(2 records, promoted, scopes: global, task:orbit\)\n/);
	assert.match(text, /- \[procedural\] orbit: split stages/);
	assert.match(text, /- \[semantic\] llama\.cpp qwen3-27b/);
	// budget: only the best-scoring record fits
	const tight = project({ records, scopes: ["global", "task:orbit"], query: "orbit stages", budgetChars: 140 });
	assert.deepEqual(tight.ids, ["m_1"]);
	assert.ok(tight.text.length <= 140 + 80, "header may exceed by a little, body must not");
	// nothing promoted in scope → empty projection
	const none = project({ records, scopes: ["task:decline"], query: "x", budgetChars: 1000 });
	assert.deepEqual(none, { text: "", ids: [] });
});

test("renderMarkdown lists promoted, then candidates, per scope, and never tombstones", () => {
	const records = foldLog([
		rec({ id: "m_1", status: "promoted", scope: "task:orbit", text: "P", evidence: ["run:r1", "oracle:r1#1"] }),
		rec({ id: "m_2", scope: "task:orbit", text: "C" }),
		rec({ id: "m_3", status: "tombstoned", scope: "task:orbit", text: "T" }),
	]);
	const md = renderMarkdown(records, "task:orbit");
	assert.match(md, /^# memory — task:orbit\n/);
	assert.match(md, /## Promoted\n\n- \[episodic\] P \(m_1, conf 0\.5, evidence: run:r1, oracle:r1#1\)\n/);
	assert.match(md, /## Candidates\n\n- \[episodic\] C \(m_2, conf 0\.5, human\)\n/);
	assert.doesNotMatch(md, /\bT\b/);
});

test("retainFromRun derives evidence-backed candidates from a finished run", () => {
	const summary = {
		runId: "2026-09-11T21-35-14",
		reason: "SUCCESS: oracle passed",
		task: "orbit",
		config: { pattern: "orchestrator", roles: { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } } },
		wallSec: 1086,
		workers: 3,
		doneAttempts: 1,
		mailByKind: { probe: 12, done: 1 },
		guards: { bash_timeout: { rewritten: { "worker:a": 2 } } },
	};
	const timeline = [
		{ from: "orchestrator", to: "worker:a", kind: "spawn", body: "Implement stages 1 and 2 of the pipeline in src/orbit.mjs. Details…" },
		{ from: "orchestrator", to: "worker:b", kind: "spawn", body: "Implement stages 3-4.\nMore." },
		{ from: "supervisor", to: "both", kind: "oracle", body: "Oracle run #1: 48/48 passed." },
	];
	const out = retainFromRun({ summary, timeline, ts: 99 });
	const kinds = out.map((r) => r.kind);
	assert.deepEqual(kinds, ["episodic", "procedural"]);
	const [ep, proc] = out;
	assert.equal(ep.scope, "task:orbit");
	assert.equal(ep.source, "supervisor");
	assert.equal(ep.status, "promoted");
	assert.deepEqual(ep.evidence, ["run:2026-09-11T21-35-14", "oracle:2026-09-11T21-35-14#1"]);
	assert.match(ep.text, /^orbit via orchestrator \(orchestrator=llama\.cpp\/qwen3-27b, worker=llama\.cpp\/qwen3-27b\): SUCCESS: oracle passed in 1086s; 3 workers, 12 probes, 1 done attempt\./);
	assert.match(proc.text, /^orbit: delegation that passed the oracle — worker 1: Implement stages 1 and 2 of the pipeline in src\/orbit\.mjs\. \| worker 2: Implement stages 3-4\./);
	assert.equal(proc.confidence, 0.7);
});

test("retainFromRun on a failed run keeps the episodic record as a candidate and no procedural record", () => {
	const summary = { runId: "r2", reason: "CAP: wall 1500s >= 1500s", task: "glob", config: { pattern: "dyad", roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } } }, wallSec: 1500, doneAttempts: 2, mailByKind: { probe: 2 } };
	const timeline = [{ from: "supervisor", to: "both", kind: "oracle", body: "Oracle run #1: 58/59 passed." }, { from: "supervisor", to: "both", kind: "oracle", body: "Oracle run #2: 58/59 passed." }];
	const out = retainFromRun({ summary, timeline, ts: 1 });
	assert.equal(out.length, 1);
	assert.equal(out[0].status, "promoted", "an oracle verdict is evidence even when the run failed");
	assert.match(out[0].text, /CAP: wall 1500s >= 1500s in 1500s; 2 probes, 2 done attempts\. Oracle: 58\/59, 58\/59\./);
	assert.deepEqual(out[0].evidence, ["run:r2", "oracle:r2#1", "oracle:r2#2"]);
});
