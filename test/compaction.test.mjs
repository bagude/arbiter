import { test } from "node:test";
import assert from "node:assert/strict";
import { contextTokensOf, decideCompaction, composeInstructions, ledgerLines } from "../lib/compaction.mjs";

const base = { contextTokens: 40000, threshold: 30000, compactions: 0, maxCompactions: 3, turnsSinceLast: 10, minGapTurns: 5, busy: false, workersLive: false };

test("contextTokensOf sums fresh input and cache reads", () => {
	assert.equal(contextTokensOf({ input: 100, cacheRead: 900, output: 5 }), 1000);
	assert.equal(contextTokensOf(undefined), 0);
});

test("decideCompaction reasons", () => {
	assert.deepEqual(decideCompaction(base), { compact: true, reason: "ok" });
	assert.equal(decideCompaction({ ...base, threshold: 0 }).reason, "off");
	assert.equal(decideCompaction({ ...base, compactions: 3 }).reason, "max_reached");
	assert.equal(decideCompaction({ ...base, contextTokens: 29999 }).reason, "below_threshold");
	assert.equal(decideCompaction({ ...base, turnsSinceLast: 4 }).reason, "too_soon");
	assert.equal(decideCompaction({ ...base, busy: true }).reason, "busy");
	assert.equal(decideCompaction({ ...base, workersLive: true }).reason, "worker_live");
});

test("composeInstructions labels the two parts, keeps ids verbatim, and says when no checkpoint exists", () => {
	const ledger = ledgerLines({ probes: [{ n: 1, head: "O1 reproduces" }, { n: 2, head: "blocked repeat" }], memoryIds: ["m_0123456789ab"], workers: [{ id: "worker:abc", status: "completed", description: "write deliverables" }], handles: ["h_0123456789ab"], oracle: "10/11 (worker_fetched failed)", time: "[time: 40% used]" });
	const withCp = composeInstructions({ ledger, checkpoint: { n: 2, findings: [{ claim: "observed", text: "TX water_bbl is 100% NULL", evidence_refs: ["m_0123456789ab"] }, { claim: "interpreted", text: "missing at the source" }, { claim: "nonsense", text: "falls back to hypothesis" }], open_questions: ["does the loader map water?"], next_steps: ["spawn the writer"] } });
	assert.match(withCp, /## Run ledger \(supervisor\)\n.*#1 O1 reproduces \| #2 blocked repeat/);
	assert.match(withCp, /m_0123456789ab/);
	assert.match(withCp, /worker:abc \(completed: write deliverables\)/);
	assert.match(withCp, /h_0123456789ab/);
	assert.match(withCp, /## Orchestrator checkpoint\nCheckpoint #2\./);
	assert.match(withCp, /observed[^\n]*\n- TX water_bbl is 100% NULL \[m_0123456789ab\]/);
	assert.match(withCp, /interpreted[^\n]*\n- missing at the source/);
	assert.match(withCp, /hypothesis \(conjecture\):\n- falls back to hypothesis/);
	assert.match(withCp, /Next steps:\n- spawn the writer/);
	const without = composeInstructions({ ledger: ledgerLines({}), checkpoint: null });
	assert.match(without, /no checkpoint was written/);
	assert.match(without, /Probes run: none yet\./);
});

test("ledgerLines lists worker reports only when the feature is on", () => {
	assert.ok(!ledgerLines({}).some((l) => l.startsWith("Worker reports")));
	assert.ok(ledgerLines({ reports: [] }).includes("Worker reports: none yet — a completed worker without one blocks done."));
	const [line] = ledgerLines({ reports: [{ role: "worker:a", status: "done", findings: 2, verify: 1 }] }).filter((l) => l.startsWith("Worker reports"));
	assert.equal(line, "Worker reports (tool `report`, schema-checked): worker:a done (2 findings, 1 verify cases)");
});
