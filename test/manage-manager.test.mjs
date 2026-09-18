import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createTask, loadTask, saveTask, setCurrent } from "../lib/manage/task-state.mjs";
import { appendLedger } from "../lib/manage/ledger.mjs";
import { writePacket } from "../lib/manage/packet.mjs";
import {
	DEFAULT_MANAGER_MODEL, DEFAULT_TIMEOUT_MS, INSTRUCT_TOOL, MAX_DECISION_TOKENS, MESSAGES_URL,
	SUPERVISOR_DEADLINE_MS, UNSUPPORTED_MODEL, acquireServeLock, agrees, decide, decisionShape,
	defaultInstruction, driverTimeoutMs, executedFor, fillInstruction, lockFile, pidAlive, replay,
	requestBody, runsForTask, serve, supervisorDeadlineMs, systemPrompt, triggerEvents,
	unsupportedModelReason,
} from "../lib/manage/manager.mjs";
import { readApiKey, splitArgs } from "../tools/manage.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "manage.mjs");

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
	// Not the size of the answer: thinking is on by default and counts against the cap, so a cap
	// sized for the instruction is one the model can hit before it emits the call at all.
	assert.equal(body.max_tokens, 4096);
	assert.equal(MAX_DECISION_TOKENS, 4096);
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

	// A run whose trigger event names this task directory is admitted without --run: that is how
	// a live run identifies itself before the task registers it.
	const self = "2026-09-18T10-10-10";
	mkRun(runsDir, self, { lifecycle: [{ ts: 1, ev: "manage:trigger", data: { kind: "budget_threshold", pauses: false, packetRequest: { runId: self, detail: {}, taskDir: dir } } }] });
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir }).sort(), [RUN_ID, self].sort());
	fs.rmSync(path.join(runsDir, self), { recursive: true, force: true });
	// A trigger naming another task, or none, admits nothing.
	mkRun(runsDir, self, { lifecycle: [{ ts: 1, ev: "manage:trigger", data: { kind: "budget_threshold", pauses: false, packetRequest: { runId: self, detail: {}, taskDir: path.join(dir, "..", "somebody-else") } } }] });
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir }), [RUN_ID]);
	fs.rmSync(path.join(runsDir, self), { recursive: true, force: true });

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

// ---------- the driver's budget (§4 headroom) ----------

test("the driver's default budget is strictly inside the supervisor's deadline", () => {
	assert.ok(DEFAULT_TIMEOUT_MS < SUPERVISOR_DEADLINE_MS, `${DEFAULT_TIMEOUT_MS} must leave headroom inside ${SUPERVISOR_DEADLINE_MS}`);
	// Everything else in the round trip lives in the same window: up to pollMs to notice the
	// event, packet assembly, the control append, and the supervisor's own 2 s control poll.
	assert.equal(driverTimeoutMs({}), 90_000);
	assert.equal(supervisorDeadlineMs({}), 120_000);
});

test("MANAGE_DECISION_TIMEOUT_MS moves both deadlines together; MANAGE_DRIVER_TIMEOUT_MS overrides the driver's alone", () => {
	const env = { MANAGE_DECISION_TIMEOUT_MS: "300000" };
	assert.equal(supervisorDeadlineMs(env), 300_000);
	assert.equal(driverTimeoutMs(env), 225_000);
	assert.ok(driverTimeoutMs(env) < supervisorDeadlineMs(env));
	assert.equal(driverTimeoutMs({ ...env, MANAGE_DRIVER_TIMEOUT_MS: "60000" }), 60_000);
	// A nonsense value falls back to the fraction rather than to zero, which would default instantly.
	assert.equal(driverTimeoutMs({ MANAGE_DRIVER_TIMEOUT_MS: "nope" }), 90_000);
});

// ---------- the model families that cannot answer ----------

test("decide refuses a forced-tool_choice-incompatible model without calling fetch", async () => {
	const { task } = fixture();
	const fetchImpl = fakeFetch(toolUse("continue", { runId: RUN_ID, milestone: "m1" }));
	for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
		const instr = await decide({ packet: packetFor(task), fetchImpl, apiKey: "k", model });
		assert.equal(instr.verb, "continue");
		assert.equal(instr.defaulted, true);
		assert.match(instr.manager.error, /forced tool_choice/);
		assert.match(instr.manager.error, new RegExp(model));
	}
	assert.equal(fetchImpl.calls.length, 0, "no request is made for a model that cannot answer one");
	assert.ok(UNSUPPORTED_MODEL.test("claude-fable-5"));
	assert.ok(!UNSUPPORTED_MODEL.test(DEFAULT_MANAGER_MODEL));
	assert.match(unsupportedModelReason("x"), /400/);
});

test("the CLI refuses that model at exit 2, before it asks for a key", () => {
	const { dir, task } = fixture();
	writePacket(dir, packetFor(task));
	const r = spawnSync(process.execPath, [CLI, "decide", dir, "7", "--model", "claude-fable-5-1"], {
		encoding: "utf8",
		env: { ...process.env, ANTHROPIC_API_KEY: "", ARBITER_DOTENV: path.join(dir, "no-such.env") },
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /forced tool_choice/);
	assert.ok(!r.stderr.includes("ANTHROPIC_API_KEY"), "the model is refused before the key is looked for");
});

// ---------- transient answers ----------

test("one 429 is retried inside the budget; a second failure defaults", async () => {
	const { task } = fixture();
	let n = 0;
	const fetchImpl = async () => {
		n++;
		return n === 1
			? { ok: false, status: 429, text: async () => '{"type":"error","error":{"type":"rate_limit_error"}}' }
			: toolUse("continue", { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 0, toolCalls: 0 } });
	};
	const instr = await decide({ packet: packetFor(task), fetchImpl, apiKey: "k", retryDelayMs: 1 });
	assert.equal(n, 2, "the rate limit is retried exactly once");
	assert.equal(instr.defaulted, undefined);
	assert.equal(instr.verb, "continue");

	let m = 0;
	const always429 = async () => { m++; return { ok: false, status: 429, text: async () => "rate limited" }; };
	const gave = await decide({ packet: packetFor(task), fetchImpl: always429, apiKey: "k", retryDelayMs: 1 });
	assert.equal(m, 2, "one retry, not a loop");
	assert.equal(gave.defaulted, true);
	assert.match(gave.error, /HTTP 429/);

	// A 400 is the model or the request, not the weather: answered once.
	let b = 0;
	const bad = async () => { b++; return { ok: false, status: 400, text: async () => "bad request" }; };
	await decide({ packet: packetFor(task), fetchImpl: bad, apiKey: "k", retryDelayMs: 1 });
	assert.equal(b, 1);
});

test("a retry that would not fit the remaining budget is not attempted", async () => {
	const { task } = fixture();
	let n = 0;
	const fetchImpl = async () => { n++; return { ok: false, status: 503, text: async () => "overloaded" }; };
	const instr = await decide({ packet: packetFor(task), fetchImpl, apiKey: "k", timeoutMs: 30, retryDelayMs: 1000 });
	assert.equal(n, 1, "the delay alone would outlive the decision window");
	assert.equal(instr.defaulted, true);
});

test("the manager's token usage is kept, because §5's row has a usd slot and nothing else can feed it", async () => {
	const { task } = fixture();
	const fetchImpl = fakeFetch({
		ok: true,
		json: async () => ({ stop_reason: "tool_use", usage: { input_tokens: 9000, output_tokens: 300 }, content: [{ type: "tool_use", name: "instruct", input: { verb: "escalate", args: { reason: "r", wants: "budget" }, rationale: "r" } }] }),
	});
	const instr = await decide({ packet: packetFor(task), fetchImpl, apiKey: "k" });
	assert.deepEqual(instr.manager.usage, { input_tokens: 9000, output_tokens: 300 });
});

test("a max_tokens answer with no tool call defaults, and says so", async () => {
	const { task } = fixture();
	const instr = await decide({ packet: packetFor(task), fetchImpl: fakeFetch({ ok: true, json: async () => ({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] }) }), apiKey: "k" });
	assert.equal(instr.defaulted, true);
	assert.match(instr.error, /max_tokens/);
});

test("a 400 body that echoes the key comes back redacted", async () => {
	const { task } = fixture();
	const key = "sk-ant-api03-0123456789abcdefghijklmnop";
	const instr = await decide({
		packet: packetFor(task), apiKey: key,
		fetchImpl: fakeFetch({ ok: false, status: 401, text: async () => `{"error":{"message":"invalid x-api-key: ${key}"}}` }),
	});
	assert.match(instr.error, /HTTP 401/);
	assert.ok(!JSON.stringify(instr).includes(key), "a body that echoes the key must be redacted before it reaches a ledger row");
	assert.match(instr.error, /REDACTED/);
});

// ---------- the CLI's argument and key handling ----------

test("splitArgs pairs flags with values, and treats a flag followed by a flag as a switch", () => {
	assert.deepEqual(splitArgs(["dir", "--model", "m", "--once"]), { flags: { model: "m", once: true }, positionals: ["dir"] });
	// The rule that matters: --once must not swallow --model, and m must not become a positional.
	assert.deepEqual(splitArgs(["dir", "--once", "--model", "m"]), { flags: { once: true, model: "m" }, positionals: ["dir"] });
	assert.deepEqual(splitArgs(["a", "b"]), { flags: {}, positionals: ["a", "b"] });
	assert.deepEqual(splitArgs(["--trigger"]), { flags: { trigger: true }, positionals: [] });
	// Pinned honestly, because it is a real consequence rather than an accident: a value that
	// itself begins with "--" cannot be passed — it is read as the next flag, never dropped.
	assert.deepEqual(splitArgs(["--rationale", "--not-a-flag", "x"]), { flags: { rationale: true, "not-a-flag": "x" }, positionals: [] });
});

test("readApiKey prefers the environment, reads a .env line, and strips matching quotes", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-key-"));
	fs.writeFileSync(path.join(dir, ".env"), 'OTHER=1\nANTHROPIC_API_KEY="sk-ant-from-file"\n');
	assert.equal(readApiKey({ env: { ANTHROPIC_API_KEY: "sk-ant-from-env" }, root: dir }), "sk-ant-from-env");
	assert.equal(readApiKey({ env: {}, root: dir }), "sk-ant-from-file");
	assert.equal(readApiKey({ env: { ANTHROPIC_API_KEY: "'sk-ant-quoted'" }, root: dir }), "sk-ant-quoted");
	fs.writeFileSync(path.join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-plain\n");
	assert.equal(readApiKey({ env: {}, root: dir }), "sk-ant-plain");
	// A lone quote is not a quoted string, and a key is never rewritten on a guess.
	assert.equal(readApiKey({ env: { ANTHROPIC_API_KEY: '"sk-ant-half' }, root: dir }), '"sk-ant-half');
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "manage-key-none-"));
	assert.equal(readApiKey({ env: {}, root: empty }), null);
	// ARBITER_DOTENV names the file instead of the repo's own.
	assert.equal(readApiKey({ env: { ARBITER_DOTENV: path.join(dir, ".env") }, root: empty }), "sk-ant-plain");
});

test("the CLI exits 2 when there is no key anywhere", () => {
	const { dir, task } = fixture();
	writePacket(dir, packetFor(task));
	const r = spawnSync(process.execPath, [CLI, "decide", dir, "7"], {
		encoding: "utf8",
		env: { ...process.env, ANTHROPIC_API_KEY: "", ARBITER_DOTENV: path.join(dir, "no-such.env") },
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /no ANTHROPIC_API_KEY/);
});

test("--timeout must be a positive number of milliseconds", () => {
	const { dir, task } = fixture();
	writePacket(dir, packetFor(task));
	const r = spawnSync(process.execPath, [CLI, "decide", dir, "7", "--timeout", "0"], {
		encoding: "utf8",
		env: { ...process.env, ANTHROPIC_API_KEY: "", ARBITER_DOTENV: path.join(dir, "no-such.env") },
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /--timeout must be a positive number/);
});

// ---------- the loop's durability ----------

test("the correction is on disk before the decision that releases the pause", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { kind: "oracle_failed_repeatedly", pauses: true, packetRequest: { runId: RUN_ID, detail: {} } } }],
	});
	await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl: fakeFetch(toolUse("correct", { runId: RUN_ID, message: "probe the empty-string case" })) });
	const control = fs.readFileSync(path.join(runsDir, RUN_ID, "control.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
	const correct = control.findIndex((c) => c.type === "correct");
	const decision = control.findIndex((c) => c.type === "decision");
	assert.ok(correct >= 0 && decision >= 0);
	// §4: the withheld verdict is delivered together with the correction, which only works if the
	// correction is already on disk when the decision entry releases the pause.
	assert.ok(correct < decision, `correct (${correct}) must precede decision (${decision})`);
});

test("a trigger whose packet was written is never answered twice, even if the executor died after it", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { kind: "budget_threshold", packetRequest: { runId: RUN_ID, detail: {} } } }],
	});
	const fetchImpl = fakeFetch(toolUse("continue", { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 0, toolCalls: 0 } }));
	const died = await serve({
		taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl,
		execute: () => { throw new Error("killed between the packet and the row"); },
	});
	assert.equal(died.handled.length, 0);
	// The packet is the marker: the pointer moved when it was written, so a restart skips the
	// trigger and the supervisor defaults it, rather than assembling a second packet under a
	// second idempotency key and launching the same work twice.
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "serve.state.json"), "utf8")).handled[RUN_ID], 1);
	const after = await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl });
	assert.equal(after.handled.length, 0);
	assert.equal(fs.readdirSync(path.join(dir, "packets")).length, 1, "no second packet for the same trigger");
});

test("a thrown handler says what the skip costs", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { kind: "oracle_failed_repeatedly", packetRequest: { runId: RUN_ID, detail: {} } } }],
	});
	// A truncated record: the packet cannot be assembled over this run at all.
	fs.writeFileSync(path.join(runsDir, RUN_ID, "summary.json"), '{ "runId": "trunca');
	const out = await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl: fakeFetch(toolUse("continue", {})), supervisorDeadline: 120_000 });
	assert.equal(out.handled.length, 0);
	const log = fs.readFileSync(path.join(dir, "serve.log"), "utf8");
	assert.match(log, /skipped after a thrown handler/);
	assert.match(log, /defaults after the supervisor's deadline \(120000 ms\)/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "serve.state.json"), "utf8")).handled[RUN_ID], 1, "a thrown trigger is not retried every tick");
});

test("an event with no kind is skipped and logged, never given a kind of its own", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { pauses: false, packetRequest: { runId: RUN_ID, detail: {} } } }],
	});
	const fetchImpl = fakeFetch(toolUse("continue", {}));
	const out = await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl });
	assert.equal(out.handled.length, 0);
	assert.equal(fetchImpl.calls.length, 0, "no manager is asked about a packet that could not be built");
	assert.match(fs.readFileSync(path.join(dir, "serve.log"), "utf8"), /carries no kind/);
	assert.ok(!fs.existsSync(path.join(dir, "packets", "1.json")));
});

test("a second loop refuses while a live one holds the lock, and takes over a stale one", async () => {
	const { dir, runsDir } = fixture({
		lifecycle: [{ ts: 2, ev: "manage:trigger", data: { kind: "budget_threshold", packetRequest: { runId: RUN_ID, detail: {} } } }],
	});
	// This process is alive, so a lock naming it is a lock another loop must obey.
	fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
	const fetchImpl = fakeFetch(toolUse("continue", { runId: RUN_ID, milestone: "m1", budgetGrant: { wallSec: 0, toolCalls: 0 } }));
	const blocked = await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl });
	assert.equal(blocked.refused, "locked");
	assert.equal(blocked.handled.length, 0);
	assert.equal(fetchImpl.calls.length, 0);
	assert.equal(blocked.owner.pid, process.pid);

	// A lock whose owner is gone is taken over: Ctrl-C must not make a task unservable by hand.
	fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 2147483647, startedAt: 1 }));
	assert.equal(pidAlive(2147483647), false);
	const took = await serve({ taskDir: dir, runsDir, once: true, maxTicks: 1, apiKey: "k", fetchImpl });
	assert.equal(took.handled.length, 1);
	assert.equal(fs.existsSync(lockFile(dir)), false, "the lock is released on the way out");
});

test("acquireServeLock is exclusive while its owner lives", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manage-lock-"));
	assert.deepEqual(acquireServeLock(dir), { ok: true });
	const second = acquireServeLock(dir);
	assert.equal(second.ok, false);
	assert.equal(second.owner.pid, process.pid);
	assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), "utf8")).pid, process.pid);
});

test("the admission memo re-checks a run whose lifecycle has grown", () => {
	const { dir, runsDir } = fixture({ activeRuns: [] });
	const later = "2026-09-18T09-09-09";
	mkRun(runsDir, later, { lifecycle: [{ ts: 1, ev: "jev:done_claimed", data: {} }] });
	const admitCache = new Map();
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir, admitCache }), []);
	assert.equal(admitCache.get(later).admitted, false);
	// The run now says which task it belongs to. A memo keyed on the file's size and mtime sees it.
	fs.appendFileSync(path.join(runsDir, later, "lifecycle.jsonl"), JSON.stringify({ ts: 2, ev: "manage:trigger", data: { kind: "escalation", packetRequest: { runId: later, taskDir: dir, detail: {} } } }) + "\n");
	assert.deepEqual(runsForTask({ taskDir: dir, runsDir, admitCache }), [later]);
	assert.equal(admitCache.get(later).admitted, true);
});
