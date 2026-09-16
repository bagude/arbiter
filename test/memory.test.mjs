import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRecord, foldLog, readLog, appendLog, retainFromRun, retainSpecialists, findingsOf, consolidate, CLAIMS, summarize, migrateDigests } from "../lib/memory.mjs";

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

test("makeRecord accepts agent:<name> scopes and rejects malformed ones", () => {
	const agentRec = rec({ scope: "agent:scout" });
	assert.equal(agentRec.scope, "agent:scout");
	assert.throws(() => rec({ scope: "agent:" }), /scope/);
	assert.throws(() => rec({ scope: "agent:bad name" }), /scope/);
});

test("foldLog applies promote and tombstone ops in order and ignores unknown ids", () => {
	const a = rec({ id: "m_a", text: "A" });
	const b = rec({ id: "m_b", text: "B" });
	const log = [a, b, { op: "promote", id: "m_a", ts: 2000 }, { op: "tombstone", id: "m_b", ts: 3000, reason: "wrong" }, { op: "promote", id: "m_zzz", ts: 4000 }];
	const folded = foldLog(log);
	assert.equal(folded.get("m_a").status, "promoted");
	assert.equal(folded.get("m_a").promotedBy, "human", "a promote op is a human ruling");
	const moved = foldLog([a, { op: "update", id: "m_a", ts: 5000, scope: "repo:dw" }, { op: "update", id: "m_a", ts: 6000, scope: "nope" }]);
	assert.equal(moved.get("m_a").scope, "repo:dw", "an update op may re-scope; an invalid scope is ignored");
	assert.equal(folded.get("m_b").status, "tombstoned");
	assert.equal(folded.get("m_b").tombstoneReason, "wrong");
	assert.equal(folded.size, 2);
});

test("foldLog applies an update op (evidence, confidence, text) on top of a record", () => {
	const a = rec({ id: "m_a", text: "A", evidence: ["run:1"], confidence: 0.7 });
	const folded = foldLog([a, { op: "update", id: "m_a", ts: 2, evidence: ["run:1", "run:2"], confidence: 0.91 }]);
	assert.deepEqual(folded.get("m_a").evidence, ["run:1", "run:2"]);
	assert.equal(folded.get("m_a").confidence, 0.91);
	assert.equal(folded.get("m_a").text, "A");
});

const ORBIT_A = "orbit via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 1086s; 3 workers, 12 probes, 1 done attempt. Oracle: 48/48.";
const ORBIT_B = "orbit via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 1195s; 3 workers, 9 probes, 1 done attempt. Oracle: 48/48.";
const GLOB_FAIL = "glob via dyad (builder=llama.cpp/qwen3-27b, critic=llama.cpp/qwen3-27b): CAP: wall 1500s >= 1500s in 1500s; 2 probes, 2 done attempts. Oracle: 58/59, 58/59.";
const GLOB_OK = "glob via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 994s; 1 workers, 3 probes, 1 done attempt. Oracle: 59/59.";

test("consolidate merges near-duplicates into the older record: evidence union, raised confidence, newer tombstoned", () => {
	const records = foldLog([
		rec({ id: "m_old", text: ORBIT_A, evidence: ["run:r1", "oracle:r1#1"], confidence: 0.9, status: "promoted", ts: 10 }),
		rec({ id: "m_new", text: ORBIT_B, evidence: ["run:r2", "oracle:r2#1"], confidence: 0.9, status: "promoted", ts: 20 }),
	]);
	const ops = consolidate(records, { ts: 30 });
	assert.deepEqual(ops, [
		{ op: "update", id: "m_old", ts: 30, evidence: ["run:r1", "oracle:r1#1", "run:r2", "oracle:r2#1"], confidence: 0.99 },
		{ op: "tombstone", id: "m_new", ts: 30, reason: "merged into m_old" },
	]);
	const after = foldLog([...records.values(), ...ops]);
	assert.equal(after.get("m_old").status, "promoted");
	assert.equal(after.get("m_new").status, "tombstoned");
});

test("consolidate never merges records that say different things, or across scope/kind, or tombstones", () => {
	const records = foldLog([
		rec({ id: "m_1", scope: "task:glob", text: GLOB_FAIL, ts: 1 }),
		rec({ id: "m_2", scope: "task:glob", text: GLOB_OK, ts: 2 }),
		rec({ id: "m_3", scope: "task:orbit", text: ORBIT_A, ts: 3 }),
		rec({ id: "m_4", scope: "task:orbit", kind: "procedural", text: ORBIT_A, ts: 4 }),
		rec({ id: "m_5", scope: "task:orbit", text: ORBIT_B, ts: 5, status: "tombstoned" }),
	]);
	assert.deepEqual(consolidate(records, { ts: 9 }), []);
});

test("consolidate is idempotent and confidence is capped", () => {
	const records = foldLog([
		rec({ id: "m_old", text: ORBIT_A, evidence: ["run:r1"], confidence: 0.99, ts: 10 }),
		rec({ id: "m_new", text: ORBIT_B, evidence: ["run:r2"], confidence: 0.99, ts: 20 }),
	]);
	const ops = consolidate(records, { ts: 30 });
	assert.equal(ops[0].confidence, 0.99);
	const after = foldLog([...records.values(), ...ops]);
	assert.deepEqual(consolidate(after, { ts: 40 }), []);
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

test("repo scope: valid for records, and retainFromRun files a repo run under repo:<name> instead of task:<name>", () => {
	assert.equal(rec({ scope: "repo:data-warehousers" }).scope, "repo:data-warehousers");
	assert.throws(() => rec({ scope: "repo:../x" }), /scope/);
	const summary = { runId: "r1", task: "dw-bronze", reason: "SUCCESS: oracle passed", wallSec: 10, mailByKind: { probe: 1 }, doneAttempts: 1, config: { pattern: "orchestrator", roles: {}, repo: "data-warehousers" } };
	const out = retainFromRun({ summary, timeline: [], ts: 5 });
	assert.ok(out.length >= 1);
	assert.ok(out.every((r) => r.scope === "repo:data-warehousers"));
	const plain = retainFromRun({ summary: { ...summary, config: { pattern: "orchestrator", roles: {} } }, timeline: [], ts: 5 });
	assert.ok(plain.every((r) => r.scope === "task:dw-bronze"));
});

test("retainFromRun keeps a validator's KPI digest on the episodic record", () => {
	const summary = { runId: "r2", task: "dw-recon", reason: "SUCCESS: oracle passed", wallSec: 10, mailByKind: {}, doneAttempts: 1, config: { pattern: "orchestrator", roles: {}, repo: "data-warehousers" } };
	const timeline = [{ kind: "oracle", from: "supervisor", to: "both", body: "Oracle run #1: 12/12 passed. 12/12 grounding checks; this checks numbers and citations, not insight. KPI digest: TX: landed 2026-02-11 (4 files); NM: production 9334 rows to 2025-12-01" }];
	const [ep] = retainFromRun({ summary, timeline, ts: 5 });
	assert.match(ep.text, /Oracle: 12\/12\. KPI digest: TX: landed 2026-02-11/);
	assert.equal(ep.scope, "repo:data-warehousers");
	const plain = retainFromRun({ summary, timeline: [{ kind: "oracle", from: "supervisor", to: "both", body: "Oracle run #1: 48/48 passed." }], ts: 5 })[0];
	assert.ok(!/KPI digest/.test(plain.text));
});

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

test("retention promotes only observed findings the oracle reproduced; interpretations, hypotheses and questions wait as candidates", () => {
	const summary = { runId: "r10", task: "dw-explore-real", reason: "SUCCESS: oracle passed", wallSec: 1, workers: 1, doneAttempts: 1, snapshot: "dw@1", config: { pattern: "orchestrator", repo: "dw", roles: {} } };
	const timeline = [{ kind: "oracle", from: "supervisor", body: "Oracle run #1: 3/3" }];
	const deliverable = {
		observations: [
			{ id: "O1", title: "NULL everywhere", observation: "all rows NULL", why_it_matters: "x", claim: "observed", query: "select 1", result: [[1]] },
			{ id: "O2", title: "by source design", observation: "header lacks water", why_it_matters: "x", claim: "interpreted", settlement_criterion: "check the loader", query: "select 1", result: [[1]] },
			{ id: "O3", title: "maybe stale feed", observation: "few rows", why_it_matters: "x", claim: "hypothesis", settlement_criterion: "compare pull dates", query: "select 1", result: [[1]] },
			{ id: "O4", title: "unreproduced observed", observation: "n", why_it_matters: "x", claim: "observed", query: "select 2", result: [[2]] },
		],
		next_questions: ["is the feed stale?"],
	};
	const oracle = { details: [{ id: "O1", reproduced: true, query_sha: "a" }, { id: "O2", reproduced: true, query_sha: "b" }, { id: "O3", reproduced: true, query_sha: "c" }, { id: "O4", reproduced: false, query_sha: "d" }] };
	const out = retainFromRun({ summary, timeline, deliverable, oracle, ts: 1 });
	const byTitle = Object.fromEntries(out.filter((r) => r.kind === "semantic").map((r) => [r.summary, r.status]));
	assert.deepEqual(byTitle, { "NULL everywhere": "promoted", "by source design": "candidate", "maybe stale feed": "candidate", "unreproduced observed": "candidate" });
	assert.equal(out.find((r) => r.kind === "question").status, "candidate");
	assert.equal(out.find((r) => r.kind === "episodic").status, "promoted");
});

test("foldLog applies a demote op: promoted becomes candidate with the reason kept", () => {
	const r = rec({ id: "m_p", kind: "semantic", claim: "interpreted", settlement_criterion: "x", status: "promoted", source: "supervisor" });
	const out = foldLog([r, { op: "demote", id: "m_p", ts: 2, reason: "policy" }]).get("m_p");
	assert.equal(out.status, "candidate");
	assert.equal(out.demoteReason, "policy");
});

test("retainFromRun turns a study's claims into finding records, verified ones promoted", () => {
	const summary = { runId: "r-study", task: "dw-paper-study", pattern: "orchestrator", reason: "SUCCESS", wallSec: 10, mailByKind: { probe: 1 }, doneAttempts: 1, snapshot: "seed:x@1", roles: { orchestrator: "m", worker: "m" } };
	const timeline = [{ kind: "oracle", from: "supervisor", body: "2/2 study checks", score: "2/2" }];
	const deliverable = {
		claims: [
			{ id: "C1", claim: "observed", text: "Arps has been the standard for 80 years.", quotes: [{ page: 1, text: "x" }] },
			{ id: "C2", claim: "interpreted", text: "PLE fits early time better.", settlement_criterion: "compare residuals", cites: ["m_000000000001"] },
		],
		unresolved: ["Does the terminal decline hold on TX leases?"],
	};
	const oracle = { details: [{ id: "C1", reproduced: true }, { id: "C2", reproduced: true }] };
	assert.equal(findingsOf(deliverable).length, 2);
	const out = retainFromRun({ summary, timeline, deliverable, oracle, ts: 5 });
	const c1 = out.find((r) => r.summary === "Arps has been the standard for 80 years.");
	const c2 = out.find((r) => r.summary === "PLE fits early time better.");
	assert.equal(c1.status, "promoted");
	assert.equal(c1.claim, "observed");
	assert.equal(c2.status, "candidate");
	assert.equal(c2.settlement_criterion, "compare residuals");
	assert.ok(c2.evidence.includes("memory:m_000000000001"));
	assert.ok(out.some((r) => r.kind === "question" && r.text.startsWith("Does the terminal")));
});

test("findingsOf reads a watchlist's candidates as findings naming company and ticker", () => {
	const f = findingsOf({ candidates: [{ id: "W1", claim: "observed", company: "Halvard Semiconductor", ticker: "HLVS", stance: "bullish", thesis: "Supply deal marks an inflection." }, null] });
	assert.equal(f.length, 1);
	assert.equal(f[0].id, "W1");
	assert.equal(f[0].claim, "observed");
	assert.equal(f[0].title, "Halvard Semiconductor (HLVS), bullish: Supply deal marks an inflection.");
	assert.deepEqual(f[0].evidence_refs, []);
});

test("retainFromRun files worker report findings as agent candidates on a successful run only; a hypothesis or interpretation without a settlement criterion is unreviewed", () => {
	const summary = { runId: "r1", task: "orbit", reason: "SUCCESS: oracle passed", wallSec: 10, config: { pattern: "orchestrator", roles: {} }, mailByKind: {}, doneAttempts: 1 };
	const findings = [
		{ claim: "observed", text: "tests pass 4/4", evidence_refs: ["src/x.test.mjs"] },
		{ claim: "hypothesis", text: "edge case untested" },
		{ claim: "interpreted", text: "the slow path is the parser", settlement_criterion: "profile parse() on the 10k-line fixture" },
		{ claim: "nonsense", text: "" },
	];
	const reports = [{ ts: 1, role: "worker:a", status: "done", summary: "s", changed: [], verify: [], open_questions: [], findings }];
	const out = retainFromRun({ summary, timeline: [], reports, ts: 5 });
	// retainFromRun itself only ever writes supervisor records, so `agent` isolates the worker's.
	const worker = out.filter((r) => r.source === "agent");
	assert.equal(worker.length, 3, "the empty-text finding is dropped");
	assert.deepEqual(worker.map((r) => [r.kind, r.claim, r.status, r.confidence]), [["semantic", "observed", "candidate", 0.4], ["semantic", "unreviewed", "candidate", 0.4], ["semantic", "interpreted", "candidate", 0.4]]);
	assert.equal(worker[2].settlement_criterion, "profile parse() on the 10k-line fixture");
	assert.equal("settlement_criterion" in worker[1], false);
	assert.equal(worker[0].scope, "task:orbit");
	assert.equal(worker[0].summary, "tests pass 4/4");
	assert.match(worker[0].text, /^tests pass 4\/4 \(worker report, worker:a\)$/);
	assert.deepEqual(worker[0].evidence, ["run:r1", "worker:a", "src/x.test.mjs"]);
	assert.deepEqual(worker[1].evidence, ["run:r1", "worker:a"]);
	const failed = retainFromRun({ summary: { ...summary, reason: "CAP: wall 100s >= 100s" }, timeline: [], reports, ts: 5 });
	assert.equal(failed.filter((r) => r.source === "agent").length, 0);
});

test("retainSpecialists files a specialist's remember as a candidate under its agent scope; an unresolved worker keeps its remember under the task scope", () => {
	const remembers = [
		{ ts: 1, role: "worker:sess-tester", text: "the fixture DB needs a fresh seed each run", evidence_refs: ["src/fixtures.mjs"] },
		{ ts: 2, role: "worker:sess-unknown", text: "ambiguous scope worker note" },
	];
	const manifestRows = [{ wid: "w1", sessionId: "sess-tester", type: "tester", description: "write unit tests for the parser." }];
	const specialists = [{ name: "tester", memory: "tester" }];
	const out = retainSpecialists({ runId: "r1", task: "orbit", passed: true, oracleN: 2, remembers, manifestRows, specialists, ts: 5 });
	const candidates = out.filter((r) => r.kind === "semantic");
	assert.equal(candidates.length, 2);
	const testerRec = candidates.find((r) => r.scope === "agent:tester");
	assert.ok(testerRec, "tester's remember goes under agent:tester");
	assert.equal(testerRec.claim, "unreviewed");
	assert.equal(testerRec.source, "agent");
	assert.equal(testerRec.status, "candidate");
	assert.equal(testerRec.confidence, 0.4);
	assert.deepEqual(testerRec.evidence, ["run:r1", "from_agent:tester", "worker:sess-tester", "src/fixtures.mjs"]);
	const unresolvedRec = candidates.find((r) => r.scope === "task:orbit");
	assert.ok(unresolvedRec, "unknown session keeps its remember under task:orbit");
	assert.deepEqual(unresolvedRec.evidence, ["run:r1", "unresolved_worker:sess-unknown", "worker:sess-unknown"]);
});

test("retainSpecialists writes one procedural record per specialist type that spawned, promoted when the run passed with an oracle number, candidate when it failed", () => {
	const manifestRows = [
		{ wid: "w1", sessionId: "s1", type: "tester", description: "write unit tests for the parser. extra detail." },
		{ wid: "w2", sessionId: "s2", type: "tester", description: "add regression coverage." },
	];
	const specialists = [{ name: "tester", memory: "tester" }, { name: "scout", memory: "scout" }];
	const passedOut = retainSpecialists({ runId: "r2", task: "orbit", passed: true, oracleN: 3, remembers: [], manifestRows, specialists, ts: 9 });
	const proc = passedOut.find((r) => r.kind === "procedural");
	assert.ok(proc);
	assert.equal(proc.scope, "agent:tester");
	assert.equal(proc.text, "tester ran on orbit (2 spawn(s): write unit tests for the parser. | add regression coverage.) — run passed");
	assert.equal(proc.source, "supervisor");
	assert.equal(proc.confidence, 0.7);
	assert.equal(proc.status, "promoted", "a passed run with an oracle number is host-vouched and auto-promotes");
	assert.deepEqual(proc.evidence, ["run:r2", "oracle:r2#3", "applies_to:task:orbit"]);
	assert.equal(passedOut.filter((r) => r.kind === "procedural").length, 1, "scout never spawned, so it gets no procedural record");
	const failedOut = retainSpecialists({ runId: "r3", task: "orbit", passed: false, oracleN: null, remembers: [], manifestRows, specialists, ts: 9 });
	const failedProc = failedOut.find((r) => r.kind === "procedural");
	assert.equal(failedProc.status, "candidate");
	assert.equal(failedProc.confidence, 0.4);
	assert.deepEqual(failedProc.evidence, ["run:r3", "applies_to:task:orbit"]);
});

test("retainSpecialists never throws on a malformed remember line and never drops a resolvable one", () => {
	const remembers = [null, { role: "worker:s1" }, { role: "not-a-worker-role", text: "x" }, { ts: 1, role: "worker:s1", text: "the fixture needs a reset" }];
	const manifestRows = [{ wid: "w1", sessionId: "s1", type: "tester", description: "d." }];
	const specialists = [{ name: "tester", memory: "tester" }];
	const out = retainSpecialists({ runId: "r4", task: "orbit", passed: true, oracleN: 1, remembers, manifestRows, specialists, ts: 1 });
	const candidates = out.filter((r) => r.kind === "semantic");
	assert.equal(candidates.length, 1, "only the one well-formed remember produces a record");
	assert.equal(candidates[0].scope, "agent:tester");
});
