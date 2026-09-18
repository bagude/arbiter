import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTask, loadTask, saveTask, setCurrent, spendBudget } from "../lib/manage/task-state.mjs";
import { assemblePacket, writePacket } from "../lib/manage/packet.mjs";
import { appendFinding, appendLedger, reverseRow, settleFinding } from "../lib/manage/ledger.mjs";

const criteria = [{ id: "c1", text: "all 70 oracle cases pass", check: "oracle:tasks/pathnorm/oracle" }];
const milestones = [{ id: "m1", title: "pass", criteria: ["c1"] }];

function mkTaskDir(budget = { wallSec: 3600, runs: 4, forkReplicates: 12, usd: 5 }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-"));
	createTask({ dir, taskId: "t1", goal: "pass pathnorm", criteria, milestones, budget });
	return dir;
}

function mkRunDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ reason: "FAILED: done attempts exhausted", wallSec: 100, task: "pathnorm", guards: {}, doneAttempts: 2 }));
	fs.writeFileSync(
		path.join(dir, "audit.jsonl"),
		[
			{ t: "1.0", type: "oracle", msg: "Oracle run #1: 68/70 passed." },
			{ t: "2.0", type: "oracle", msg: "Oracle run #2: 68/70 passed." },
			{ t: "3.0", type: "mail", msg: "MAIL #5 orchestrator -> supervisor [done] Claiming done." },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "decisions.jsonl"),
		[
			{ i: 0, substantive: { cls: "spawn" } },
			{ i: 1, substantive: { cls: "resume" } },
			{ i: 2, substantive: { cls: "done" } },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "decisions-replay-substantive.jsonl"),
		JSON.stringify({ i: 2, substantive: { cls: "done" }, head: { pickClass: "probe", confidence: 0.93, agreeSubstantive: false } }) + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "workers.jsonl"),
		[
			{ ts: 1, ev: "started", wid: "worker:a", description: "write tests", background: false, type: "tester" },
			{ ts: 2, ev: "completed", wid: "worker:a", status: "completed", outcome: "completed" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	const sessDir = path.join(dir, "sessions", "orchestrator");
	fs.mkdirSync(sessDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessDir, "2026-09-18T00-00-00-000Z_session.jsonl"),
		[
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Setting TYPESAFE_API_KEY=apikey_29abcdefghijklmnopqrstuvwxyz before probing." }] } },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	return dir;
}

/**
 * A run as it looks WHILE it is running: no summary.json, because the supervisor writes that in
 * finish(). This is the shape runs/2026-09-18T04-53-07 had on disk when the first live check
 * tried to build a packet at its pause and threw ENOENT instead.
 */
function mkLiveRunDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-"));
	fs.writeFileSync(
		path.join(dir, "audit.jsonl"),
		[
			{ t: "0.1", type: "ready", msg: "orchestrator ready; kicking off" },
			{ t: "12.4", type: "tool", agent: "orchestrator", msg: "bash npm test" },
			{ t: "20.0", type: "tool", agent: "worker:a", msg: "edit src/index.mjs" },
			{ t: "30.2", type: "mail", msg: "MAIL #1 orchestrator -> supervisor [done] Claiming done." },
			{ t: "34.9", type: "oracle", msg: "Oracle run #1: 68/70 passed." },
			{ t: "34.9", type: "manage", msg: "trigger oracle_failed_repeatedly (orchestrator paused): {}" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(dir, "workers.jsonl"),
		[
			{ ts: 1, ev: "started", wid: "worker:a", description: "write tests", background: false, type: "tester" },
			{ ts: 2, ev: "completed", wid: "worker:a", status: "completed", outcome: "completed" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n") + "\n",
	);
	fs.mkdirSync(path.join(dir, "oracle-1"), { recursive: true });
	return dir;
}

// Every PAUSING trigger fires mid-run by definition — the orchestrator is blocked on a delivery
// the supervisor is withholding — so a packet that needs summary.json is a packet that cannot
// be built at the moments the manager exists for.
test("a packet can be built for a LIVE run, which has no summary.json", () => {
	const taskDir = mkTaskDir();
	const runDir = mkLiveRunDir();
	assert.ok(!fs.existsSync(path.join(runDir, "summary.json")), "the fixture must really lack the summary");

	const packet = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: path.basename(runDir), detail: { attempts: 1 } } });
	assert.equal(packet.run.status, "running");
	assert.equal(packet.run.reason, null, "the field that would say the run ended stays empty");
	assert.equal(packet.run.id, path.basename(runDir));
	assert.equal(packet.run.wallSec, 34.9, "elapsed comes from the last audit line while the run is alive");
	assert.equal(packet.run.toolCalls, 2, "counted from the audit, as it already was");
	assert.equal(packet.run.mails, 1);
	assert.deepEqual(packet.run.oracle, [{ attempt: 1, pass: 68, total: 70 }]);
	assert.equal(packet.run.doneAttempts, 1, "the oracle-N directories say how many attempts have happened");
	assert.deepEqual(packet.run.workers.map((w) => [w.wid, w.type, w.status]), [["worker:a", "tester", "completed"]]);
	// Tokens live in the supervisor's memory and reach disk only in finish(). Zero would read as
	// a measurement — a run that decoded nothing — which is a different claim from "not known
	// yet", and the manager is being asked to judge cost. Null, and named in `partial`.
	assert.equal(packet.run.tokens, null);
	// The config is the same kind of gap: only summary.json records configPath, and `run.config`
	// is where a restore or compare gets the config to spawn with.
	assert.equal(packet.run.config, null);
	assert.deepEqual(packet.run.partial, ["tokens", "config"]);

	// A run that does carry its config leaves only tokens unknown.
	fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({ task: "pathnorm" }));
	const withConfig = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: path.basename(runDir), detail: {} } });
	assert.equal(withConfig.run.config, path.join(runDir, "config.json"));
	assert.deepEqual(withConfig.run.partial, ["tokens"]);
	// And the rest of the §2 shape is unchanged: the manager gets the same fields either way.
	for (const k of ["milestone", "guards", "decisions", "heads", "chain", "tail"]) assert.ok(k in packet.run, `run.${k} missing`);
	assert.ok(packet.options.verbsAllowed.includes("continue"));
});

// What the supervisor's startup line is for: a live run carries no summary.json and usually no
// config copy either, and `restore` and `compare` need a config path to spawn with. The line is
// `{ type: "config", msg: <path> }` and `msg` is read AS the path — so this test is also what
// pins the supervisor to logging the bare path rather than a sentence about it.
test("a live run's config comes from its startup audit line when no copy is beside it", () => {
	const taskDir = mkTaskDir();
	const runDir = mkLiveRunDir();
	const audit = path.join(runDir, "audit.jsonl");
	fs.writeFileSync(audit, JSON.stringify({ t: "0.0", type: "config", msg: "configs/orch-pathnorm-27b.json" }) + "\n" + fs.readFileSync(audit, "utf8"));

	const packet = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: path.basename(runDir), detail: {} } });
	assert.equal(packet.run.config, "configs/orch-pathnorm-27b.json");
	assert.deepEqual(packet.run.partial, ["tokens"], "the config is no longer a gap");
});

// The command the driver actually runs at a trigger. It threw ENOENT on the live check; if it
// throws again, the pause it was answering is left to time out and the evidence is lost.
test("tools/manage.mjs packet succeeds against a live run directory", () => {
	const taskDir = mkTaskDir();
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
	const runId = "2026-09-18T04-53-07";
	fs.cpSync(mkLiveRunDir(), path.join(runsDir, runId), { recursive: true });

	const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "manage.mjs");
	const r = spawnSync(process.execPath, [cli, "packet", taskDir, runId, "--trigger", "oracle_failed_repeatedly", "--detail", JSON.stringify({ attempts: 1 }), "--runs", runsDir], { encoding: "utf8" });
	assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
	assert.match(r.stdout, /packets[\\/]1\.json/);
	const written = JSON.parse(fs.readFileSync(path.join(taskDir, "packets", "1.json"), "utf8"));
	assert.equal(written.run.status, "running");
	assert.equal(written.trigger.runId, runId);

	// The command is also the only place a supervisor's run gets into current.activeRuns — the
	// supervisor cannot write task.json — and without that every `continue` and `correct` for a
	// real run is refused as "not live" (the live check of 2026-09-18). The registration happens
	// BEFORE the packet, so the version the manager answers with is the one it produced.
	assert.deepEqual(loadTask(taskDir).current.activeRuns, [runId]);
	assert.equal(written.task.stateVersion, loadTask(taskDir).stateVersion, "the packet carries the post-registration version");
	// And it is the registration's own version, not merely the latest: the command says which it
	// wrote, and that is the number the manager's basedOnStateVersion has to match.
	const said = /stateVersion (\d+)/.exec(r.stderr);
	assert.ok(said, `the packet command must report the version it registered at; stderr was: ${r.stderr}`);
	assert.equal(written.task.stateVersion, Number(said[1]));
	// The derived live list travels with it, beside pendingBatches.
	assert.deepEqual(written.options.pendingRuns, [runId], "the run this packet is about is live");
	assert.deepEqual(written.options.pendingBatches, []);
	assert.equal(written.task.current.activeRuns[0], runId);

	// And the run leaving is the same path in reverse.
	const ended = spawnSync(process.execPath, [cli, "packet", taskDir, runId, "--trigger", "run_ended_without_acceptance", "--runs", runsDir], { encoding: "utf8" });
	assert.equal(ended.status, 0, ended.stderr);
	assert.deepEqual(loadTask(taskDir).current.activeRuns, []);
});

// An instruction whose save lost the compare-and-swap is retracted by a `reversed` row: it did
// not run. Handing it back as recent history invites the manager to reason from an act that
// never happened, and pushes a real one out of the five.
test("history.recentInstructions leaves out an instruction a reversed row retracts", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	appendLedger(taskDir, { packetId: 1, instruction: { idempotencyKey: "p1-v1", verb: "correct" }, verified: true });
	const lost = appendLedger(taskDir, { packetId: 2, instruction: { idempotencyKey: "p2-v2", verb: "compare" }, verified: true });
	reverseRow(taskDir, lost.seq, "stale_version");

	const verbs = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended_without_acceptance", runId: "r1" } }).history.recentInstructions.map((r) => r.verb);
	assert.ok(verbs.includes("correct"), "the instruction that ran is history");
	assert.ok(!verbs.includes("compare"), "the one that did not, is not");
});

test("a finished run still reads its summary, and says so", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	const packet = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended_without_acceptance", runId: "r1" } });
	assert.equal(packet.run.status, "finished");
	assert.equal(packet.run.reason, "FAILED: done attempts exhausted");
	assert.equal(packet.run.wallSec, 100, "the summary's own figure, not the audit's last line");
	assert.equal(packet.run.doneAttempts, 2);
	assert.equal(packet.run.partial, null, "nothing is partial once the summary is on disk — the field is the live case's alone");
});

test("assemblePacket builds the §2 shape, redacts secrets, bounds size, and numbers packets by directory count", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	const p = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { attempts: 2 } }, verbsAllowed: ["continue", "correct", "restore", "compare", "accept", "escalate"] });
	assert.equal(p.packetId, 1);
	assert.deepEqual(p.task, loadTask(taskDir), "the task state travels whole");
	assert.equal(p.run.oracle.length, 2);
	assert.equal(p.run.decisions.points, 3);
	assert.equal(p.run.heads.local27b.confidentDisagreements.length, 1);
	assert.ok(!JSON.stringify(p).includes("apikey_29abc"), "redacted");
	assert.ok(JSON.stringify(p).length <= 120000);
	assert.deepEqual(p.options.verbsAllowed, ["continue", "correct", "restore", "compare", "accept", "escalate"]);
	assert.equal(writePacket(taskDir, p), path.join(taskDir, "packets", "1.json"));
	const p2 = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { attempts: 2 } }, verbsAllowed: ["continue"] });
	assert.equal(p2.packetId, 2, "numbers by the max numeric id on disk + 1, and only 1.json exists yet");
});

test("packet numbering survives a gap and a stray non-numeric file, and writePacket refuses to overwrite an id already on disk", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	const packetsDir = path.join(taskDir, "packets");
	fs.mkdirSync(packetsDir, { recursive: true });
	fs.writeFileSync(path.join(packetsDir, "1.json"), "{}");
	fs.writeFileSync(path.join(packetsDir, "3.json"), "{}"); // 2.json deleted — a gap
	fs.writeFileSync(path.join(packetsDir, "notes.json"), "{}"); // stray, non-numeric-stem file

	const p = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } });
	assert.equal(p.packetId, 4, "max numeric id (3) + 1, not count-of-files (3) + 1, and notes.json is ignored");
	assert.equal(writePacket(taskDir, p), path.join(packetsDir, "4.json"));

	assert.throws(() => fs.writeFileSync(path.join(packetsDir, "3.json"), "overwritten", { flag: "wx" }), /EEXIST/, "sanity: 'wx' is exclusive-create on this platform");
	assert.throws(() => writePacket(taskDir, { ...p, packetId: 3 }), /EEXIST/, "writePacket must never silently overwrite an id already on disk");
	assert.equal(fs.readFileSync(path.join(packetsDir, "3.json"), "utf8"), "{}", "the existing packet is untouched");
});

test("a blanket redact() pass catches secrets outside the targeted fields: a finding's claim and a trigger's detail", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	appendFinding(taskDir, {
		id: "f1",
		scope: "harness:pathnorm",
		claim: "leaked during a compare run: TOKEN=apikey_finding9876543210abcdef",
		settlement_criterion: "reproduces on a second run",
	});
	const p = assemblePacket({
		taskDir,
		runDir,
		trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { note: "captured from the transcript: apikey_trigger1234567890abcdef" } },
	});
	assert.equal(p.history.settledFindings.length, 1, "the candidate finding travels into the packet");
	const rendered = JSON.stringify(p);
	assert.ok(!rendered.includes("apikey_finding9876543210"), "settledFindings.claim is redacted, not just the targeted fields");
	assert.ok(!rendered.includes("apikey_trigger1234567890"), "trigger.detail is redacted too");
});

test("default verbsAllowed prunes accept off milestone_candidate/comparison_ready, and prunes compare/restore once fork and run budget are both spent", () => {
	const runDir = mkRunDir();

	const plentyDir = mkTaskDir();
	const notMilestone = assemblePacket({ taskDir: plentyDir, runDir, trigger: { kind: "run_ended_without_acceptance", runId: "r1" } });
	assert.ok(!notMilestone.options.verbsAllowed.includes("accept"), "trigger is not milestone_candidate or comparison_ready");
	assert.ok(notMilestone.options.verbsAllowed.includes("restore"), "budget is not exhausted");
	assert.ok(notMilestone.options.verbsAllowed.includes("compare"));

	const isMilestone = assemblePacket({ taskDir: plentyDir, runDir, trigger: { kind: "milestone_candidate", runId: "r1" } });
	assert.ok(isMilestone.options.verbsAllowed.includes("accept"));

	const brokeDir = mkTaskDir({ runs: 1, forkReplicates: 1 });
	let t = loadTask(brokeDir);
	t = saveTask(brokeDir, spendBudget(t, { runs: 1, forkReplicates: 1 }));
	const exhausted = assemblePacket({ taskDir: brokeDir, runDir, trigger: { kind: "milestone_candidate", runId: "r1" } });
	assert.ok(!exhausted.options.verbsAllowed.includes("restore"), "both forkReplicates and runs budgetLeft are 0");
	assert.ok(!exhausted.options.verbsAllowed.includes("compare"));
	assert.ok(exhausted.options.verbsAllowed.includes("accept"), "accept is unaffected by the fork/run budget rule");
});

test("while a run is live, restore and compare are not advertised: the harness would refuse them", () => {
	// The trigger where changing approach matters most is a PAUSING one, which fires mid-run by
	// definition — so advertising the two verbs that liveWorkRefusal always refuses there invited
	// the right answer and then rejected it.
	const taskDir = mkTaskDir();
	const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
	const liveDir = path.join(runsRoot, "2026-09-18T01-02-03");
	fs.mkdirSync(liveDir, { recursive: true });
	fs.writeFileSync(path.join(liveDir, "audit.jsonl"), JSON.stringify({ t: "1.0", type: "oracle", msg: "Oracle run #1: 68/70 passed." }) + "\n");
	saveTask(taskDir, setCurrent(loadTask(taskDir), { activeRuns: ["2026-09-18T01-02-03"] }));

	const p = assemblePacket({ taskDir, runDir: liveDir, trigger: { kind: "oracle_failed_repeatedly", runId: "2026-09-18T01-02-03", detail: { attempts: 2 } } });
	assert.deepEqual(p.options.pendingRuns, ["2026-09-18T01-02-03"]);
	assert.ok(!p.options.verbsAllowed.includes("restore"), "a live run refuses a restore; the packet must not offer one");
	assert.ok(!p.options.verbsAllowed.includes("compare"));
	assert.ok(p.options.verbsAllowed.includes("correct"), "the verbs that DO work at a pausing trigger are still there");
	assert.ok(p.options.verbsAllowed.includes("continue"));
	assert.ok(p.options.verbsAllowed.includes("escalate"));
});

test("bounding ladder drops tail, then chain, in order, and the FINAL rendered packet (bounded field included) always fits maxChars", () => {
	const taskDir = mkTaskDir();
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
	fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ reason: "x", wallSec: 1, task: "pathnorm", guards: {}, doneAttempts: 1 }));
	// 40+ chain-eligible lines so the chain fills its 40-line cap with real bulk, and a long
	// tail, so a tight maxChars has to drop both — not just the first thing it tries.
	const auditRows = [];
	for (let i = 0; i < 50; i++) auditRows.push({ t: String(i), type: "oracle", msg: `Oracle run #${i}: 68/70 passed. padding ${"z".repeat(80)}` });
	fs.writeFileSync(path.join(runDir, "audit.jsonl"), auditRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	fs.writeFileSync(path.join(runDir, "decisions.jsonl"), "");
	const sessDir = path.join(runDir, "sessions", "orchestrator");
	fs.mkdirSync(sessDir, { recursive: true });
	fs.writeFileSync(path.join(sessDir, "s.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(3000) }] } }) + "\n");

	const full = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } });
	assert.equal(full.run.tail.length, 2000, "unbounded, the tail is the full 2 000-char slice");
	assert.equal(full.run.chain.length, 40, "unbounded, the chain keeps its 40-line cap");
	assert.equal(full.bounded, null);
	assert.ok(JSON.stringify(full).length > 8000, "the fixture is big enough that 8 000 chars forces real drops");

	const tight = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" }, maxChars: 8000 });
	assert.equal(tight.run.tail, "", "tail goes first");
	assert.deepEqual(tight.run.chain, [], "chain goes second, because tail alone was not enough");
	assert.deepEqual(tight.bounded, ["tail", "chain"]);
	assert.ok(JSON.stringify(tight).length <= 8000, "the size check must include packet.bounded itself, not just the pre-assignment render");
});

test("a packet that cannot be redacted is refused by name, not thrown as a bare parse error", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	// The one JSON.parse in the path a PAUSED orchestrator is waiting on. No input is known to
	// break redact's round trip — every replacement is a bracketed literal or a $1 that reproduces
	// its own captured prefix — so the guard is exercised by making the parse fail on purpose.
	const bad = () => { throw new SyntaxError("Unexpected token } in JSON at position 12"); };
	const real = JSON.parse;
	// Only the final render carries `bounded`, so this cannot fire on a ledger row or a summary
	// the assembler parses on the way — those carry a packetId but never this field.
	JSON.parse = new Proxy(real, { apply: (t, self, args) => (args[0]?.includes?.('"bounded"') ? bad() : Reflect.apply(t, self, args)) });
	try {
		assert.throws(
			() => assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } }),
			/the redacted packet is not valid JSON and cannot be sent/,
		);
	} finally {
		JSON.parse = real;
	}
});

test("findings are the last rung: candidates go first, then the list, so a long-lived task still fits", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	// The mechanism behind the deferred Task 1 minor: `task` is verbatim by design and
	// readFindings is unsliced, so a task that has accumulated findings grows every packet with
	// nothing left to drop once the tail, the chain and the worker summaries are gone.
	for (let i = 0; i < 12; i++) {
		appendFinding(taskDir, { id: `f${i}`, scope: "harness:pathnorm", claim: `a claim about gathers, number ${i}, ${"padding ".repeat(40)}`, settlement_criterion: "A equals G across 3 replicates on 2 runs", evidence: [`docs/batch/fork-${i}.md`] });
	}
	settleFinding(taskDir, "f0", { status: "verified", verifiedOn: ["run-a", "run-b"] });

	const full = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } });
	assert.equal(full.history.settledFindings.length, 12);

	const size = JSON.stringify(full).length;
	const someFindings = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" }, maxChars: size - 2000 });
	assert.deepEqual(someFindings.history.settledFindings.map((f) => f.id), ["f0"], "the verified one is what a later decision can rely on");
	assert.ok(someFindings.bounded.includes("candidate findings"));

	const none = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" }, maxChars: 1000 });
	assert.deepEqual(none.history.settledFindings, []);
	assert.ok(none.bounded.includes("findings"));
	// Every earlier rung went first: findings are the last thing dropped, not the first.
	assert.ok(none.bounded.indexOf("findings") > none.bounded.indexOf("tail"));
});

// §2 puts task.json in the packet verbatim, and `current.activeBranches` keeps a finished batch
// until some later instruction saves — the executor is task.json's only writer. The manager's
// only view is this packet, and "is work already running?" is the question restore and compare
// turn on, so the derived list sits in options, where budgetLeft already says what the harness
// worked out.
test("options.pendingBatches is the live list, while task stays verbatim", () => {
	const taskDir = mkTaskDir();
	const runDir = mkRunDir();
	const hour = 60 * 60 * 1000;
	const branches = [
		{ batchId: 1, kind: "compare", launchedAt: Date.now() },              // in flight
		{ batchId: 2, kind: "restore", launchedAt: Date.now() },              // finished, marker below
		{ batchId: 3, kind: "compare", launchedAt: Date.now() - 5 * hour },   // nobody ever closed it
	];
	saveTask(taskDir, { ...loadTask(taskDir), current: { ...loadTask(taskDir).current, activeBranches: branches } });
	fs.mkdirSync(path.join(taskDir, "compares", "2"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "compares", "2", "done.json"), JSON.stringify({ batchId: 2, status: "ready", ts: Date.now() }));

	const p = assemblePacket({ taskDir, runDir, trigger: { kind: "run_ended", runId: "r1" } });
	assert.deepEqual(p.options.pendingBatches.map((b) => b.batchId), [1], "the finished one and the stale one are not in flight");
	assert.deepEqual(p.task.current.activeBranches.map((b) => b.batchId), [1, 2, 3], "and the record itself is untouched — §7 replays what was written");
});
