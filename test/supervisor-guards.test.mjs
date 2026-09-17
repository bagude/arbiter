import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi's extension runner returns the FIRST blocking tool_call result, so a guard
// that denies `subagent` must precede pre-spawn-compact in supervisor.mjs's GUARDS
// list or its reason never reaches the model. Read the source rather than import
// supervisor.mjs (importing it starts a run).
test("GUARDS lists topology.ts immediately before pre-spawn-compact.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const t = names.indexOf("topology.ts");
	assert.ok(t >= 0, `topology.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[t + 1], "pre-spawn-compact.ts");
});

// pi's extension runner returns the FIRST blocking tool_call result, so the fork's
// forcing must be seen before the topology nudge on the same spawn.
test("GUARDS lists fork-force.ts immediately before topology.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
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
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
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
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	for (const [needle, why] of [
		["process.exit(2)", "a rejected fork spec must exit(2), not throw or start a run"],
		["forkCounters(", "the harness counters must be re-seeded from the recorded decision points"],
		["prompts.orchestrator = fs.readFileSync", "the recorded system prompt must be restored verbatim"],
		["summary.fork =", "summary.json must record what this run was forked from"],
		["FORK_REQ.snapshot", "the workspace snapshot must be preflighted and restored"],
	]) {
		assert.ok(src.includes(needle), `${why} (missing: ${needle})`);
	}
});

// Three of the planned forks resume a source worker, and pi-subagents resumes by session
// id, appending to the transcript the session copy brought in. So the source run's workers
// are restored rather than ignored: state recreated, transcript pre-bound to its own id,
// tail started at end-of-file. Pre-binding is also the FIFO-bind exclusion — bindTranscript
// returns early on a path tracker.bound already holds — so if the pre-bind went missing the
// fork's own first spawn would silently adopt an inherited transcript.
test("supervisor's fork mode restores the source run's workers", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	// Everything below must be in the fork block, not merely somewhere in the file.
	const start = src.indexOf("\nif (FORK) {\n\t// Sessions:");
	assert.ok(start >= 0, "could not locate the fork block in supervisor.mjs");
	const block = src.slice(start + 1);
	const fork = block.slice(0, block.indexOf("\n}\n"));
	for (const [needle, why] of [
		["manifestJoin(readManifest(FORK_SRC))", "the source run's workers.jsonl must be read in the fork block"],
		["ensureWorker(state, row.wid)", "each source worker's agent state must be created the way a live spawn creates it"],
		["tracker.bound.set(", "each source transcript must be pre-bound to its own wid, which is also the FIFO-bind exclusion"],
		["tail.offset = fs.statSync(p).size", "an inherited tail must start at end-of-file so nothing pre-fork is counted"],
		["FORK_SOURCE_WORKERS.push(", "each restored worker must be recorded for summary.fork.sourceWorkers"],
	]) {
		assert.ok(fork.includes(needle), `${why} (missing from the fork block: ${needle})`);
	}
	const summaryLine = src.split("\n").find((l) => l.includes("summary.fork ="));
	assert.ok(summaryLine, "summary.fork assignment missing");
	assert.ok(summaryLine.includes("sourceWorkers:"), `summary.fork must carry sourceWorkers; found:\n${summaryLine}`);
	// The old skip set is gone: an inherited transcript is now tailed, not ignored.
	assert.ok(!src.includes("FORK_STALE_TRANSCRIPTS"), "the stale-transcript skip must be gone, replaced by the restoration");
});
