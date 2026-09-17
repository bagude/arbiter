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
