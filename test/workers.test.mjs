import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTracker, applyLifecycleEvent, bindTranscript, dropUnclaimedSubagentEntry } from "../lib/workers.mjs";

// The two real lifecycle files: a foreground run (3 sequential workers, started →
// completed each) and a background run (created → started 1 ms apart, then a second
// foreground spawn). Replaying them is the test the fix wave did by hand.
const fixture = (name) =>
	fs
		.readFileSync(path.join("test", "fixtures", `lifecycle-${name}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

function replay(events, { state = {}, timeline = [], tracker = createTracker() } = {}) {
	const audit = [];
	const decisions = [];
	let now = 1000;
	for (const { ev, data } of events) {
		now += 1;
		const out = applyLifecycleEvent(tracker, state, timeline, { ev, data, now });
		audit.push(...out.audit);
		if (out.decision) decisions.push(out.decision);
	}
	return { state, timeline, tracker, audit, decisions };
}

test("foreground replay: three workers, each announced once and completed", () => {
	const { state, timeline, audit, decisions } = replay(fixture("foreground"));
	const workers = Object.values(state).filter((s) => s.role === "worker");
	assert.equal(workers.length, 3);
	assert.deepEqual(workers.map((w) => w.status), ["completed", "completed", "completed"]);
	const spawns = audit.filter((a) => a.type === "spawn");
	assert.equal(spawns.length, 3);
	assert.deepEqual(spawns.map((a) => a.isBackground), [false, false, false]);
	assert.equal(timeline.filter((m) => m.kind === "spawn").length, 3);
	assert.equal(timeline.filter((m) => m.kind === "report").length, 3);
	assert.equal(decisions.length, 3);
	assert.ok(timeline.every((m) => m.to !== "worker"), "no unclaimed placeholder nodes");
});

test("background replay: created→started announces once, with isBackground true", () => {
	const { state, audit, timeline } = replay(fixture("background"));
	const spawns = audit.filter((a) => a.type === "spawn");
	assert.equal(spawns.length, 2);
	assert.deepEqual(spawns.map((a) => a.isBackground), [true, false]);
	assert.equal(Object.values(state).filter((s) => s.role === "worker").length, 2);
	assert.equal(timeline.filter((m) => m.kind === "spawn").length, 2);
});

test("a started claims the orchestrator's pending spawn entry instead of pushing a second node", () => {
	const timeline = [{ ts: 1, from: "orchestrator", to: "worker", kind: "spawn", body: "the full brief", toolCallId: "c1" }];
	const { timeline: t } = replay([{ ev: "subagents:started", data: { id: "abc", type: "worker", description: "x" } }], { timeline });
	assert.equal(t.length, 1);
	assert.equal(t[0].to, "worker:abc");
	assert.equal(t[0].body, "the full brief");
});

test("every worker event is ignored without an id", () => {
	const { state, audit, timeline } = replay([{ ev: "subagents:started", data: {} }, { ev: "subagents:update", data: { message: "hi" } }]);
	assert.deepEqual(state, {});
	assert.deepEqual(audit, []);
	assert.deepEqual(timeline, []);
});

test("resumed is terminal: completed status, a report, and a decision", () => {
	const events = [
		{ ev: "subagents:started", data: { id: "w1", type: "worker", description: "d" } },
		{ ev: "subagents:completed", data: { id: "w1", status: "completed", result: "first" } },
		{ ev: "subagents:resuming", data: { id: "w1", type: "worker", description: "again" } },
		{ ev: "subagents:resumed", data: { id: "w1", status: "completed", result: "second" } },
	];
	const { state, timeline, decisions, audit } = replay(events);
	assert.equal(state["worker:w1"].status, "completed");
	assert.deepEqual(decisions, ["worker:w1", "worker:w1"]);
	assert.deepEqual(timeline.filter((m) => m.kind === "report").map((m) => m.body), ["first", "second"]);
	assert.equal(audit.filter((a) => a.type === "resume").length, 1);
});

test("a resumed run with an error status is a failure with a FAILED report node", () => {
	const events = [
		{ ev: "subagents:started", data: { id: "w1", type: "worker", description: "d" } },
		{ ev: "subagents:resuming", data: { id: "w1" } },
		{ ev: "subagents:resumed", data: { id: "w1", status: "error", error: "boom" } },
	];
	const { state, timeline, audit } = replay(events);
	assert.equal(state["worker:w1"].status, "failed");
	assert.equal(audit.filter((a) => a.type === "worker_failed").length, 1);
	assert.match(timeline.at(-1).body, /^FAILED: boom/);
});

test("resuming claims the orchestrator's pending resume entry", () => {
	const timeline = [
		{ ts: 1, from: "orchestrator", to: "worker:w1", kind: "spawn", body: "b" },
		{ ts: 2, from: "orchestrator", to: "worker:w1", kind: "resume", body: "continue", claimed: false, toolCallId: "c2" },
	];
	const { timeline: t } = replay(
		[{ ev: "subagents:started", data: { id: "w1" } }, { ev: "subagents:resuming", data: { id: "w1", description: "d" } }],
		{ timeline },
	);
	assert.equal(t.filter((m) => m.kind === "resume").length, 1);
	assert.equal(t[1].claimed, true);
});

test("steered is a message, not a state change", () => {
	const { state, timeline } = replay([
		{ ev: "subagents:started", data: { id: "w1" } },
		{ ev: "subagents:steered", data: { id: "w1", message: "stop that" } },
	]);
	assert.equal(state["worker:w1"].status, "running");
	assert.deepEqual(timeline.at(-1), { ...timeline.at(-1), from: "orchestrator", to: "worker:w1", kind: "resume", body: "stop that" });
});

test("guard reports are counted by name, kind and role and never create a worker", () => {
	const { state, tracker, audit } = replay([
		{ ev: "guard:path_denied", data: { role: "orchestrator", tool: "read", fragment: "../x" } },
		{ ev: "guard:path_denied", data: { role: "worker:abc", tool: "read", fragment: "../y" } },
		{ ev: "guard:bash_timeout_rewritten", data: { role: "orchestrator", from: null, to: 90 } },
	]);
	assert.deepEqual(state, {});
	assert.deepEqual(tracker.guards, { path: { denied: { orchestrator: 1, "worker:abc": 1 } }, bash_timeout: { rewritten: { orchestrator: 1 } } });
	assert.deepEqual(audit.map((a) => a.type), ["guard", "guard", "guard"]);
	assert.equal(audit[0].agent, "orchestrator");
});

test("a worker that terminated before its transcript appeared is swept from the FIFO", () => {
	const { tracker } = replay([
		{ ev: "subagents:created", data: { id: "dead", isBackground: true } },
		{ ev: "subagents:completed", data: { id: "dead", status: "completed", result: "" } },
		{ ev: "subagents:started", data: { id: "live" } },
	]);
	assert.deepEqual(tracker.unbound, ["worker:live"]);
});

test("bindTranscript claims the oldest unbound worker for a new file and remembers it", () => {
	const { tracker, state } = replay([{ ev: "subagents:started", data: { id: "w1" } }, { ev: "subagents:started", data: { id: "w2" } }]);
	assert.equal(bindTranscript(tracker, state, "/s/tasks/a.jsonl"), "worker:w1");
	assert.equal(bindTranscript(tracker, state, "/s/tasks/a.jsonl"), "worker:w1");
	assert.equal(bindTranscript(tracker, state, "/s/tasks/b.jsonl"), "worker:w2");
	assert.equal(bindTranscript(tracker, state, "/s/tasks/c.jsonl"), null);
});

test("dropUnclaimedSubagentEntry removes only the entry for that tool call, and only if unclaimed", () => {
	const timeline = [
		{ kind: "spawn", to: "worker:w0", body: "claimed", toolCallId: "c0" },
		{ kind: "spawn", to: "worker", body: "phantom", toolCallId: "c1" },
		{ kind: "resume", to: "worker:w0", body: "r", claimed: false, toolCallId: "c2" },
	];
	dropUnclaimedSubagentEntry(timeline, "c0");
	assert.equal(timeline.length, 3);
	dropUnclaimedSubagentEntry(timeline, "c1");
	assert.deepEqual(timeline.map((m) => m.toolCallId), ["c0", "c2"]);
	dropUnclaimedSubagentEntry(timeline, "c2");
	assert.deepEqual(timeline.map((m) => m.toolCallId), ["c0"]);
});
