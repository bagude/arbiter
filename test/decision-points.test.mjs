import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTurn, validMask, extractRun, ACTION_CLASSES, SYMBOLS } from "../tools/decision-points.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "run-trace");
const call = (name, args) => [{ type: "toolCall", name, arguments: args }];

test("classifyTurn maps the first tool call to one of nine action classes with one-token symbols", () => {
	assert.equal(ACTION_CLASSES.length, 9);
	assert.deepEqual(Object.values(SYMBOLS), ["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
	const spawn = classifyTurn(call("subagent", { subagent_type: "tester", description: "t", prompt: "x".repeat(10) }));
	assert.equal(spawn.cls, "spawn");
	assert.deepEqual(spawn.params, { subagent_type: "tester", description: "t", background: false, promptChars: 10 });
	assert.equal(classifyTurn(call("subagent", { resume: "abc-123", description: "again" })).cls, "resume");
	assert.equal(classifyTurn(call("get_subagent_result", { id: "abc" })).cls, "collect");
	assert.equal(classifyTurn(call("send_mail", { kind: "probe", body: JSON.stringify([{ id: "a" }, { id: "b" }]) })).params.cases, 2);
	assert.equal(classifyTurn(call("send_mail", { kind: "done", body: "x" })).cls, "done");
	assert.equal(classifyTurn(call("send_mail", { kind: "memory", body: "x" })).cls, "memory");
	assert.equal(classifyTurn(call("read", { path: "src/a.mjs" })).cls, "inspect");
	assert.equal(classifyTurn(call("memory_get", { ids: ["m_1"] })).cls, "memory");
	assert.equal(classifyTurn(call("checkpoint", {})).cls, "checkpoint");
	assert.equal(classifyTurn([{ type: "text", text: "done" }]).cls, "answer");
	// a text block before the tool call does not change the class
	assert.equal(classifyTurn([{ type: "text", text: "thinking" }, ...call("send_mail", { kind: "probe", body: "[]" })]).cls, "probe");
});

test("validMask conditions on the harness state: no resume before a spawn, no probe before a completion, no done before a probe", () => {
	const fresh = validMask({ spawned: 0, completed: 0, backgroundOutstanding: 0, probes: 0, doneAttempts: 0, pendingProbe: false }, { memoryTools: false });
	assert.deepEqual(fresh, { spawn: true, resume: false, collect: false, probe: false, done: false, inspect: true, memory: false, checkpoint: true, answer: true });
	const later = validMask({ spawned: 1, completed: 1, backgroundOutstanding: 1, probes: 1, doneAttempts: 0, pendingProbe: false }, { memoryTools: true });
	assert.deepEqual(Object.values(later), Array(9).fill(true));
	const waiting = validMask({ spawned: 1, completed: 1, backgroundOutstanding: 0, probes: 1, doneAttempts: 0, pendingProbe: true }, { memoryTools: true });
	assert.equal(waiting.done, false, "no done claim while a probe is unanswered: the runtime knows, the policy must not be asked");
	assert.equal(waiting.probe, true, "another probe batch is still allowed");
});

test("extractRun on the fixture: one point per orchestrator call, a spawn point with its child link, state advancing past the return", () => {
	const res = extractRun(FIXTURE);
	assert.ok(res, "fixture is an orchestrator run");
	const pts = res.points;
	assert.equal(pts.length, 29);
	const spawn = pts.find((p) => p.action.cls === "spawn");
	assert.ok(spawn);
	assert.equal(spawn.action.symbol, "A");
	assert.equal(spawn.valid.resume, false, "nothing to resume before the first spawn");
	assert.ok(spawn.children.some((c) => c.k === "spawned"), "the spawn point links into the worker (this turn also sent mail, so a reply link sits beside it)");
	assert.equal(spawn.outcome.workerCalls, 10);
	const receiver = pts.find((p) => p.children.some((c) => c.k === "received"));
	assert.ok(receiver);
	assert.equal(pts[receiver.i - 1].state.completed, 0, "before the result arrives nothing has completed");
	assert.equal(pts[receiver.i - 1].valid.probe, false);
	assert.equal(receiver.state.completed, 1, "the call whose input holds the worker's result decides with it completed");
	assert.equal(receiver.valid.probe, true);
	assert.equal(receiver.valid.resume, true);
	assert.equal(pts.at(-1).state.completed, 1, "one worker, counted once");
	for (const p of pts) {
		assert.equal(typeof p.decoded, "number");
		assert.equal(p.nValid, Object.values(p.valid).filter(Boolean).length);
	}
});

test("substantiveHorizon skips gather steps to the next state-changing action and counts them", async () => {
	const { substantiveHorizon, modeOf } = await import("../tools/decision-points.mjs");
	const h = substantiveHorizon(["inspect", "memory", "spawn", "inspect", "probe", "answer"]);
	assert.deepEqual(h.map((x) => [x.cls, x.gatherSteps]), [["spawn", 2], ["spawn", 1], ["spawn", 0], ["probe", 1], ["probe", 0], [null, null]]);
	assert.equal(modeOf("inspect"), "gather");
	assert.equal(modeOf("probe"), "gather", "a probe asks for evidence: uncertainty reduction, not commitment");
	assert.equal(modeOf("spawn"), "act");
});
