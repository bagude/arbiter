import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstOracle, passedFirstTry, branchStats, compareTable, controlBranch, shapeOf, directionOf, findingsFromCompare, settleOrAppend } from "../lib/manage/compare.mjs";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
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
	// As the executor leaves it: the batch is pending in task.json until its child clears it.
	const t = loadTask(dir);
	saveTask(dir, setCurrent(t, { activeBranches: [{ batchId: compareId, kind, checkpoint: "run:2026-09-18T00-01-44#22", launchedAt: Date.now() }] }));
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

/** Stands in for tools/fork.mjs's runBatch: records the call, returns the rows named for it.
 * `abandonAt` is a 1-based call number that comes back with the collision preflight's own
 * `abandoned` field, as the real runner does when runs/.ws-<src> is held. */
function fakeRunner(byLabel, { abandonAt = 0 } = {}) {
	const calls = [];
	return {
		calls,
		runner: async (arg) => {
			calls.push(arg);
			const rows = byLabel[calls.length - 1] ?? [];
			const out = { rows, report: `# ${arg.branch}\n`, logDir: "x", reportPath: "x.md", abandoned: null };
			if (calls.length === abandonAt) out.abandoned = { branch: arg.branch, replicate: 1, collision: "fork: runs/.ws-src already exists — a live run or another fork holds it" };
			return out;
		},
	};
}

test("run-batch drives one fork batch per branch, then the read-out, and records the outcome in the ledger", async () => {
	const { dir, specFile, batchDir, tagged } = batchFixture({ finished: false });
	const { calls, runner } = fakeRunner([tagged.filter((r) => r.label === "G"), tagged.filter((r) => r.label === "A")]);
	const versionBefore = loadTask(dir).stateVersion;
	const out = await runBatchSpec({ taskDir: dir, specFile, runner });

	assert.deepEqual(calls.map((c) => [c.branch, c.action, c.replicates]), [["G", null, 3], ["A-natural", "done", 3]]);
	// Two forced branches of one compare are both branch A-natural: the label is what keeps
	// their fork reports and replicate logs from overwriting each other.
	assert.deepEqual(calls.map((c) => c.label), ["G", "A"]);
	assert.equal(fs.readFileSync(path.join(batchDir, "report-A.md"), "utf8"), "# A-natural\n");
	assert.equal(fs.readFileSync(path.join(batchDir, "rows.jsonl"), "utf8").trim().split("\n").length, 6);
	assert.equal(out.packetId, 1);

	const outcome = readLedger(dir).at(-1).outcome;
	assert.equal(outcome.packetId, 1);
	assert.deepEqual(outcome.findings, ["f-1-A"], "the ledger, not only the packet, says what the comparison produced");
	// The child's only statement about the task is a marker in its own directory: task.json has
	// one writer, and it is not this process — two writers would bump stateVersion from one base
	// and hand two different states the same version.
	assert.equal(JSON.parse(fs.readFileSync(path.join(batchDir, "done.json"), "utf8")).status, "ready");
	assert.equal(loadTask(dir).stateVersion, versionBefore, "the batch child never writes task.json");
	assert.deepEqual(loadTask(dir).current.activeBranches.map((b) => b.batchId), [1], "the entry leaves on the executor's next save, not here");
});

// Re-running a finished batch would re-spawn every replicate against a budget already charged,
// and overwrite the rows and reports its findings were drawn from — before compareReady's own
// refusal ever fired.
test("run-batch over a batch that has already been read out re-runs nothing", async () => {
	const { dir, specFile, tagged } = batchFixture({ finished: false });
	const { calls, runner } = fakeRunner([tagged.filter((r) => r.label === "G"), tagged.filter((r) => r.label === "A")]);
	await runBatchSpec({ taskDir: dir, specFile, runner });
	const rowsBefore = readLedger(dir).length;

	const again = await runBatchSpec({ taskDir: dir, specFile, runner });
	assert.equal(again.alreadyReady, true);
	assert.equal(again.packetId, 1);
	assert.equal(calls.length, 2, "no branch is run a second time");
	assert.equal(readLedger(dir).length, rowsBefore, "and no outcome row calls a finished batch a failure");
});

// The collision preflight holds the SOURCE run's paths, so every later branch would fail the
// same way: one crashed row per branch, `firstTry 0/1` on both sides, `same` in both directions —
// and a candidate of that shape SETTLED verified by a batch that never ran.
test("a batch abandoned on the collision preflight stops, records the collision, and reads out nothing", async () => {
	const { dir, specFile, batchDir, tagged } = batchFixture({ finished: false });
	const { calls, runner } = fakeRunner([[{ ...tagged[0], crashed: true, label: "G" }]], { abandonAt: 1 });
	const out = await runBatchSpec({ taskDir: dir, specFile, runner });

	assert.equal(calls.length, 1, "the second branch is never started");
	assert.equal(out.abandoned.branch, "G");
	assert.deepEqual(readLedger(dir).at(-1).outcome, { batchId: 1, failed: "collision", branch: "G", rows: 1 });
	assert.equal(fs.existsSync(path.join(batchDir, "ready.json")), false, "no comparison_ready, because there was no comparison");
	assert.deepEqual(readFindings(dir), [], "and above all no finding");
	assert.equal(JSON.parse(fs.readFileSync(path.join(batchDir, "done.json"), "utf8")).status, "failed");
});

// The same guard one level in: a batch that limped to the end with fewer replicates than it was
// charged for is still not a comparison.
test("a short batch produces the packet but no finding, and says which branch came up short", () => {
	const short = ROWS.filter((r) => r.label === "G" || r.replicate === 1);
	const { dir, batchDir } = batchFixture({ rows: short });
	const out = compareReady({ taskDir: dir, batchDir });
	assert.deepEqual(out.short, [{ label: "A", rows: 1, crashed: 0, replicates: 3 }]);
	assert.deepEqual(out.findings, [], "no claim from a branch that ran once");
	assert.deepEqual(readFindings(dir), []);
	assert.equal(out.packetId, 1, "the manager is still shown the read-out and decides whether to pay again");
});

test("a branch that ran its full count and crashed every replicate delivered nothing", () => {
	const crashed = ROWS.map((r) => (r.label === "A" ? { ...r, crashed: true } : r));
	const { dir, batchDir } = batchFixture({ rows: crashed });
	const out = compareReady({ taskDir: dir, batchDir });
	assert.deepEqual(out.short, [{ label: "A", rows: 3, crashed: 3, replicates: 3 }]);
	assert.deepEqual(readFindings(dir), []);
});

// The gate is not "every replicate finished". Crashes happen in these runs, and that stricter
// rule would let one crashed replicate suppress every finding the batch paid for.
test("one crashed replicate does not suppress the comparison; it stays in the denominator", () => {
	const oneCrash = ROWS.map((r) => (r.label === "A" && r.replicate === 3 ? { ...r, crashed: true } : r));
	const { dir, batchDir } = batchFixture({ rows: oneCrash });
	const out = compareReady({ taskDir: dir, batchDir });
	assert.deepEqual(out.short, null);
	assert.equal(out.findings.length, 1);
	assert.match(out.findings[0].claim, /first-try oracle 1\/3 vs 1\/3/, "three replicates, one of which crashed and passed nothing");
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
	// A batch that died still says it is over: otherwise its entry blocks every later restore
	// and compare until staleBatchMs runs out.
	assert.equal(JSON.parse(fs.readFileSync(path.join(batchDir, "done.json"), "utf8")).status, "failed");
});

// The outcome row is the manager's handle on a restored run, NOT current.activeRuns: runOnce
// awaits the supervisor's exit, so the id exists only once the run is over, and a dead run in
// activeRuns would validate a continue whose grant is charged into a control file nothing tails.
test("a restore's batch reports its run in the ledger, leaves activeRuns alone, and claims no finding", async () => {
	const { dir, specFile, tagged } = batchFixture({ kind: "restore", finished: false, branches: [{ label: "A-natural", firstAction: "done" }] });
	const { runner } = fakeRunner([[{ ...tagged[3], label: "A-natural" }]]);
	const out = await runBatchSpec({ taskDir: dir, specFile, runner });
	assert.equal(out.runId, "run-3");
	assert.deepEqual(readLedger(dir).at(-1).outcome, { batchId: 1, runId: "run-3", crashed: false });
	assert.deepEqual(loadTask(dir).current.activeRuns, [], "a run that has already exited is not live");
	assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(specFile), "done.json"), "utf8")).status, "ready", "the marker is how the executor learns the batch is over");
	assert.deepEqual(readFindings(dir), [], "one branch against nothing claims nothing");
});
