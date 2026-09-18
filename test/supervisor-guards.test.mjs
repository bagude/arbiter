import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// supervisor.mjs's source, with line endings normalised. The repo is committed LF but
// core.autocrlf checks it out CRLF on Windows, so every multi-line assertion below would
// otherwise pass or fail depending on which machine ran it.
function supervisorSource() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8").replace(/\r\n/g, "\n");
}

// A run that has already written a valid summary.json must not then die on the way out.
// finish() writes the summary and tears the run down, but events still in flight keep
// arriving: an `agent_end` after FINISH becomes a silent-turn nudge, deliver() calls send(),
// and the child's stdin is already closed. `exitCode !== null` does not cover that window —
// stdin closes first and exitCode stays null until the process is reaped — so the write raised
// an unhandled EPIPE and the supervisor exited 1 on top of a SUCCESS run (runs/2026-09-17T18-09-28,
// FINISH at 623.3 s, throw at 623.4 s). Sliced to send()'s own body: a `finished` check
// elsewhere in the file cannot satisfy this.
test("send() writes nothing once the run is finished or the child's stdin is gone", () => {
	const src = supervisorSource();
	const at = src.indexOf("\nfunction send(name, cmd) {\n");
	assert.ok(at >= 0, "could not locate send() in supervisor.mjs");
	const body = src.slice(at + 1);
	const fn = body.slice(0, body.indexOf("\n}\n"));
	assert.ok(fn.includes("if (finished) return;"), `send() must refuse to write after finish(); found:\n${fn}`);
	for (const needle of ["stdin.destroyed", "stdin.writableEnded", "stdin.writable === false"]) {
		assert.ok(fn.includes(needle), `send() must check ${needle} — exitCode alone misses the window between stdin closing and the process being reaped; found:\n${fn}`);
	}
	// The checks are only worth anything before the write they guard.
	assert.ok(fn.indexOf("if (finished) return;") < fn.indexOf("stdin.write("), "the finished check must precede the write");
	assert.ok(fn.indexOf("stdin.destroyed") < fn.indexOf("stdin.write("), "the pipe checks must precede the write");
});

// pi's extension runner returns the FIRST blocking tool_call result, so a guard
// that denies `subagent` must precede pre-spawn-compact in supervisor.mjs's GUARDS
// list or its reason never reaches the model. Read the source rather than import
// supervisor.mjs (importing it starts a run).
test("GUARDS lists topology.ts immediately before pre-spawn-compact.ts", () => {
	const src = supervisorSource();
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const t = names.indexOf("topology.ts");
	assert.ok(t >= 0, `topology.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[t + 1], "pre-spawn-compact.ts");
});

// pi's extension runner returns the FIRST blocking tool_call result, so the fork's
// forcing must be seen before the topology nudge on the same spawn.
test("GUARDS lists fork-force.ts immediately before topology.ts", () => {
	const src = supervisorSource();
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const f = names.indexOf("fork-force.ts");
	assert.ok(f >= 0, `fork-force.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[f + 1], "topology.ts");
});

// Fork mode is env-driven and lives entirely inside supervisor.mjs, which no test
// can import (importing it starts a run). Task 6 is the real verification; this
// pins the shape so the four load-bearing pieces cannot quietly go missing:
// the fork spec is read, the orchestrator is resumed from a session FILE, the
// lifecycle records the continue, and the kickoff is skipped when forking.
test("supervisor carries fork mode: forkSpec, --session, fork:continue, guarded kickoff", () => {
	const src = supervisorSource();
	assert.match(src, /import \{[^}]*\bforkSpec\b[^}]*\} from "\.\/lib\/fork\.mjs"/, "supervisor must import forkSpec from ./lib/fork.mjs");
	// The quotes matter: bare --session also matches the existing "--session-dir".
	assert.ok(src.includes('"--session"'), 'supervisor must pass "--session" (the truncated file) to the forked orchestrator');
	assert.ok(src.includes('ev: "fork:continue"'), "supervisor must append a fork:continue lifecycle event");
	// The kickoff must be the `else` arm of the fork branch, and there must be only one
	// of it — an unguarded second copy would deliver a prompt into the restored prefix.
	const lines = src.split("\n");
	const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.includes("M.kickoff.orchestrator()"));
	assert.equal(hits.length, 1, `M.kickoff.orchestrator() must appear exactly once, found ${hits.length}`);
	const [line, k] = hits[0];
	const guarded = /(^|\s)else(\s|$)/.test(line.slice(0, line.indexOf("M.kickoff.orchestrator()"))) || /(^|\s)else(\s|\{|$)/.test(lines[k - 1] ?? "");
	assert.ok(guarded, `the orchestrator kickoff must be the else arm of the FORK branch; found:\n${lines[k - 1]}\n${line}`);
});

// A manager's `restore` delivers its message through the fork runner, which can only hand the
// supervisor a path: the copy into runs/<newId>/control.jsonl has to happen HERE, inside the
// fork block, after the run directory exists and before the `continue` resumes the
// orchestrator. Copied later, the first inference would go out before the message; copied
// outside the FORK branch, an ordinary run would inherit whatever that variable held.
test("the fork path copies ARBITER_FORK_CONTROL into the new run, inside the fork block and before the continue", () => {
	const src = supervisorSource();
	const at = src.indexOf("\nif (FORK) {\n\t// Sessions: the recorded orchestrator tree");
	assert.ok(at >= 0, "could not locate the fork restoration block in supervisor.mjs");
	const block = src.slice(at, src.indexOf("\nconst readyTimer = setInterval(", at));
	assert.ok(block.includes('const forkControl = (process.env.ARBITER_FORK_CONTROL ?? "").trim();'), `the copy must read ARBITER_FORK_CONTROL and treat empty as absent; found:\n${block.slice(0, 900)}`);
	assert.ok(block.includes('fs.copyFileSync(forkControl, path.join(RUN, "control.jsonl"));'), "and copy it to the new run's control file");
	assert.ok(block.includes("forkAbort(`ARBITER_FORK_CONTROL names a control file that does not exist"), "a named control file that is missing must abort the fork, not be ignored");
	// Only there: an ordinary run must never read this variable.
	assert.equal(src.split("ARBITER_FORK_CONTROL").length - 1, 3, "ARBITER_FORK_CONTROL belongs to the fork block alone");
	assert.ok(src.indexOf("copyFileSync(forkControl") < src.indexOf('send("orchestrator", { id: "fork-continue", type: "continue" });'), "the control file must be in place before the orchestrator is resumed");
});

// The fork's failure modes are the part a live run is least likely to exercise and most
// likely to be silently broken by: a bad spec must exit rather than start a half-run, the
// counters and the recorded prompt must actually be restored, and the summary must record
// what was forked.
test("supervisor's fork mode preflights, re-seeds and records what it forked", () => {
	const src = supervisorSource();
	for (const [needle, why] of [
		["process.exit(2)", "a rejected fork spec must exit(2), not throw or start a run"],
		["forkCounters(", "the harness counters must be re-seeded from the recorded decision points"],
		["prompts.orchestrator = fs.readFileSync", "the recorded system prompt must be restored verbatim"],
		["summary.fork =", "summary.json must record what this run was forked from"],
		["FORK_REQ.snapshot", "the workspace snapshot must be preflighted and restored"],
		// Nothing in the record carries the task or the model — the --config does, and it drives
		// installMounts, readMounts, the probe harness and the oracle. Forked with a different
		// task, the orchestrator is restored with the source run's history and then scored
		// against a harness that has nothing to do with it, and nothing else would say so.
		["FORK_SRC_SUMMARY.task !== TASK_NAME", "a fork must refuse a config whose task is not the source run's"],
		["FORK_SRC_MODEL !== ROLES.orchestrator.model", "a fork must refuse a config whose orchestrator model is not the one the recorded request was sent to"],
		// pi's loadExtension CATCHES a module-scope throw, records a diagnostic and runs on with
		// the guard unregistered, and rpc mode surfaces no diagnostics — so the guard's own
		// throw on an unreadable force file is invisible from here. An A branch that cannot arm
		// itself has to be refused BEFORE any agent starts, or it runs silently like branch G.
		["ARBITER_FORK_FORCE names a force file that cannot be read", "the fork preflight must read the force file itself, not trust the guard to fail loudly"],
		['!force.cls', "a force spec with no action class denies every call of the run and must be refused"],
	]) {
		assert.ok(src.includes(needle), `${why} (missing: ${needle})`);
	}
	// The counter re-seed runs at module scope AFTER the workspace copy has created
	// runs/.ws-<src>, and forkCounters throws on a `call` past the end of the source run —
	// the likeliest fork error there is. Unguarded, the process died on an uncaught
	// exception, the directory survived, and the collision preflight then refused every
	// retry. So the call must sit in a try whose catch reaches forkAbort, which releases
	// both directories. Sliced to that block: a try elsewhere in the file cannot satisfy it.
	const seed = forkBlockAfter(src, "// Fork counter re-seed.");
	const call = seed.indexOf("forkCounters(");
	assert.ok(call >= 0, `the counter re-seed block must call forkCounters; found:\n${seed}`);
	const tryAt = seed.indexOf("try {");
	assert.ok(tryAt >= 0 && tryAt < call, `forkCounters must run inside a try; found:\n${seed}`);
	assert.ok(seed.indexOf("forkAbort(", call) > call, `the counter re-seed's catch must reach forkAbort so an abort releases both directories; found:\n${seed}`);
});

// The body of the next top-level `if (FORK) {` block below `marker`, so an assertion about
// fork mode cannot be satisfied by a string that merely appears somewhere else in the file.
function forkBlockAfter(src, marker) {
	const at = src.indexOf(marker);
	assert.ok(at >= 0, `could not locate ${marker} in supervisor.mjs`);
	const open = src.indexOf("\nif (FORK) {\n", at);
	assert.ok(open >= 0, `no fork block below ${marker} in supervisor.mjs`);
	const body = src.slice(open + 1);
	const close = body.indexOf("\n}\n"); // the block's own closing brace, at column 0
	assert.ok(close >= 0, `unterminated fork block below ${marker} in supervisor.mjs`);
	return body.slice(0, close);
}

// Three of the planned forks resume a source worker, and pi-subagents resumes by session
// id, appending to the transcript the session copy brought in. So the source run's workers
// are restored rather than ignored: state recreated, transcript pre-bound to its own id,
// tail started at end-of-file. Pre-binding is also the FIFO-bind exclusion — bindTranscript
// returns early on a path tracker.bound already holds — so if the pre-bind went missing the
// fork's own first spawn would silently adopt an inherited transcript.
test("supervisor's fork mode restores the source run's workers", () => {
	const src = supervisorSource();
	// Everything below must be in the fork block, not merely somewhere in the file.
	const start = src.indexOf("\nif (FORK) {\n\t// Sessions:");
	assert.ok(start >= 0, "could not locate the fork block in supervisor.mjs");
	const block = src.slice(start + 1);
	const fork = block.slice(0, block.indexOf("\n}\n"));
	for (const [needle, why] of [
		["readManifest(FORK_SRC)", "the source run's workers.jsonl must be read in the fork block"],
		["ensureWorker(state, row.wid)", "each source worker's agent state must be created the way a live spawn creates it"],
		["tracker.bound.set(", "each source transcript must be pre-bound to its own wid, which is also the FIFO-bind exclusion"],
		["tail.offset = fs.statSync(p).size", "an inherited tail must start at end-of-file so nothing pre-fork is counted"],
		["FORK_SOURCE_WORKERS.push(", "each restored worker must be recorded for summary.fork.sourceWorkers"],
		// A fork restores the world as of request `call` and nothing later, so both the
		// manifest and the reports are folded over records at or before FORK_REQ.ts.
		["manifestJoin(sourceManifest.filter((r) => r.ts <= FORK_REQ.ts))", "only workers that existed at the fork instant may be restored"],
		["fs.rmSync(p, { force: true })", "transcripts of workers spawned after the fork instant must be deleted, not left for FIFO binding"],
		['ev: "worker:report"', "recorded reports must be replayed through the live lifecycle path so unreportedWorkers sees them"],
		// The done gate reads the ORDER of a worker's starts against its reports:
		// unreportedWorkers wants a report with seq > lastStartedSeq, and only started/resuming
		// set lastStartedSeq. Replaying the reports alone left every restored worker at
		// lastStartedSeq 0, so a worker resumed after its last report — unreported in the source
		// run, its done refused there — counted as reported in the fork. Both streams, one ts
		// order (the helper also applies the instant cut), one tracker.seq per item.
		["forkReplayOrder(sourceManifest, sourceReports, FORK_REQ.ts)", "starts and reports must be replayed as one stream in the record's own order, cut at the instant"],
		["state[item.wid].lastStartedSeq = seq", "a restored worker's lastStartedSeq must be re-seeded from the record's own starts"],
		["if (state[item.wid])", "a replayed start must not ensureWorker a phantom — liveWorkers() would then block the quiescence oracle for the whole run"],
		["liveAtFork", "each restored worker must record whether it was still running at the fork instant"],
		// manifestJoin's `resuming` case sets status "running" without clearing the endedTs an
		// earlier terminal record left, so endedTs alone calls a worker mid-resume finished.
		['const liveAtFork = row.endedTs == null || row.status === "running"', "a worker mid-resume at the fork instant must count as live, not finished"],
		// The source run kept appending to an inherited transcript after the fork instant, and
		// pi-subagents resumes a worker by appending to that same file — so an untruncated one
		// resumes from the source run's FINAL state rather than its state at the instant.
		["truncateEntriesAt(readSessionFile(p), FORK_REQ.ts)", "each inherited transcript must be cut at the fork instant"],
	]) {
		assert.ok(fork.includes(needle), `${why} (missing from the fork block: ${needle})`);
	}
	assert.match(src, /import \{[^}]*\btruncateEntriesAt\b[^}]*\} from "\.\/lib\/fork\.mjs"/, "truncateEntriesAt must come from ./lib/fork.mjs, where it is unit-tested");
	assert.match(src, /import \{[^}]*\bforkReplayOrder\b[^}]*\} from "\.\/lib\/fork\.mjs"/, "forkReplayOrder must come from ./lib/fork.mjs, where it is unit-tested");
	// Order is load-bearing: the tail offset must be the TRUNCATED size, so the cut has to
	// happen before the tailer is positioned or everything after the instant is skipped
	// rather than dropped.
	assert.ok(
		fork.indexOf("truncateEntriesAt(readSessionFile(p), FORK_REQ.ts)") < fork.indexOf("tail.offset = fs.statSync(p).size"),
		"an inherited transcript must be truncated at the fork instant BEFORE its tail offset is taken",
	);
	// The worker-restoration loop must run BEFORE the merged replay: it is what puts each
	// worker in `state` (so a replayed start has something to re-seed) and what fills
	// tracker.bound (so workerIdForTranscriptName resolves each replayed report's role).
	assert.ok(
		fork.indexOf("ensureWorker(state, row.wid)") < fork.indexOf("forkReplayOrder(sourceManifest, sourceReports, FORK_REQ.ts)"),
		"the source workers must be restored before their starts and reports are replayed",
	);
	const summaryLine = src.split("\n").find((l) => l.includes("summary.fork ="));
	assert.ok(summaryLine, "summary.fork assignment missing");
	assert.ok(summaryLine.includes("sourceWorkers:"), `summary.fork must carry sourceWorkers; found:\n${summaryLine}`);
	// liveAtFork travels into the summary on each sourceWorkers row, not just into the log.
	assert.match(fork, /FORK_SOURCE_WORKERS\.push\(\{[^}]*\bliveAtFork\b[^}]*\}\)/, "each sourceWorkers row must carry liveAtFork");
	// The old skip set is gone: an inherited transcript is now tailed, not ignored.
	assert.ok(!src.includes("FORK_STALE_TRANSCRIPTS"), "the stale-transcript skip must be gone, replaced by the restoration");
});

// Case (f)'s not-delivered audit line must not repeat the verdict's own prefix.
// tools/batch.mjs and tools/fork.mjs both scan audit.jsonl GLOBALLY for
// /Oracle run #\d+: (\d+\/\d+)/, so a second entry carrying that prefix put the final score
// in the batch and fork oracle columns twice — six scores for five oracles, on exactly the
// capped runs case (f) is about. The verdict is already logged as its own entry just above.
test("the attempt-cap audit line does not add a second Oracle run # score", () => {
	const src = supervisorSource();
	const line = src.split("\n").find((l) => l.includes("was not delivered to any agent"));
	assert.ok(line, "the attempt-cap audit line is missing");
	assert.doesNotMatch(line, /Oracle run #/, `the line must not repeat the verdict prefix; found:\n${line}`);
	assert.ok(!line.includes("${verdict}"), "the line must not interpolate the verdict string");
	// The pattern both tools scan with, against what this line renders to.
	const rendered = line.replace(/^.*msg: `/, "").replace(/`.*$/, "").replace("${doneAttempts}", "5").replace("${CAPS.doneAttempts}", "5");
	assert.doesNotMatch(rendered, /Oracle run #\d+: (\d+\/\d+)/);
	// And the verdict itself is still logged exactly once, before it.
	assert.ok(src.includes("log({ type: \"oracle\", msg: verdict });"), "the verdict must still be its own audit entry");
});

// ---------- management interface (spec §4) ----------
// The point of the MANAGE gate is that a run without a `manage` block behaves exactly as it did
// before any of this existed. That is a property of the SOURCE, not of a test run: there is no
// way to assert "byte-identical" from the outside, so every site management touches is pinned
// here as sitting behind the gate.
test("MANAGE is null unless the config turns it on, and carries the four documented defaults", () => {
	const src = supervisorSource();
	const at = src.indexOf("\nconst MANAGE = (() => {");
	assert.ok(at >= 0, "the MANAGE block is missing from supervisor.mjs");
	const body = src.slice(at + 1);
	const block = body.slice(0, body.indexOf("\n})();"));
	assert.ok(block.includes("const raw = CONFIG.manage;"), "MANAGE must come from the config block loadConfig passes through");
	assert.ok(block.includes("raw.enabled !== true) return null"), "anything but enabled:true must leave MANAGE null");
	assert.ok(block.includes("raw.failThreshold ?? 2"), "failThreshold defaults to 2");
	assert.ok(block.includes("raw.budgetFraction ?? 0.75"), "budgetFraction defaults to 0.75");
	assert.ok(block.includes("raw.timeoutMs ?? 120_000"), "the decision timeout defaults to 120 000 ms (spec §4)");
	assert.ok(block.includes("process.env.MANAGE_DECISION_TIMEOUT_MS"), "MANAGE_DECISION_TIMEOUT_MS must override the configured timeout");
	assert.ok(block.includes("taskDir"), "the task directory travels on MANAGE");
});

test("every management site is behind the MANAGE gate", () => {
	const src = supervisorSource();
	// manageTrigger, pumpControl and the budget check refuse outright without it…
	const trig = src.slice(src.indexOf("\nfunction manageTrigger("));
	assert.ok(trig.slice(0, trig.indexOf("\n}\n")).includes("if (!MANAGE) return false;"), "manageTrigger must be a no-op without MANAGE");
	const pump = src.slice(src.indexOf("\nfunction pumpControl("));
	assert.ok(pump.slice(0, pump.indexOf("\n}\n")).includes("if (!MANAGE || finished) return;"), "pumpControl must be a no-op without MANAGE, and after finish()");
	const budget = src.slice(src.indexOf("\nfunction manageBudgetCheck("));
	assert.ok(budget.slice(0, budget.indexOf("\n}\n")).includes("if (!MANAGE || budgetThresholdFired) return;"), "the budget trigger must be gated and fire once");
	// …and every call site is guarded too, so a manage-free run never reaches one.
	assert.ok(src.includes("if (MANAGE) manageBudgetCheck(t);"), "checkCaps must call the budget check only under MANAGE");
	assert.ok(src.includes("if (MANAGE) setInterval(pumpControl, 2000);"), "the control tailer is only polled under MANAGE");
	assert.ok(src.includes('const controlTail = MANAGE ? new JsonlTailer(path.join(RUN, "control.jsonl")) : null;'), "the control file is runs/<id>/control.jsonl, tailed like every other run file");
	assert.ok(src.includes('ARBITER_MANAGE: MANAGE && PATTERN === "orchestrator" && name === "orchestrator" ? "1" : "",'), "the escalate kind must only exist in the orchestrator's tool when management is on");
	assert.ok(src.includes("if (!MANAGE) { deliver(VERIFIER, M.ack()"), "an escalate mail with no manager configured is acknowledged, not dropped");
	// The supervisor requests a packet; it never assembles one, and never executes an instruction.
	const imports = src.split("\n").filter((l) => /^import .* from "/.test(l));
	assert.ok(!imports.some((l) => /manage\/(instructions|packet|ledger|task-state)\.mjs/.test(l)), `the supervisor must import only the pure trigger policy from lib/manage; found:\n${imports.filter((l) => l.includes("manage/")).join("\n")}`);
	assert.ok(imports.some((l) => l.includes('import { decideTrigger } from "./lib/manage/triggers.mjs";')), "the trigger policy is decideTrigger's, imported from the pure module");
});

// The orchestrator is blocked on this verdict anyway, so holding it costs nothing and buys the
// manager a say before the next attempt starts. What is deferred is the whole block: if only
// the deliver() moved, boundaryPending would still be set at the old moment and the working
// context would name a boundary the orchestrator has not been told about yet.
test("the failed verdict and its boundary are deferred together when the trigger pauses", () => {
	const src = supervisorSource();
	const at = src.indexOf("const deliverVerdict = (correction) => {");
	assert.ok(at >= 0, "the failed-verdict delivery must be wrapped in a thunk the pause can hold");
	const thunk = src.slice(at, src.indexOf("};", at));
	assert.ok(thunk.includes("M.oracle.failedVerifier(verdict"), "the held delivery is the failed verdict");
	assert.ok(thunk.includes("boundaryPending = `oracle failed"), "the working-context boundary must move with it");
	assert.ok(thunk.indexOf("correction") < thunk.indexOf("M.oracle.failedVerifier"), "a correction delivered with the decision must land before the verdict");
	const after = src.slice(at, at + 1400);
	assert.ok(after.includes("decideTrigger({ oracleFails: doneAttempts, failThreshold: MANAGE.failThreshold })"), "the pause decision is decideTrigger's, not a second copy of the threshold rule");
	assert.ok(after.includes("if (!paused) deliverVerdict(null);"), "an unpaused run must deliver exactly as it always did");
});

// The escalate thunk IS the whole reply — unlike the verdict, there is nothing delivered after
// it. So it must tell three outcomes apart: a correction, a decision with no correction, and no
// decision at all. Inferring silence from "no correction" told the orchestrator that a manager's
// own answer was a timeout.
test("the escalation acknowledgement distinguishes an answer from a timeout", () => {
	const src = supervisorSource();
	const at = src.indexOf("const ackEscalation = (correction, defaulted) => {");
	assert.ok(at >= 0, "the escalation acknowledgement must take the defaulted flag, not infer it from the correction");
	const thunk = src.slice(at, src.indexOf("};", at));
	assert.ok(thunk.includes("if (correction) deliver(VERIFIER, correction"), "a correction is delivered as the manager wrote it");
	assert.ok(thunk.includes("else if (defaulted) deliver(VERIFIER, M.manage.escalationDefaulted()"), "only a timeout may use the defaulted text");
	assert.ok(thunk.includes("else deliver(VERIFIER, M.manage.escalationAnswered()"), "a decision with no correction must still read as answered");
	// And the flag has to come from the release, not from a guess at the call site.
	assert.ok(src.includes("held.deliver(held.correction, defaulted)"), "releasePause passes the reason through to the held delivery");
	assert.ok(src.includes('releasePause("decision timeout", { defaulted: true })'), "the timeout is the one release that sets it");
});

test("a decision releases the held delivery; a silent manager defaults after the timeout", () => {
	const src = supervisorSource();
	const pump = src.slice(src.indexOf("\nfunction pumpControl("));
	const body = pump.slice(0, pump.indexOf("\n}\n"));
	assert.ok(body.includes("fs.existsSync(controlTail.filePath)"), "control.jsonl does not exist until an executor writes it, and readNew() stats it unguarded");
	for (const t of ["grant", "correct", "decision"]) assert.ok(body.includes(`entry.type === "${t}"`), `pumpControl must handle ${t} entries`);
	assert.ok(body.includes("CAPS.wallSec += Number(entry.wallSec)"), "a grant raises the wall cap for the rest of the run");
	assert.ok(body.includes("CAPS.toolCalls += Number(entry.toolCalls)"), "a grant raises the tool-call cap for the rest of the run");
	assert.ok(body.includes("M.manage.correction(entry.message)"), "a correction is delivered through the pinned message text");
	assert.ok(body.includes("unknown type"), "an unrecognised control entry is logged and ignored, never acted on");
	assert.ok(body.includes("Date.now() >= managePause.deadline"), "the deadline must be checked on the same poll");
	assert.ok(body.includes('jevEvent("manage:defaulted"'), "a timed-out decision must be recorded as manage:defaulted");
	// The deadline is set once, where the pause is stored, and the second-trigger guard belongs
	// to manageTrigger — both sliced to their own function rather than matched file-wide.
	const trig = src.slice(src.indexOf("\nfunction manageTrigger("));
	const trigBody = trig.slice(0, trig.indexOf("\n}\n"));
	assert.ok(trigBody.includes("deadline: Date.now() + MANAGE.timeoutMs"), "the pause carries its own deadline");
	assert.ok(trigBody.includes("if (managePause) {"), "a second trigger while a decision is owed must not pause again");
	// The wait was not idleness: the clock the nudge reads restarts when the pause lifts.
	const rel = src.slice(src.indexOf("\nfunction releasePause("));
	assert.ok(rel.slice(0, rel.indexOf("\n}\n")).includes("lastActivity = Date.now();"), "releasing a pause must refresh lastActivity");
});

// The orchestrator is blocked on a delivery the supervisor is deliberately withholding, and
// nothing refreshes lastActivity while it waits. idleNudgeSec (120 s) and the decision timeout
// (120 000 ms) are the same order, so the nudge fires inside the pause window: it would tell a
// settled orchestrator to send done, runOracle would increment doneAttempts and deliver that
// verdict at once, and the held one would arrive on release — two verdicts for one claim, and
// an attempt burnt on the very question the manager was being asked about.
test("a run holding a manager decision is not idle", () => {
	const src = supervisorSource();
	const at = src.indexOf("\nfunction checkIdle() {");
	assert.ok(at >= 0, "could not locate checkIdle in supervisor.mjs");
	const body = src.slice(at + 1);
	const fn = body.slice(0, body.indexOf("\n}\n"));
	assert.ok(fn.includes("if (managePause) return;"), `checkIdle must treat a held decision as waiting, not idleness; found:\n${fn.slice(0, 400)}`);
	assert.ok(fn.indexOf("if (managePause) return;") < fn.indexOf("a.ready && !a.busy"), "the guard must precede the readiness test that would otherwise call the run idle");
});

// §4's first row, and the one trigger that asks the manager to accept a milestone. It has to be
// recorded before finish(), which tears the run down.
test("a passing oracle emits milestone_candidate before the run finishes, and suppresses the run-ended trigger", () => {
	const src = supervisorSource();
	const at = src.indexOf("if (total > 0 && pass === total) {");
	assert.ok(at >= 0, "the oracle pass path must be a block, so the trigger can precede finish()");
	const block = src.slice(at, src.indexOf('return finish("SUCCESS: oracle passed");', at));
	assert.ok(block.includes("decideTrigger({ oraclePassed: true })"), "the pass path must ask decideTrigger, not name the kind itself");
	assert.ok(block.includes("milestoneCandidateFired = true;"), "and record that this run's ending is already accounted for");
	// finish() never reads acceptance out of its own reason string.
	const fin = src.slice(src.indexOf("\nfunction finish(reason) {"));
	const body = fin.slice(0, fin.indexOf("\n\tconst t = totals();"));
	assert.ok(body.includes("runEnded: { reason, accepted: false }"), "acceptance is an accept instruction's act on task.json, never inferred from a finish reason");
	assert.ok(body.includes("milestoneCandidateFired ? null :"), "a run that already said milestone_candidate must not also say it ended unaccepted");
	assert.ok(!body.includes("/^SUCCESS/.test(reason)"), "the old inference must be gone");
});

// A threshold at or above the attempt cap can never pause, and nothing at runtime says so.
test("an unreachable failThreshold is warned about at startup, like jev's missing key", () => {
	const src = supervisorSource();
	const line = src.split("\n").find((l) => l.includes("the oracle_failed_repeatedly pause can never fire"));
	assert.ok(line, "the failThreshold warning is missing");
	assert.ok(line.includes("console.error"), "it is a startup warning on stderr, not an audit line");
	const guard = src.split("\n").find((l) => l.includes("MANAGE.failThreshold <= 0 || MANAGE.failThreshold >= CAPS.doneAttempts"));
	assert.ok(guard, "both the non-positive and the unreachable case must be covered");
	assert.ok(guard.includes("if (MANAGE &&"), "and the warning must not fire in a run with no manager");
});

test("a trigger writes a lifecycle event and an audit line, and asks for a packet rather than building one", () => {
	const src = supervisorSource();
	// Both sliced to manageTrigger: matched file-wide, either would pass on any manage line
	// anywhere in the supervisor and say nothing about where the trigger is recorded.
	const trig = src.slice(src.indexOf("\nfunction manageTrigger("));
	const trigBody = trig.slice(0, trig.indexOf("\n}\n"));
	assert.ok(trigBody.includes('jevEvent("manage:trigger", { kind, pauses: Boolean(pauses), packetRequest: { runId, detail } });'), "manage:trigger carries kind, pauses and the packet request");
	assert.ok(trigBody.includes('log({ type: "manage", msg: `trigger ${kind}'), "and every trigger is audited under type manage as it is emitted");
	// The run's own ending is a trigger, but never a pause: finish() kills the processes.
	const fin = src.slice(src.indexOf("\nfunction finish(reason) {"));
	const body = fin.slice(0, fin.indexOf("\n\tconst t = totals();"));
	assert.ok(body.includes("decideTrigger({ runEnded: { reason, accepted: false } })"), "finish() must emit the run-ended trigger");
	assert.ok(body.indexOf("decideTrigger") < body.indexOf("finished = true"), "the trigger is recorded before the teardown begins");
	assert.ok(body.includes("t0.pauses, null)"), "nothing can be held at the end of a run — there is no delivery left to withhold");
});
