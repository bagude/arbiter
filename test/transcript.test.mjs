import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary, renderTranscript } from "../lib/transcript.mjs";

const startedAt = 1_000_000;
const state = {
	orchestrator: { name: "orchestrator", role: "orchestrator", toolCalls: 12, cost: 0 },
	"worker:a": { name: "worker:a", role: "worker", toolCalls: 5, cost: 0.0123 },
	"worker:b": { name: "worker:b", role: "worker", toolCalls: 3, cost: 0 },
};
const timeline = [
	{ ts: startedAt + 10_000, from: "orchestrator", to: "worker:a", kind: "spawn", body: "Implement   stage 1\nof the thing" },
	{ ts: startedAt + 20_000, from: "worker:a", to: "orchestrator", kind: "report", body: "Done stage 1" },
	{ ts: startedAt + 25_000, from: "orchestrator", to: "worker:a", kind: "resume", body: "fix the edge case", claimed: true },
	{ ts: startedAt + 30_000, from: "worker:a", to: "orchestrator", kind: "report", body: "Fixed" },
	{ ts: startedAt + 31_000, from: "orchestrator", to: "worker", kind: "spawn", body: "phantom — call produced no worker", toolCallId: "c9" },
	{ ts: startedAt + 40_000, from: "orchestrator", to: "supervisor", kind: "probe", body: "[]", n: 1 },
	{ ts: startedAt + 50_000, from: "orchestrator", to: "worker:b", kind: "spawn", body: "Implement stage 2" },
	{ ts: startedAt + 60_000, from: "supervisor", to: "orchestrator", kind: "nudge", body: "[SUPERVISOR] idle" },
	{ ts: startedAt + 70_000, from: "orchestrator", to: "supervisor", kind: "done", body: "all done", n: 2 },
];
const base = {
	runId: "2026-09-11T00-00-00",
	reason: "SUCCESS: oracle passed",
	pattern: "orchestrator",
	roles: { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b", max: 1 } },
	config: { task: "orbit" },
	totals: { wallSec: 1086.04, cost: 0.01234, toolCalls: 20 },
	state,
	timeline,
	mailCount: 2,
	doneAttempts: 1,
	nudges: 1,
	probeCountAtFirstOracle: 12,
	guards: { path: { denied: { orchestrator: 1 } } },
	caps: { wallSec: 6000 },
	task: "orbit",
	verifier: "orchestrator",
};

test("summary: per-agent maps, mail kinds (supervisor excluded), workers, guards", () => {
	const s = buildSummary(base);
	assert.equal(s.runId, "2026-09-11T00-00-00");
	assert.equal(s.model, "qwen3-27b + qwen3-27b");
	assert.equal(s.builderModel, "llama.cpp/qwen3-27b");
	assert.equal(s.criticModel, "llama.cpp/qwen3-27b");
	assert.equal(s.wallSec, 1086);
	assert.equal(s.costUsd, 0.0123);
	assert.deepEqual(s.toolCalls, { orchestrator: 12, "worker:a": 5, "worker:b": 3 });
	assert.deepEqual(s.costByAgent, { orchestrator: 0, "worker:a": 0.0123, "worker:b": 0 });
	assert.deepEqual(s.mailByKind, { spawn: 3, report: 2, resume: 1, probe: 1, done: 1 });
	assert.equal(s.workers, 2);
	assert.equal(s.orchestratorProbedBeforeDone, true);
	assert.deepEqual(s.guards, { path: { denied: { orchestrator: 1 } } });
	assert.equal(s.oracleGate, "orchestrator approval (hash+quiescence)");
	assert.equal(s.task, "orbit");
});

test("summary: orchestratorProbedBeforeDone is null when no oracle ran, false when unprobed, absent outside the pattern", () => {
	assert.equal(buildSummary({ ...base, probeCountAtFirstOracle: null }).orchestratorProbedBeforeDone, null);
	assert.equal(buildSummary({ ...base, probeCountAtFirstOracle: 0 }).orchestratorProbedBeforeDone, false);
	assert.ok(!("orchestratorProbedBeforeDone" in buildSummary({ ...base, pattern: "dyad", roles: { builder: base.roles.orchestrator, critic: base.roles.orchestrator }, verifier: "critic" })));
});

test("summary: solo has no critic model and the solo oracle gate", () => {
	const s = buildSummary({ ...base, pattern: "solo", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" } }, verifier: null });
	assert.equal(s.criticModel, "none (solo ablation)");
	assert.equal(s.oracleGate, "solo: builder done or quiescence");
});

test("transcript: delegation tree groups each worker's resumes and reports, skips the phantom spawn", () => {
	const md = renderTranscript({ runId: base.runId, reason: base.reason, startedAt, timeline, pattern: "orchestrator" });
	assert.match(md, /^# arbiter transcript — 2026-09-11T00-00-00\n\n\*\*Outcome:\*\* SUCCESS: oracle passed\n/);
	assert.match(md, /## Delegation\n\n- \*\*worker:a\*\* spawned at 10s — brief: Implement stage 1 of the thing\n  - report at 20s: Done stage 1\n  - resume at 25s: fix the edge case\n  - report at 30s: Fixed\n- \*\*worker:b\*\* spawned at 50s — brief: Implement stage 2\n/);
	assert.doesNotMatch(md, /\*\*worker\*\*/);
	assert.match(md, /### \[40s\] #1 orchestrator → supervisor \(probe\)\n\n\[\]\n/);
	assert.match(md, /### \[60s\] supervisor → orchestrator \(nudge\)/);
});

test("transcript: no delegation section outside the orchestrator pattern", () => {
	const md = renderTranscript({ runId: "r", reason: "x", startedAt, timeline, pattern: "dyad" });
	assert.doesNotMatch(md, /## Delegation/);
	assert.match(md, /### \[10s\] orchestrator → worker:a \(spawn\)/);
});
