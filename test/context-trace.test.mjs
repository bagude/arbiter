import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun, walkSessions, markersFor, meanRetained } from "../lib/context-trace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "run-trace");

function agentsById(trace) {
	const byId = {};
	for (const a of trace.agents) byId[a.id] = a;
	return byId;
}

// Writes a minimal session jsonl: a "session" entry, then one assistant message
// (with usage) per {startMs, endIso} pair in `calls`.
function writeSessionFile(file, sessionId, calls, extra = {}) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines = [{ type: "session", version: 3, id: sessionId, timestamp: new Date(calls[0].startMs - 1000).toISOString(), ...extra }];
	for (const { startMs, endIso } of calls) {
		lines.push({
			type: "message",
			id: `m-${startMs}`,
			timestamp: endIso,
			message: { role: "assistant", content: [], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 }, timestamp: startMs, stopReason: "endTurn" },
		});
	}
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("traceRun finds the orchestrator and the worker with correct spawn info", () => {
	const trace = traceRun(FIXTURE);
	assert.equal(trace.agents.length, 2);
	const byId = agentsById(trace);
	assert.ok(byId.orchestrator, "expected an orchestrator agent");
	const worker = trace.agents.find((a) => a.id.startsWith("worker:"));
	assert.ok(worker, "expected a worker agent");
	assert.equal(worker.parent, "orchestrator");
	assert.ok(worker.spawn, "expected worker.spawn to be set");
	assert.equal(worker.spawn.description, "Implement src/gear.mjs");
	assert.equal(worker.spawn.background, true);
	assert.equal(worker.spawn.type, "worker");
});

test("every call satisfies context = cached + fresh, hitRatio, and retained invariants", () => {
	const trace = traceRun(FIXTURE);
	for (const agent of trace.agents) {
		let prev = null;
		for (const call of agent.calls) {
			assert.equal(call.context, call.cached + call.fresh, `${agent.id} call ${call.i} context`);
			const expectedHitRatio = call.context === 0 ? 0 : call.cached / call.context;
			assert.ok(Math.abs(call.hitRatio - expectedHitRatio) < 1e-9, `${agent.id} call ${call.i} hitRatio`);
			if (call.i >= 2) {
				assert.ok(prev, `${agent.id} call ${call.i} should have a previous call`);
				const expectedRetained = prev.totalTokens === 0 ? null : call.cached / prev.totalTokens;
				if (expectedRetained === null) assert.equal(call.retained, null);
				else assert.ok(Math.abs(call.retained - expectedRetained) < 1e-9, `${agent.id} call ${call.i} retained`);
			}
			prev = call;
		}
	}
});

test("orchestrator's first three calls match the verified fixture numbers", () => {
	const trace = traceRun(FIXTURE);
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");
	const [c1, c2, c3] = orchestrator.calls;
	assert.equal(c1.fresh, 6007);
	assert.equal(c1.cached, 0);
	assert.equal(c2.fresh, 394);
	assert.equal(c2.cached, 6079);
	assert.equal(c2.retained, 1);
	assert.equal(c3.cached, 6538);
	assert.equal(c3.retained, 1);
});

test("meanRetained is the unweighted mean of every non-null call.retained across all agents", () => {
	const trace = traceRun(FIXTURE);
	const values = trace.agents.flatMap((a) => a.calls).map((c) => c.retained).filter((v) => v !== null);
	assert.ok(values.length > 0, "fixture should have at least one call with a non-null retained");
	const expected = values.reduce((sum, v) => sum + v, 0) / values.length;
	assert.ok(Math.abs(meanRetained(trace) - expected) < 1e-9);
});

test("meanRetained returns null when no call has a non-null retained", () => {
	const trace = { agents: [{ calls: [{ retained: null }, { retained: null }] }, { calls: [{ retained: null }] }] };
	assert.equal(meanRetained(trace), null);
});

test("meanRetained returns null for a trace with no calls at all", () => {
	assert.equal(meanRetained({ agents: [] }), null);
});

test("orchestrator has exactly one compaction marker attached to the first call after it", () => {
	const trace = traceRun(FIXTURE);
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");
	const compactionMarkers = orchestrator.calls.flatMap((c) => c.markers.map((m) => ({ ...m, callIndex: c.i, callStartMs: c.startMs }))).filter((m) => m.kind === "compaction");
	assert.equal(compactionMarkers.length, 1);
	const marker = compactionMarkers[0];
	assert.match(marker.detail, /tokensBefore=117428/);
	// it must be attached to the first call whose startMs is after the compaction's tMs
	const firstAfter = orchestrator.calls.find((c) => c.startMs > marker.tMs);
	assert.equal(marker.callIndex, firstAfter.i);
});

test("spawn/return markers exist on the orchestrator lane for the worker, and worker.spawn.createdMs matches lifecycle", () => {
	const trace = traceRun(FIXTURE);
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");
	const worker = trace.agents.find((a) => a.id.startsWith("worker:"));
	const allOrchMarkers = orchestrator.calls.flatMap((c) => c.markers);
	const spawnMarker = allOrchMarkers.find((m) => m.kind === "spawn" && m.agent === worker.id);
	const returnMarker = allOrchMarkers.find((m) => m.kind === "return" && m.agent === worker.id);
	assert.ok(spawnMarker, "expected a spawn marker for the worker on the orchestrator lane");
	assert.ok(returnMarker, "expected a return marker for the worker on the orchestrator lane");

	const lifecycle = JSON.parse(
		"[" +
			fs
				.readFileSync(path.join(FIXTURE, "lifecycle.jsonl"), "utf8")
				.trim()
				.split("\n")
				.join(",") +
			"]",
	);
	const created = lifecycle.find((e) => e.ev === "subagents:created");
	assert.equal(worker.spawn.createdMs, created.ts);
});

test("worker:report marker resolves to the worker agent, not the orchestrator (data.role names the transcript basename)", () => {
	const trace = traceRun(FIXTURE);
	const worker = trace.agents.find((a) => a.id.startsWith("worker:"));
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");

	const reportMarkers = trace.markers.filter((m) => m.kind === "report");
	assert.equal(reportMarkers.length, 1);
	assert.equal(reportMarkers[0].agent, worker.id);

	const onWorkerCalls = worker.calls.flatMap((c) => c.markers).filter((m) => m.kind === "report");
	assert.equal(onWorkerCalls.length, 1, "report marker should attach to a call on the worker's own lane");

	const onOrchestratorCalls = orchestrator.calls.flatMap((c) => c.markers).filter((m) => m.kind === "report");
	assert.equal(onOrchestratorCalls.length, 0, "report marker must not silently attach to the orchestrator");
});

test("wall time: orchestrator call 1 inferenceMs is 4587ms and toolMs is the gap to call 2", () => {
	const trace = traceRun(FIXTURE);
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");
	const [c1, c2] = orchestrator.calls;
	assert.equal(c1.inferenceMs, 4587);
	assert.equal(c1.toolMs, c2.startMs - c1.endMs);
});

test("totals.hitRatio for the orchestrator matches cached/(cached+fresh) computed from its calls", () => {
	const trace = traceRun(FIXTURE);
	const orchestrator = trace.agents.find((a) => a.id === "orchestrator");
	let cached = 0;
	let fresh = 0;
	for (const c of orchestrator.calls) {
		cached += c.cached;
		fresh += c.fresh;
	}
	const expected = cached + fresh === 0 ? 0 : cached / (cached + fresh);
	assert.ok(Math.abs(orchestrator.totals.hitRatio - expected) < 1e-9);
});

test("a run with no lifecycle.jsonl traces without throwing: markers empty, spawn null", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-"));
	const sessionsDir = path.join(tmp, "sessions", "orchestrator");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const entry1 = { type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z" };
	const entry2 = {
		type: "message",
		id: "m1",
		timestamp: "2026-01-01T00:00:05.000Z",
		message: { role: "assistant", content: [], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110 }, timestamp: 1767225600000, stopReason: "endTurn" },
	};
	fs.writeFileSync(path.join(sessionsDir, "x.jsonl"), [entry1, entry2].map((e) => JSON.stringify(e)).join("\n") + "\n");

	const trace = traceRun(tmp);
	assert.equal(trace.markers.length, 0);
	assert.equal(trace.agents.length, 1);
	assert.equal(trace.agents[0].spawn, null);
	assert.equal(trace.agents[0].calls[0].markers.length, 0);
});

test("a worker joined via subagents:started only (no created) picks up type from the started event", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-spawn-type-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const workerFile = path.join(tmp, "sessions", "orchestrator", "tasks", "w1.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [
		{ startMs: 500, endIso: new Date(600).toISOString() },
		{ startMs: 700, endIso: new Date(9600).toISOString() },
	]);
	writeSessionFile(workerFile, "worker-session-1", [{ startMs: 1500, endIso: new Date(2000).toISOString() }], { parentSession: "orch-session-1" });
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:started", data: { id: "sub-x", type: "tester", description: "FG task" } },
			{ ts: 9000, ev: "subagents:completed", data: { id: "sub-x", type: "tester", description: "FG task" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const trace = traceRun(tmp);
	const worker = trace.agents.find((a) => a.role === "worker");
	assert.equal(worker.spawn.type, "tester");
});

test("a fresh worker claims its own started event, not an earlier worker's resume that is also in its window", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-resume-join-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [
		{ startMs: 500, endIso: new Date(600).toISOString() },
		{ startMs: 700, endIso: new Date(99000).toISOString() },
	]);
	writeSessionFile(path.join(tmp, "sessions", "orchestrator", "tasks", "impl.jsonl"), "impl-session-1", [{ startMs: 1500, endIso: new Date(2000).toISOString() }], { parentSession: "orch-session-1" });
	writeSessionFile(path.join(tmp, "sessions", "orchestrator", "tasks", "test.jsonl"), "test-session-1", [{ startMs: 61000, endIso: new Date(62000).toISOString() }], { parentSession: "orch-session-1" });
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:started", data: { id: "sub-impl", type: "implementer", description: "Implement it" } },
			{ ts: 3000, ev: "subagents:completed", data: { id: "sub-impl", type: "implementer", description: "Implement it" } },
			// the implementer is resumed 20 s before the tester is spawned: both events
			// sit inside the tester's 120 s join window, and the resume is the earlier one
			{ ts: 40000, ev: "subagents:resuming", data: { id: "sub-impl", type: "implementer", description: "Implement it" } },
			{ ts: 60000, ev: "subagents:started", data: { id: "sub-test", type: "tester", description: "Test it" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const trace = traceRun(tmp);
	const byId = new Map(trace.agents.map((a) => [a.sessionId, a]));
	assert.equal(byId.get("impl-session-1").spawn.type, "implementer");
	assert.equal(byId.get("test-session-1").spawn.type, "tester");
	assert.equal(byId.get("test-session-1").spawn.description, "Test it");
});

test("traceRun throws when the run dir has no sessions/ directory", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-nosessions-"));
	assert.throws(() => traceRun(tmp));
});

test("a guard marker whose data.role names a worker by transcript basename attaches to that worker, not the orchestrator", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-guard-role-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const workerFile = path.join(tmp, "sessions", "orchestrator", "tasks", "2026-01-01T00-05-00-000Z_workerXYZ.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [{ startMs: 1_700_000_000_000, endIso: new Date(1_700_000_004_000).toISOString() }]);
	writeSessionFile(workerFile, "worker-session-1", [{ startMs: 1_700_000_010_000, endIso: new Date(1_700_000_020_000).toISOString() }], { parentSession: "orch-session-1" });

	// The guard's role is the worker session FILE's basename (without .jsonl) per
	// lib/workers.mjs's workerIdForTranscriptName — not the bare session id.
	const guardTs = 1_700_000_015_000; // inside the worker's own call window
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		JSON.stringify({ ts: guardTs, ev: "guard:context_diet_rewritten", data: { role: "worker:2026-01-01T00-05-00-000Z_workerXYZ", thinkingDropped: 1, resultsAged: 3 } }) + "\n",
	);

	const trace = traceRun(tmp);
	const worker = trace.agents.find((a) => a.role === "worker");
	const orchestrator = trace.agents.find((a) => a.role === "orchestrator");
	assert.ok(worker);

	const guardMarkers = trace.markers.filter((m) => m.kind === "guard");
	assert.equal(guardMarkers.length, 1);
	assert.equal(guardMarkers[0].agent, worker.id);
	assert.equal(guardMarkers[0].detail, "context_diet thinkingDropped=1 resultsAged=3");

	const onWorkerCalls = worker.calls.flatMap((c) => c.markers).filter((m) => m.kind === "guard");
	assert.equal(onWorkerCalls.length, 1, "guard marker should attach to the worker's own call");
	const onOrchestratorCalls = orchestrator.calls.flatMap((c) => c.markers).filter((m) => m.kind === "guard");
	assert.equal(onOrchestratorCalls.length, 0, "guard marker must not silently attach to the orchestrator");
});

test("a guard:topology_waived marker's detail is 'topology ...', not 'topology_waived ...'", () => {
	// guardDetail() strips the kind suffix from the event name; it must know about
	// _waived and _skipped the same as it already knows about _rewritten and _denied
	// (see lib/workers.mjs's sibling regex, widened for the same two kinds).
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-topology-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [{ startMs: 1_700_000_000_000, endIso: new Date(1_700_000_004_000).toISOString() }]);

	const guardTs = 1_700_000_002_000; // inside the orchestrator's own call window
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		JSON.stringify({ ts: guardTs, ev: "guard:topology_waived", data: { role: "orchestrator", specialist: "implementer", failed: "tests:missing" } }) + "\n",
	);

	const trace = traceRun(tmp);
	const guardMarkers = trace.markers.filter((m) => m.kind === "guard");
	assert.equal(guardMarkers.length, 1);
	assert.match(guardMarkers[0].detail, /^topology specialist=implementer/);
	assert.ok(!guardMarkers[0].detail.includes("topology_waived"), `detail should not contain the raw event kind: ${guardMarkers[0].detail}`);
});

test("a foreground spawn (subagents:started only, no subagents:created) still joins the worker", () => {
	// Foreground spawns never emit subagents:created, only subagents:started, so the
	// join must accept a lone `started` event as a valid spawn candidate.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-fg-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const workerFile = path.join(tmp, "sessions", "orchestrator", "tasks", "w1.jsonl");
	// Two orchestrator calls whose windows together straddle both lifecycle events
	// (marker windows are (prevCall.endMs, call.endMs]), so the spawn (tMs 1000) and
	// return (tMs 9000) markers both have an orchestrator call to attach to.
	writeSessionFile(orchFile, "orch-session-1", [
		{ startMs: 500, endIso: new Date(600).toISOString() },
		{ startMs: 700, endIso: new Date(9600).toISOString() },
	]);
	writeSessionFile(workerFile, "worker-session-1", [{ startMs: 1500, endIso: new Date(2000).toISOString() }], { parentSession: "orch-session-1" });
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:started", data: { id: "sub-x", type: "worker", description: "FG task" } },
			{ ts: 9000, ev: "subagents:completed", data: { id: "sub-x", type: "worker", description: "FG task" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const trace = traceRun(tmp);
	const orchestrator = trace.agents.find((a) => a.role === "orchestrator");
	const worker = trace.agents.find((a) => a.role === "worker");
	assert.ok(worker.spawn, "expected worker.spawn to be set from subagents:started alone");
	assert.equal(worker.spawn.description, "FG task");
	assert.equal(worker.spawn.background, null);
	assert.equal(worker.spawn.createdMs, 1000);
	assert.equal(worker.spawn.startedMs, 1000);
	assert.equal(worker.spawn.completedMs, 9000);

	const allOrchMarkers = orchestrator.calls.flatMap((c) => c.markers);
	const spawnMarkers = allOrchMarkers.filter((m) => m.kind === "spawn" && m.agent === worker.id);
	const returnMarkers = allOrchMarkers.filter((m) => m.kind === "return" && m.agent === worker.id);
	assert.equal(spawnMarkers.length, 1, "expected exactly one spawn marker for the worker on the orchestrator lane");
	assert.equal(returnMarkers.length, 1, "expected exactly one return marker for the worker on the orchestrator lane");

	const unioned = markersFor(trace, worker.id);
	assert.ok(
		unioned.some((m) => m.kind === "return"),
		"markersFor should surface the worker's return marker",
	);
});

test("a background spawn's subagents:created and subagents:started for the same id join as one spawn, not two", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-bg-join-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const workerFile = path.join(tmp, "sessions", "orchestrator", "tasks", "w1.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [
		{ startMs: 500, endIso: new Date(600).toISOString() },
		{ startMs: 700, endIso: new Date(2000).toISOString() },
	]);
	writeSessionFile(workerFile, "worker-session-1", [{ startMs: 1500, endIso: new Date(2000).toISOString() }], { parentSession: "orch-session-1" });
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:created", data: { id: "sub-y", type: "worker", description: "BG task", isBackground: true } },
			{ ts: 1001, ev: "subagents:started", data: { id: "sub-y", type: "worker", description: "BG task" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const trace = traceRun(tmp);
	const orchestrator = trace.agents.find((a) => a.role === "orchestrator");
	const worker = trace.agents.find((a) => a.role === "worker");
	assert.equal(worker.spawn.background, true);
	assert.equal(worker.spawn.createdMs, 1000);
	assert.equal(worker.spawn.startedMs, 1001);

	const spawnMarkers = orchestrator.calls
		.flatMap((c) => c.markers)
		.filter((m) => m.kind === "spawn" && m.agent === worker.id);
	assert.equal(spawnMarkers.length, 1, "created+started for the same id must produce exactly one spawn marker");
});

test("two worker sessions whose last 8 id chars collide get -2/-3 suffixes instead of merging", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-collide-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const worker1File = path.join(tmp, "sessions", "orchestrator", "tasks", "w1.jsonl");
	const worker2File = path.join(tmp, "sessions", "orchestrator", "tasks", "w2.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [{ startMs: 1_700_000_000_000, endIso: new Date(1_700_000_004_000).toISOString() }]);
	// Different full session ids, identical last 8 characters ("11111111").
	writeSessionFile(worker1File, "aaaaaaaa-11111111", [{ startMs: 1_700_000_010_000, endIso: new Date(1_700_000_011_000).toISOString() }]);
	writeSessionFile(worker2File, "bbbbbbbb-11111111", [{ startMs: 1_700_000_020_000, endIso: new Date(1_700_000_021_000).toISOString() }]);

	const trace = traceRun(tmp);
	const workers = trace.agents.filter((a) => a.role === "worker").sort((a, b) => a.startMs - b.startMs);
	assert.equal(workers.length, 2);
	assert.equal(workers[0].id, "worker:11111111");
	assert.equal(workers[1].id, "worker:11111111-2");
});

test("worker spawn join is FIFO: the earliest unclaimed creation event goes to the earliest worker, not the latest", () => {
	// Regression for the bug where two workers spawned close together got their
	// spawn.description swapped: the join used to pick the LATEST unclaimed
	// candidate at or before a worker's first call, so the earlier worker (by
	// startMs) grabbed the later worker's creation event.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-fifo-"));
	const orchFile = path.join(tmp, "sessions", "orchestrator", "orch.jsonl");
	const worker1File = path.join(tmp, "sessions", "orchestrator", "tasks", "w1.jsonl");
	const worker2File = path.join(tmp, "sessions", "orchestrator", "tasks", "w2.jsonl");
	writeSessionFile(orchFile, "orch-session-1", [{ startMs: 500, endIso: new Date(600).toISOString() }]);
	writeSessionFile(worker1File, "worker-session-1", [{ startMs: 3000, endIso: new Date(3100).toISOString() }], { parentSession: "orch-session-1" });
	writeSessionFile(worker2File, "worker-session-2", [{ startMs: 4000, endIso: new Date(4100).toISOString() }], { parentSession: "orch-session-1" });
	fs.writeFileSync(
		path.join(tmp, "lifecycle.jsonl"),
		[
			{ ts: 1000, ev: "subagents:created", data: { id: "sub-a", type: "worker", description: "TASK-A", isBackground: true } },
			{ ts: 2000, ev: "subagents:created", data: { id: "sub-b", type: "worker", description: "TASK-B", isBackground: true } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n",
	);

	const trace = traceRun(tmp);
	const workers = trace.agents.filter((a) => a.role === "worker").sort((a, b) => a.startMs - b.startMs);
	assert.equal(workers.length, 2);
	assert.equal(workers[0].spawn.description, "TASK-A");
	assert.equal(workers[1].spawn.description, "TASK-B");
});

test("markersFor unions a worker's own call markers with run-level markers attached to none of its calls (its return)", () => {
	const trace = traceRun(FIXTURE);
	const worker = trace.agents.find((a) => a.id.startsWith("worker:"));
	const onWorkerCalls = worker.calls.flatMap((c) => c.markers);
	assert.ok(!onWorkerCalls.some((m) => m.kind === "return"), "the return marker should not be attached to any of the worker's own calls");
	const unioned = markersFor(trace, worker.id);
	assert.ok(
		unioned.some((m) => m.kind === "return"),
		"markersFor should still surface the worker's return marker",
	);
});

test("every fixture call has timings === null and totals.promptMs === 0 (no serverTimings in the fixture)", () => {
	const trace = traceRun(FIXTURE);
	for (const agent of trace.agents) {
		for (const call of agent.calls) assert.equal(call.timings, null, `${agent.id} call ${call.i} timings`);
		assert.equal(agent.totals.promptMs, 0, `${agent.id} totals.promptMs`);
		assert.equal(agent.totals.predictedMs, 0, `${agent.id} totals.predictedMs`);
	}
	assert.equal(trace.totals.promptMs, 0);
	assert.equal(trace.totals.predictedMs, 0);
});

test("a call with usage.serverTimings gets an exact timings object and draftAcceptance, and totals.promptMs sums it", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-timings-"));
	const sessionsDir = path.join(tmp, "sessions", "orchestrator");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const entry1 = { type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z" };
	const entry2 = {
		type: "message",
		id: "m1",
		timestamp: "2026-01-01T00:00:05.000Z",
		message: {
			role: "assistant",
			content: [],
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 110,
				serverTimings: { promptN: 5000, promptMs: 4200, cacheN: 6000, predictedN: 300, predictedMs: 2800, draftN: 400, draftAccepted: 360 },
			},
			timestamp: 1767225600000,
			stopReason: "endTurn",
		},
	};
	fs.writeFileSync(path.join(sessionsDir, "x.jsonl"), [entry1, entry2].map((e) => JSON.stringify(e)).join("\n") + "\n");

	const trace = traceRun(tmp);
	const agent = trace.agents[0];
	const call = agent.calls[0];
	assert.deepEqual(call.timings, {
		promptN: 5000,
		promptMs: 4200,
		cacheN: 6000,
		predictedN: 300,
		predictedMs: 2800,
		draftN: 400,
		draftAccepted: 360,
		draftAcceptance: 0.9,
	});
	assert.equal(agent.totals.promptMs, 4200);
	assert.equal(agent.totals.predictedMs, 2800);
});

test("timings with missing fields fill nulls, and draftAcceptance is null when draftN is 0 or missing", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-context-trace-timings-partial-"));
	const sessionsDir = path.join(tmp, "sessions", "orchestrator");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const entry1 = { type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z" };
	const entry2 = {
		type: "message",
		id: "m1",
		timestamp: "2026-01-01T00:00:05.000Z",
		message: {
			role: "assistant",
			content: [],
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110, serverTimings: { promptMs: 1000, draftN: 0 } },
			timestamp: 1767225600000,
			stopReason: "endTurn",
		},
	};
	fs.writeFileSync(path.join(sessionsDir, "x.jsonl"), [entry1, entry2].map((e) => JSON.stringify(e)).join("\n") + "\n");

	const trace = traceRun(tmp);
	const call = trace.agents[0].calls[0];
	assert.equal(call.timings.promptN, null);
	assert.equal(call.timings.promptMs, 1000);
	assert.equal(call.timings.cacheN, null);
	assert.equal(call.timings.predictedN, null);
	assert.equal(call.timings.predictedMs, null);
	assert.equal(call.timings.draftN, 0);
	assert.equal(call.timings.draftAccepted, null);
	assert.equal(call.timings.draftAcceptance, null);
});

test("walkSessions returns a sorted, recursive list of .jsonl paths", () => {
	const files = walkSessions(path.join(FIXTURE, "sessions"));
	assert.equal(files.length, 2);
	const sorted = [...files].sort();
	assert.deepEqual(files, sorted);
});
