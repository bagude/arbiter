import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun, walkSessions } from "../lib/context-trace.mjs";

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

test("walkSessions returns a sorted, recursive list of .jsonl paths", () => {
	const files = walkSessions(path.join(FIXTURE, "sessions"));
	assert.equal(files.length, 2);
	const sorted = [...files].sort();
	assert.deepEqual(files, sorted);
});
