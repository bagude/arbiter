import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
import { appendLedger } from "../lib/manage/ledger.mjs";
import { writePacket } from "../lib/manage/packet.mjs";
import {
	DEFAULT_MANAGER_MODEL, INSTRUCT_TOOL, MESSAGES_URL, agrees, decide, decisionShape, defaultInstruction,
	executedFor, fillInstruction, replay, requestBody, runsForTask, serve, systemPrompt, triggerEvents,
} from "../lib/manage/manager.mjs";

const RUN_ID = "2026-09-18T01-02-03";

/** A Messages response as the API returns one: a forced `instruct` call. */
const toolUse = (verb, args, rationale = "because the evidence says so") => ({
	ok: true,
	status: 200,
	json: async () => ({ id: "msg_1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "instruct", input: { verb, args, rationale } }] }),
});

/** A fetch that records what it was called with and answers with one canned response. */
function fakeFetch(response) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		return typeof response === "function" ? response() : response;
	};
	impl.calls = calls;
	return impl;
}

function mkRun(runsDir, runId = RUN_ID, { lifecycle = [] } = {}) {
	const dir = path.join(runsDir, runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "audit.jsonl"), JSON.stringify({ t: "1.0", type: "oracle", msg: "Oracle run #1: 68/70 passed." }) + "\n");
	if (lifecycle.length) fs.writeFileSync(path.join(dir, "lifecycle.jsonl"), lifecycle.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return dir;
}

function fixture({ activeRuns = [RUN_ID], lifecycle = [] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-manager-"));
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-manager-runs-"));
	let task = createTask({
		dir, taskId: "t1", goal: "pass pathnorm",
		criteria: [{ id: "c1", text: "all 70 oracle cases pass", check: "oracle:tasks/pathnorm/oracle" }],
		milestones: [{ id: "m1", title: "pass", criteria: ["c1"] }],
		budget: { wallSec: 14400, toolCalls: 5000, runs: 20, forkReplicates: 24 },
	});
	for (const id of activeRuns) mkRun(runsDir, id, { lifecycle });
	task = saveTask(dir, setCurrent(task, { activeRuns, checkpoint: "ck-0007" }));
	return { dir, runsDir, task: loadTask(dir) };
}

const packetFor = (task, over = {}) => ({
	packetId: 7,
	trigger: { kind: "oracle_failed_repeatedly", runId: RUN_ID, detail: { attempts: 2 } },
	task,
	run: { id: RUN_ID, status: "running" },
	history: { recentInstructions: [], settledFindings: [] },
	options: { verbsAllowed: ["continue", "correct", "restore", "compare", "escalate"], budgetLeft: { wallSec: 14400, toolCalls: 5000, runs: 20, forkReplicates: 24, usd: null }, pendingRuns: [RUN_ID], pendingBatches: [] },
	...over,
});

// ---------- the request ----------

test("the system prompt is the four roles, the six verbs and the two rules the manager cannot derive", () => {
	const text = systemPrompt();
	for (const verb of ["continue", "correct", "restore", "compare", "accept", "escalate"]) assert.match(text, new RegExp(`\`${verb}\``));
	assert.match(text, /cannot change the acceptance criteria/i);
	assert.match(text, /escalate/);
	assert.match(text, /cheapest verb the evidence supports/i);
	assert.match(text, /`continue` is not free/);
	assert.match(text, /verbsAllowed/);
	assert.match(text, /budgetLeft/);
	assert.match(text, /pendingRuns/);
	assert.match(text, /pendingBatches/);
	assert.ok(text.split(/\s+/).filter(Boolean).length < 1200, "the system prompt stays under 1 200 words");
});

test("decide sends the packet as the user message under the system prompt and forces the instruct tool", async () => {
	const { task } = fixture();
	const packet = packetFor(task);
	const fetchImpl = fakeFetch(toolUse("continue", { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 300, toolCalls: 50 } }));
	await decide({ packet, fetchImpl, apiKey: "sk-test-key" });

	assert.equal(fetchImpl.calls.length, 1);
	const { url, init, body } = fetchImpl.calls[0];
	assert.equal(url, MESSAGES_URL);
	assert.equal(init.method, "POST");
	assert.equal(init.headers["anthropic-version"], "2023-06-01");
	assert.equal(init.headers["x-api-key"], "sk-test-key");
	assert.equal(body.model, DEFAULT_MANAGER_MODEL);
	assert.equal(body.max_tokens, 1024);
	assert.equal(body.system, systemPrompt());
	assert.deepEqual(body.messages, [{ role: "user", content: JSON.stringify(packet, null, 2) }]);
	assert.deepEqual(body.tool_choice, { type: "tool", name: "instruct" });
	assert.equal(body.tools.length, 1);
	assert.deepEqual(body.tools[0].input_schema.properties.verb.enum, ["continue", "correct", "restore", "compare", "accept", "escalate"]);
});

test("requestBody carries the six verbs as an enum and the rationale limit", () => {
	const body = requestBody({ packet: packetFor(fixture().task) });
	assert.equal(body.tools[0].name, INSTRUCT_TOOL.name);
	assert.equal(body.tools[0].input_schema.properties.rationale.maxLength, 500);
	assert.deepEqual(body.tools[0].input_schema.required, ["verb", "args", "rationale"]);
});

// ---------- what the driver owns ----------

test("decide fills packetId, basedOnStateVersion and the idempotency key from the packet, never from the model", async () => {
	const { task } = fixture();
	const packet = packetFor(task);
	const fetchImpl = fakeFetch({
		ok: true,
		json: async () => ({
			content: [{
				type: "tool_use", name: "instruct",
				// The model tries to name all three itself; every one of them is overridden.
				input: { verb: "correct", args: { runId: RUN_ID, message: "check the trailing separator case" }, rationale: "two attempts stuck at 68/70", packetId: 99, basedOnStateVersion: 1, idempotencyKey: "whatever" },
			}],
		}),
	});
	const instr = await decide({ packet, fetchImpl, apiKey: "k" });
	assert.equal(instr.packetId, 7);
	assert.equal(instr.basedOnStateVersion, task.stateVersion);
	assert.equal(instr.idempotencyKey, `p7-v${task.stateVersion}`);
	assert.equal(instr.verb, "correct");
	assert.deepEqual(instr.args, { runId: RUN_ID, message: "check the trailing separator case" });
	assert.equal(instr.manager.model, DEFAULT_MANAGER_MODEL);
	assert.ok(Number.isFinite(instr.manager.ms));
	assert.equal(instr.defaulted, undefined);
});

test("an unknown verb is not passed through: it becomes the default continue with a zero grant", async () => {
	const { task } = fixture();
	const instr = await decide({ packet: packetFor(task), fetchImpl: fakeFetch(toolUse("refactor", { runId: RUN_ID })), apiKey: "k" });
	assert.equal(instr.verb, "continue");
	assert.equal(instr.defaulted, true);
	assert.deepEqual(instr.args.budgetGrant, { wallSec: 0, toolCalls: 0 });
	assert.equal(instr.args.runId, RUN_ID);
	assert.equal(instr.args.milestone, "m1");
	assert.match(instr.error, /refactor/);
	assert.match(instr.manager.error, /refactor/);
	assert.ok(instr.rationale.length <= 500);
});

test("an unparsable tool input defaults too, and a missing instruct call defaults", async () => {
	const { task } = fixture();
	const noCall = await decide({ packet: packetFor(task), fetchImpl: fakeFetch({ ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "I think we should continue" }] }) }), apiKey: "k" });
	assert.equal(noCall.verb, "continue");
	assert.equal(noCall.defaulted, true);
	assert.match(noCall.error, /no instruct call/);

	const badBody = await decide({ packet: packetFor(task), fetchImpl: fakeFetch({ ok: true, json: async () => { throw new Error("Unexpected token < in JSON"); } }), apiKey: "k" });
	assert.equal(badBody.defaulted, true);
	assert.match(badBody.error, /could not be read/);
});

test("an API error defaults and reports the status, without the key", async () => {
	const { task } = fixture();
	const instr = await decide({ packet: packetFor(task), fetchImpl: fakeFetch({ ok: false, status: 400, text: async () => '{"error":{"message":"tool_choice is not supported"}}' }), apiKey: "sk-secret-key-value" });
	assert.equal(instr.verb, "continue");
	assert.equal(instr.defaulted, true);
	assert.match(instr.error, /HTTP 400/);
	assert.match(instr.error, /tool_choice/);
	assert.ok(!JSON.stringify(instr).includes("sk-secret-key-value"), "no error path may carry the key");
});

test("a manager that never answers defaults at the timeout", async () => {
	const { task } = fixture();
	const started = Date.now();
	const instr = await decide({ packet: packetFor(task), fetchImpl: () => new Promise(() => {}), apiKey: "k", timeoutMs: 50 });
	assert.ok(Date.now() - started < 5000, "the default arrives at the timeout, not at the transport's");
	assert.equal(instr.verb, "continue");
	assert.equal(instr.defaulted, true);
	assert.match(instr.error, /within 50 ms/);
	assert.deepEqual(instr.args.budgetGrant, { wallSec: 0, toolCalls: 0 });
});

test("the default instruction is executable: a zero grant spends nothing", () => {
	const { task } = fixture();
	const instr = defaultInstruction(packetFor(task), { error: "no answer" });
	assert.deepEqual(fillInstruction(packetFor(task), { verb: "continue", args: instr.args, rationale: instr.rationale }).idempotencyKey, instr.idempotencyKey);
	assert.equal(instr.basedOnStateVersion, task.stateVersion);
});

// ---------- replay ----------

test("replay scores candidate instructions against the ledger's executed rows", async () => {
	const { dir, task } = fixture();
	const p1 = { ...packetFor(task), packetId: 1 };
	const p2 = { ...packetFor(task), packetId: 2, trigger: { kind: "run_ended_without_acceptance", runId: RUN_ID, detail: {} } };
	writePacket(dir, p1);
	writePacket(dir, p2);
	appendLedger(dir, { packetId: 1, stateVersion: task.stateVersion, trigger: "oracle_failed_repeatedly", verified: true, refused: null, instruction: { packetId: 1, verb: "correct", args: { runId: RUN_ID, message: "look at the trailing separator" } } });
	appendLedger(dir, { packetId: 2, stateVersion: task.stateVersion, trigger: "run_ended_without_acceptance", verified: true, refused: null, instruction: { packetId: 2, verb: "restore", args: { checkpoint: "ck-0007" } } });

	// Agrees on packet 1 (same verb, same run), disagrees on packet 2 (escalate, not restore).
	let n = 0;
	const decideImpl = async ({ packet }) => {
		n++;
		return packet.packetId === 1
			? { ...fillInstruction(packet, { verb: "correct", args: { runId: RUN_ID, message: "the same correction" }, rationale: "r" }), manager: { model: "m", ms: 3 } }
			: { ...fillInstruction(packet, { verb: "escalate", args: { reason: "stuck", wants: "human_review" }, rationale: "r" }), manager: { model: "m", ms: 4 } };
	};
	const lines = [];
	const out = await replay({ taskDir: dir, model: "claude-sonnet-5", decideImpl, out: (s) => lines.push(s) });

	assert.equal(n, 2);
	assert.equal(out.rows.length, 2);
	assert.deepEqual(out.rows.map((r) => r.agree), [true, false]);
	assert.deepEqual(out.rows[0].expected, { verb: "correct", runId: RUN_ID });
	assert.deepEqual(out.rows[1].got, { verb: "escalate" });
	assert.deepEqual(out.rows.map((r) => r.trigger), ["oracle_failed_repeatedly", "run_ended_without_acceptance"]);
	assert.match(lines.join("\n"), /agreement 1\/2/);
	assert.match(lines.join("\n"), /oracle_failed_repeatedly: 1\/1/);
	assert.match(lines.join("\n"), /confusion \(ledger -> candidate\)/);
	assert.match(lines.join("\n"), /restore -> escalate/);
	assert.ok(fs.existsSync(out.file), "the rows are written under replays/");
	assert.match(path.basename(out.file), /^claude-sonnet-5-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/);
	assert.equal(fs.readFileSync(out.file, "utf8").trim().split("\n").length, 2);
});

test("a packet with no executed instruction is skipped, not counted as a disagreement", async () => {
	const { dir, task } = fixture();
	writePacket(dir, { ...packetFor(task), packetId: 1 });
	writePacket(dir, { ...packetFor(task), packetId: 2 });
	// Packet 1 was refused; packet 2 executed. Only packet 2 is a label.
	appendLedger(dir, { packetId: 1, verified: false, refused: "stale_version", instruction: { packetId: 1, verb: "compare", args: {} } });
	appendLedger(dir, { packetId: 2, verified: true, refused: null, instruction: { packetId: 2, verb: "continue", args: { runId: RUN_ID } } });
	const decideImpl = async ({ packet }) => ({ ...fillInstruction(packet, { verb: "continue", args: { runId: RUN_ID }, rationale: "r" }), manager: { model: "m", ms: 1 } });
	const lines = [];
	const out = await replay({ taskDir: dir, model: "m", decideImpl, out: (s) => lines.push(s) });
	assert.equal(out.rows.length, 1);
	assert.equal(out.skipped.length, 1);
	assert.match(lines.join("\n"), /agreement 1\/1/);
});

test("a retracted row is not the decision the ledger recorded", () => {
	const rows = [
		{ seq: 1, packetId: 4, verified: true, instruction: { verb: "compare", args: {} } },
		{ seq: 2, kind: "reversed", forSeq: 1, reason: "stale_version" },
		{ seq: 3, packetId: 4, verified: true, instruction: { verb: "continue", args: {} } },
	];
	assert.equal(executedFor(rows, 4).verb, "continue");
	assert.equal(executedFor(rows, 9), null);
});

test("agreement is the verb plus the target that changes what the verb means", () => {
	assert.ok(agrees({ verb: "continue", runId: "a" }, { verb: "continue", runId: "b" }), "continue is about the run the packet is about either way");
	assert.ok(!agrees({ verb: "correct", runId: "a" }, { verb: "correct", runId: "b" }));
	assert.ok(!agrees({ verb: "restore", checkpoint: "ck-0007" }, { verb: "restore", checkpoint: "ck-0008" }));
	assert.ok(agrees({ verb: "restore", checkpoint: "ck-0007" }, { verb: "restore", checkpoint: "ck-0007" }));
	assert.ok(!agrees({ verb: "restore", checkpoint: "ck-0007" }, { verb: "compare", checkpoint: "ck-0007" }));
	assert.deepEqual(decisionShape({ verb: "compare", args: { checkpoint: "ck-1" } }), { verb: "compare", checkpoint: "ck-1" });
});

// ---------- serve ----------

test("serve --once assembles a packet for a manage:trigger, decides and executes it", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [
			{ ts: 1, ev: "jev:done_claimed", data: {} },
			{ ts: 2, ev: "manage:trigger", data: { kind: "oracle_failed_repeatedly", pauses: true, packetRequest: { runId: RUN_ID, detail: { attempts: 2 } } } },
		],
	});
	const fetchImpl = fakeFetch(toolUse("correct", { runId: RUN_ID, message: "probe the trailing separator case before claiming done" }, "two attempts at 68/70"));
	const saved = [];
	const out = await serve({
		taskDir: dir, runsDir, fetchImpl, apiKey: "k", once: true, maxTicks: 1,
		launchBatch: () => ({ pid: 0 }),
		save: (d, t, opts) => { saved.push(t); return t; },
	});

	assert.equal(out.handled.length, 1);
	const { packet, instr, manager, result } = out.handled[0];
	assert.equal(packet.trigger.kind, "oracle_failed_repeatedly");
	assert.deepEqual(packet.trigger.detail, { attempts: 2 });
	assert.equal(instr.verb, "correct");
	assert.equal(instr.packetId, packet.packetId);
	assert.equal(result.executed, true, result.refusal ?? "");
	// §5: the manager's cost sits beside the instruction in the row, not inside it.
	assert.equal(result.ledgerRow.manager.model, DEFAULT_MANAGER_MODEL);
	assert.equal(result.ledgerRow.instruction.verb, "correct");
	assert.equal(result.ledgerRow.instruction.manager, undefined);
	// The correction reached the run through the one channel the executor has.
	const control = fs.readFileSync(path.join(runsDir, RUN_ID, "control.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
	assert.equal(control.find((c) => c.type === "correct").message, "probe the trailing separator case before claiming done");
	assert.ok(control.some((c) => c.type === "decision" && c.verb === "correct"), "the decision entry releases the pause");
	// The packet was recorded verbatim, and the loop said what it did.
	assert.ok(fs.existsSync(path.join(dir, "packets", `${packet.packetId}.json`)));
	const log = fs.readFileSync(path.join(dir, "serve.log"), "utf8");
	assert.match(log, /oracle_failed_repeatedly/);
	assert.match(log, /executed/);
	assert.ok(!log.includes("\"k\""), "the log never carries the key");

	// A second serve does not answer the same trigger twice.
	const again = await serve({ taskDir: dir, runsDir, fetchImpl, apiKey: "k", once: true, maxTicks: 1, launchBatch: () => ({ pid: 0 }) });
	assert.equal(again.handled.length, 0);
	assert.equal(fetchImpl.calls.length, 1);
});

test("serve answers a run this task registered, or one an operator adopted — never an unidentified one", () => {
	const { dir, runsDir } = fixture({ activeRuns: [RUN_ID], lifecycle: [{ ts: 1, ev: "manage:trigger", data: { kind: "budget_threshold" } }] });
	const stranger = "2026-09-18T09-09-09";
	mkRun(runsDir, stranger, { lifecycle: [{ ts: 1, ev: "manage:trigger", data: { kind: "budget_threshold" } }] });

	assert.deepEqual(runsForTask({ taskDir: dir, runsDir }), [RUN_ID]);
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir, adopt: [stranger] }).sort(), [RUN_ID, stranger].sort());

	// A run whose own config names this task directory is admitted without --run.
	fs.writeFileSync(path.join(runsDir, stranger, "config.json"), JSON.stringify({ task: "pathnorm", manage: { enabled: true, taskDir: dir } }));
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir }).sort(), [RUN_ID, stranger].sort());

	// One that names a different task is still not this loop's business.
	fs.writeFileSync(path.join(runsDir, stranger, "config.json"), JSON.stringify({ manage: { enabled: true, taskDir: path.join(dir, "..", "somebody-else") } }));
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir }), [RUN_ID]);

	assert.equal(triggerEvents(path.join(runsDir, RUN_ID)).length, 1);
});

test("serve never raises on an API failure: the default continue is executed and recorded", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { kind: "budget_threshold", pauses: false, packetRequest: { runId: RUN_ID, detail: { fraction: 0.75 } } } }],
	});
	const out = await serve({
		taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k",
		fetchImpl: async () => { throw new Error("ECONNREFUSED 1.2.3.4:443"); },
	});
	assert.equal(out.handled.length, 1);
	const { instr, result } = out.handled[0];
	assert.equal(instr.verb, "continue");
	assert.equal(instr.defaulted, true);
	assert.equal(result.executed, true, result.refusal ?? "");
	assert.match(result.ledgerRow.manager.error, /ECONNREFUSED/);
	// A zero grant spends nothing, so the task's budget is untouched and the version did not move.
	assert.deepEqual(loadTask(dir).budget.wallSec, { total: 14400, used: 0 });
});
