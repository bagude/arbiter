import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstOracle, passedFirstTry, branchStats, compareTable, controlBranch, shapeOf, directionOf, findingsFromCompare, settleOrAppend } from "../lib/manage/compare.mjs";
import { createTask, loadTask } from "../lib/manage/task-state.mjs";
import { readFindings, readLedger } from "../lib/manage/ledger.mjs";
import { compareReady, runBatchSpec } from "../tools/manage.mjs";

// A two-branch × 3-replicate table in the shape tools/fork.mjs writes, tagged with the branch
// label the manager chose. Numbers modelled on docs/batch/fork-results-1.md's fork 14.
const row = (over) => ({ label: "G", branch: "G", replicate: 1, runId: "r", crashed: false, oracle: "68/70, 70/70", wallSec: 100, ...over });

const ROWS = [
	row({ label: "G", replicate: 1, oracle: "68/70, 70/70", wallSec: 1127 }),
	row({ label: "G", replicate: 2, oracle: "70/70", wallSec: 329 }),
	row({ label: "G", replicate: 3, oracle: "68/70, 70/70", wallSec: 592 }),
	row({ label: "A", replicate: 1, oracle: "68/70, 70/70", wallSec: 658 }),
	row({ label: "A", replicate: 2, oracle: "70/70", wallSec: 819 }),
	row({ label: "A", replicate: 3, oracle: "70/70", wallSec: 1060 }),
];
const BRANCHES = [{ label: "G" }, { label: "A", firstAction: "done" }];

test("first-try oracle is the FIRST attempt of the run, not its best", () => {
	assert.deepEqual(firstOracle("68/70, 70/70"), { pass: 68, total: 70 });
	assert.deepEqual(firstOracle("70/70"), { pass: 70, total: 70 });
	assert.equal(firstOracle(""), null);
	assert.equal(passedFirstTry(row({ oracle: "68/70, 70/70" })), false, "a run that passed on its second attempt did not pass first try");
	assert.equal(passedFirstTry(row({ oracle: "70/70" })), true);
	assert.equal(passedFirstTry(row({ oracle: "70/70", crashed: true })), false, "a crashed replicate passed nothing");
});

test("branchStats counts every replicate in the denominator, crashes included", () => {
	const s = branchStats([row({ oracle: "70/70", wallSec: 100 }), row({ crashed: true, wallSec: null, oracle: "" })]);
	assert.deepEqual(s, { n: 2, firstTry: 1, crashed: 1, meanWall: 100 }, "the crash is in n but not in the mean wall, which it never reported");
	assert.equal(branchStats([row({ crashed: true, wallSec: null })]).meanWall, null);
});

test("compareTable gives one row per branch, in the order the manager named them", () => {
	assert.deepEqual(compareTable(BRANCHES, ROWS), [
		{ label: "G", firstAction: null, message: false, n: 3, firstTry: 1, crashed: 0, meanWall: 682.7 },
		{ label: "A", firstAction: "done", message: false, n: 3, firstTry: 2, crashed: 0, meanWall: 845.7 },
	]);
});

test("findingsFromCompare: one finding per (control, forced) pair, with the numbers in the claim", () => {
	const findings = findingsFromCompare({
		compareId: 3, branches: BRANCHES, rows: ROWS, recordedTool: "read", checkpoint: "run:2026-09-18T00-01-44#22",
		evidence: { G: "docs/batch/report-G.md", A: "docs/batch/report-A.md" }, scope: "task:raid",
	});
	assert.equal(findings.length, 1);
	const [f] = findings;
	assert.equal(f.id, "f-3-A");
	assert.equal(f.shape, "read→done", "the shape names the recorded TOOL, not its class: two skipped tools settle separately");
	assert.equal(f.claim, "At read→done, forcing done vs continuing: first-try oracle 2/3 vs 1/3, mean wall 845.7 s vs 682.7 s");
	assert.equal(f.settlement_criterion, "same direction on a second run of the same shape");
	assert.equal(f.direction, "better");
	assert.deepEqual(f.evidence, ["docs/batch/report-A.md", "docs/batch/report-G.md"]);
	assert.equal(f.scope, "task:raid");
	assert.equal(f.checkpoint, "run:2026-09-18T00-01-44#22");
});

test("findingsFromCompare: three branches give two findings, each against the same control", () => {
	const branches = [{ label: "G" }, { label: "A", firstAction: "done" }, { label: "B", firstAction: "probe" }];
	const rows = [...ROWS, row({ label: "B", oracle: "60/70", wallSec: 200 })];
	const ids = findingsFromCompare({ compareId: 1, branches, rows }).map((f) => f.id);
	assert.deepEqual(ids, ["f-1-A", "f-1-B"]);
});

test("a comparison with no control branch claims nothing rather than inventing a baseline", () => {
	const branches = [{ label: "A", firstAction: "done" }, { label: "B", firstAction: "probe" }];
	assert.equal(controlBranch(branches), null);
	assert.deepEqual(findingsFromCompare({ compareId: 1, branches, rows: ROWS }), []);
});

test("direction, and the unknown recorded tool", () => {
	assert.equal(directionOf({ firstTry: 2 }, { firstTry: 1 }), "better");
	assert.equal(directionOf({ firstTry: 0 }, { firstTry: 1 }), "worse");
	assert.equal(directionOf({ firstTry: 1 }, { firstTry: 1 }), "same");
	assert.equal(shapeOf(null, "done"), "?→done", "a run whose decision points were never extracted still compares");
});

// The settle-vs-append rule: a second comparison of the same shape SETTLES the first finding.
// Without it a task accumulates one candidate per batch and nothing is ever verified, which is
// exactly what settlement_criterion is for.
test("a second comparison of the same shape settles the first finding instead of appending a duplicate", () => {
	const existing = [{ id: "f-3-A", shape: "read→done", status: "candidate", direction: "better", verifiedOn: [] }];
	const agreeing = { id: "f-4-A", shape: "read→done", direction: "better", compareId: 4 };
	assert.deepEqual(settleOrAppend(existing, agreeing), { action: "settle", id: "f-3-A", status: "verified", verifiedOn: ["4"] });

	const disagreeing = { id: "f-4-A", shape: "read→done", direction: "worse", compareId: 4 };
	assert.equal(settleOrAppend(existing, disagreeing).status, "refuted");

	// Two compares that both say "this changes nothing" agree, and so verify.
	const same = [{ id: "f-3-A", shape: "read→done", status: "candidate", direction: "same", verifiedOn: [] }];
	assert.equal(settleOrAppend(same, { id: "f-4-A", shape: "read→done", direction: "same", compareId: 4 }).status, "verified");

	// A different shape is a different question.
	assert.equal(settleOrAppend(existing, { id: "f-4-A", shape: "ls→spawn", direction: "better", compareId: 4 }).action, "append");
	// Nothing recorded yet: append.
	assert.equal(settleOrAppend([], agreeing).action, "append");
	// Already settled: a third comparison neither duplicates nor flips it.
	const settled = [{ id: "f-3-A", shape: "read→done", status: "verified", direction: "better" }];
	assert.equal(settleOrAppend(settled, disagreeing).action, "skip");
});

// ---------- the read-out of a finished batch (no supervisor is ever spawned) ----------

/** A task directory, and a compares/<n>/ holding what a finished batch leaves behind.
 * `finished: false` leaves the spec alone, for the tests that drive the batch itself. */
function batchFixture({ compareId = 1, rows = ROWS, branches = BRANCHES, summary = true, finished = true, kind = "compare" } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-cmp-"));
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-cmp-runs-"));
	createTask({
		dir, taskId: "t1", goal: "a goal",
		criteria: [{ id: "c1", text: "the oracle passes", check: "oracle:tasks/x/oracle" }],
		milestones: [{ id: "m1", title: "first", criteria: ["c1"] }],
		budget: { runs: 20, forkReplicates: 24 },
	});
	const batchDir = path.join(dir, "compares", String(compareId));
	fs.mkdirSync(batchDir, { recursive: true });
	const tagged = rows.map((r, i) => ({ ...r, runId: `run-${i}` }));
	if (summary) {
		for (const r of tagged) {
			fs.mkdirSync(path.join(runsDir, r.runId), { recursive: true });
			fs.writeFileSync(path.join(runsDir, r.runId, "summary.json"), JSON.stringify({ runId: r.runId, reason: "SUCCESS: oracle passed", wallSec: r.wallSec, tokens: 10 }));
		}
	}
	const specFile = path.join(batchDir, "spec.json");
	fs.writeFileSync(specFile, JSON.stringify({
		kind, compareId, taskDir: dir, runsDir, checkpoint: "run:2026-09-18T00-01-44#22", idempotencyKey: "p7-v4",
		recordedTool: "read", config: "c.json", replicates: 3, scope: "task:t1",
		// As prepareBatch writes them: the manager's branch plus the fork branch it maps onto.
		branches: branches.map((b) => ({ ...b, forkBranch: b.firstAction ? "A-natural" : "G", controlFile: null })),
	}));
	if (finished) {
		fs.writeFileSync(path.join(batchDir, "rows.jsonl"), tagged.map((r) => JSON.stringify(r)).join("\n") + "\n");
		for (const b of branches) fs.writeFileSync(path.join(batchDir, `report-${b.label}.md`), `# ${b.label}\n`);
	}
	return { dir, runsDir, batchDir, specFile, tagged };
}

test("compare-ready writes the candidate finding and the comparison_ready packet the manager answers next", () => {
	const { dir, batchDir } = batchFixture();
	const out = compareReady({ taskDir: dir, batchDir });

	const [f] = readFindings(dir);
	assert.equal(f.id, "f-1-A");
	assert.equal(f.status, "candidate");
	assert.match(f.claim, /first-try oracle 2\/3 vs 1\/3/);
	assert.equal(f.evidence.length, 2, "both branches' reports are the evidence");

	const packet = JSON.parse(fs.readFileSync(out.packetFile, "utf8"));
	assert.equal(packet.trigger.kind, "comparison_ready");
	assert.equal(packet.trigger.detail.compareId, 1);
	assert.deepEqual(packet.trigger.detail.table.map((t) => [t.label, t.firstTry, t.n]), [["G", 1, 3], ["A", 2, 3]]);
	// The candidate is in the packet the manager reads, so the next instruction can be about it.
	assert.deepEqual(packet.history.settledFindings.map((x) => x.id), ["f-1-A"]);
	assert.ok(packet.options.verbsAllowed.includes("accept"), "comparison_ready is one of the two triggers that may be accepted");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(batchDir, "ready.json"), "utf8")).findings, ["f-1-A"]);
});

test("compare-ready refuses to run twice over one batch", () => {
	const { dir, batchDir } = batchFixture();
	compareReady({ taskDir: dir, batchDir });
	assert.throws(() => compareReady({ taskDir: dir, batchDir }), /already ran for this batch \(packet 1/);
	assert.equal(readFindings(dir).length, 1, "and neither duplicates the finding nor settles it against its own evidence");
});

// The findings are already on disk when this happens, so silence would be the failure: nothing
// would ever ask the manager about the comparison it paid for.
test("compare-ready says so loudly when no replicate survived to be packeted", () => {
	const { dir, batchDir } = batchFixture({ summary: false });
	assert.throws(() => compareReady({ taskDir: dir, batchDir }), /every replicate crashed before writing a summary/);
	assert.equal(readFindings(dir).length, 1, "the findings still stand — they are what the batch measured");
	assert.equal(JSON.parse(fs.readFileSync(path.join(batchDir, "ready.json"), "utf8")).packetId, null);
});

// ---------- the batch child, with the fork runner injected (it would spawn supervisors) ----------

/** Stands in for tools/fork.mjs's runBatch: records the call, returns the rows named for it. */
function fakeRunner(byLabel) {
	const calls = [];
	return {
		calls,
		runner: async (arg) => {
			calls.push(arg);
			const rows = byLabel[calls.length - 1] ?? [];
			return { rows, report: `# ${arg.branch}\n`, logDir: "x", reportPath: "x.md" };
		},
	};
}

test("run-batch drives one fork batch per branch, then the read-out, and records the outcome in the ledger", async () => {
	const { dir, specFile, batchDir, tagged } = batchFixture({ finished: false });
	const { calls, runner } = fakeRunner([tagged.filter((r) => r.label === "G"), tagged.filter((r) => r.label === "A")]);
	const out = await runBatchSpec({ taskDir: dir, specFile, runner });

	assert.deepEqual(calls.map((c) => [c.branch, c.action, c.replicates]), [["G", null, 3], ["A-natural", "done", 3]]);
	assert.equal(fs.readFileSync(path.join(batchDir, "report-A.md"), "utf8"), "# A-natural\n");
	assert.equal(fs.readFileSync(path.join(batchDir, "rows.jsonl"), "utf8").trim().split("\n").length, 6);
	assert.equal(out.packetId, 1);

	const outcome = readLedger(dir).at(-1).outcome;
	assert.equal(outcome.packetId, 1);
	assert.deepEqual(outcome.findings, ["f-1-A"], "the ledger, not only the packet, says what the comparison produced");
});

// Nothing watches this child. A branch that throws must still leave the instruction's fate in
// the ledger, or the manager waits forever on a comparison whose budget it has already paid.
test("a batch that dies mid-way records the failure as the instruction's outcome", async () => {
	const { dir, specFile, batchDir } = batchFixture({ finished: false });
	const runner = async () => { throw new Error("no decisions.jsonl"); };
	await assert.rejects(runBatchSpec({ taskDir: dir, specFile, runner }), /no decisions\.jsonl/);
	const outcome = readLedger(dir).at(-1).outcome;
	assert.match(outcome.failed, /no decisions\.jsonl/);
	assert.equal(outcome.branchesDone, 0);
	assert.equal(fs.existsSync(path.join(batchDir, "ready.json")), false, "and no comparison is reported as ready");
});

test("a restore's batch adds its new run to current.activeRuns and claims no finding", async () => {
	const { dir, specFile, tagged } = batchFixture({ kind: "restore", finished: false, branches: [{ label: "A-natural", firstAction: "done" }] });
	const { runner } = fakeRunner([[{ ...tagged[3], label: "A-natural" }]]);
	const out = await runBatchSpec({ taskDir: dir, specFile, runner });
	assert.equal(out.runId, "run-3");
	assert.deepEqual(loadTask(dir).current.activeRuns, ["run-3"], "the next continue can name the restored run");
	assert.deepEqual(readLedger(dir).at(-1).outcome, { batchId: 1, runId: "run-3", crashed: false });
	assert.deepEqual(readFindings(dir), [], "one branch against nothing claims nothing");
});
