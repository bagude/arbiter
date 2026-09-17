import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/fork-force.ts through tsx with a fake `pi`: each `tool_call`
// event carries its own toolName and input (unlike pre-spawn-compact, which always
// calls `subagent`). The guard is opt-in — it registers nothing unless
// ARBITER_FORK_FORCE is set, and only acts for the orchestrator role.
const PI = "C:/Users/user/open_harnessess/pi/pi";

// `sessionFile` is what the role gate actually reads: pi-subagents workers run INSIDE the
// orchestrator's process and so carry AGENT_NAME=orchestrator too, and guard-kit's roleFor
// tells them apart only by a session path ending `/tasks/<id>.jsonl`. `allowFail` is for the
// one case that must take the agent process down: a force file the guard cannot read.
function run({ calls, env = {}, agentName = "orchestrator", sessionFile = null, allowFail = false }) {
	const lifecycle = path.join(os.tmpdir(), `fork-force-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `fork-force-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/fork-force.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const sessionFile = ${JSON.stringify(sessionFile)};
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => sessionFile ?? undefined } };
		const out = [];
		for (const call of ${JSON.stringify(calls)}) {
			const input = { ...call.input };
			const result = handlers.tool_call ? await handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName: call.toolName, input }, ctx) : "not-registered";
			out.push({ result: result === undefined ? null : result, input });
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: agentName, ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ARBITER_FORK_FORCE: "", ...env },
	});
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	if (allowFail) return { status: r.status, stderr: r.stderr, stdout: r.stdout, lines };
	assert.equal(r.status, 0, r.stderr);
	return { ...JSON.parse(r.stdout.trim()), lines, status: r.status };
}

test("not registered when ARBITER_FORK_FORCE is unset", () => {
	const { registered, out } = run({ calls: [{ toolName: "read", input: { path: "a" } }] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, [{ result: "not-registered", input: { path: "a" } }]);
});

test("A-natural (cls=probe): a read is blocked with the probe named, then a probe passes, then a later read passes with no further events", () => {
	const { registered, out, lines } = run({
		calls: [
			{ toolName: "read", input: { path: "a" } },
			{ toolName: "send_mail", input: { kind: "probe", body: "[]" } },
			{ toolName: "read", input: { path: "b" } },
		],
		env: { ARBITER_FORK_FORCE: JSON.stringify({ cls: "probe" }) },
	});
	assert.deepEqual(registered, ["tool_call"]);
	assert.equal(out[0].result.block, true);
	assert.match(out[0].result.reason, /send a probe to the supervisor/);
	assert.equal(out[1].result, null, "the probe itself passes (guard returns undefined; JSON carries it as null)");
	assert.equal(out[2].result, null, "disarmed after the forced call");
	assert.equal(lines.length, 1, "only the denied attempt is reported");
	assert.equal(lines[0].ev, "guard:fork_force_denied");
	assert.equal(lines[0].data.role, "orchestrator");
});

test("A-oracle (cls=resume, tool=subagent): the subagent call's input is mutated in place to the recorded args and reported", () => {
	const { registered, out, lines } = run({
		calls: [{ toolName: "subagent", input: { resume: "abc", prompt: "the model's own brief" } }],
		env: { ARBITER_FORK_FORCE: JSON.stringify({ cls: "resume", tool: "subagent", args: { resume: "abc", prompt: "R" } }) },
	});
	assert.deepEqual(registered, ["tool_call"]);
	assert.equal(out[0].result, null);
	assert.deepEqual(out[0].input, { resume: "abc", prompt: "R" }, "input rewritten in place to the recorded args");
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "guard:fork_force_rewritten");
	assert.equal(lines[0].data.tool, "subagent");
});

test("A-oracle via a file (ARBITER_FORK_FORCE='@<path>'): the force spec is read from disk, not the env value itself", () => {
	const file = path.join(os.tmpdir(), `fork-force-args-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(file, JSON.stringify({ cls: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" } }));
	try {
		const { registered, out, lines } = run({
			calls: [{ toolName: "send_mail", input: { kind: "probe", body: '["different"]' } }],
			env: { ARBITER_FORK_FORCE: `@${file}` },
		});
		assert.deepEqual(registered, ["tool_call"]);
		assert.equal(out[0].result, null);
		assert.deepEqual(out[0].input, { kind: "probe", body: "[]" }, "input rewritten in place to the recorded args, read from the file");
		assert.equal(lines.length, 1);
		assert.equal(lines[0].ev, "guard:fork_force_rewritten");
	} finally {
		fs.rmSync(file, { force: true });
	}
});

// A fork that cannot arm itself must not start. A-oracle ALWAYS uses the file form, so a
// silently-disarmed guard produced a run labelled A-oracle that behaved like the null branch
// G with nothing in its report saying so. The throw takes the agent process down instead.
test("ARBITER_FORK_FORCE='@<missing path>' throws rather than disarming the guard", () => {
	const missing = path.join(os.tmpdir(), "no-such-fork-force-file.json");
	const { status, stderr } = run({
		calls: [{ toolName: "read", input: { path: "a" } }],
		env: { ARBITER_FORK_FORCE: `@${missing}` },
		allowFail: true,
	});
	assert.notEqual(status, 0, "the process must fail, not register an unarmed guard");
	assert.match(stderr, /force file that cannot be read/);
});

test("ARBITER_FORK_FORCE='@<path>' whose file is not a usable force spec throws too", () => {
	const bad = path.join(os.tmpdir(), `fork-force-bad-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(bad, "{ not json");
	const noCls = path.join(os.tmpdir(), `fork-force-nocls-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(noCls, JSON.stringify({ tool: "send_mail" }));
	try {
		const parse = run({ calls: [{ toolName: "read", input: { path: "a" } }], env: { ARBITER_FORK_FORCE: `@${bad}` }, allowFail: true });
		assert.notEqual(parse.status, 0);
		assert.match(parse.stderr, /is not JSON/);
		const cls = run({ calls: [{ toolName: "read", input: { path: "a" } }], env: { ARBITER_FORK_FORCE: `@${noCls}` }, allowFail: true });
		assert.notEqual(cls.status, 0);
		assert.match(cls.stderr, /has no "cls"/);
	} finally {
		fs.rmSync(bad, { force: true });
		fs.rmSync(noCls, { force: true });
	}
});

// An empty ARBITER_FORK_FORCE is an ordinary run, not a fork that lost its orders: every
// agent process of every run loads this guard, so this is the path all of them take.
test("an absent ARBITER_FORK_FORCE still registers nothing, without throwing", () => {
	const { registered, out } = run({ calls: [{ toolName: "read", input: { path: "a" } }], env: { ARBITER_FORK_FORCE: "   " } });
	assert.deepEqual(registered, []);
	assert.equal(out[0].result, "not-registered");
});

// pi-subagents workers run inside the orchestrator's own process, so AGENT_NAME says
// "orchestrator" for them too; guard-kit's roleFor separates them only by the session path.
// Gating on AGENT_NAME instead would exercise a branch that never occurs in a live run.
test("a worker's tool_call is never forced (role gate), even though it carries AGENT_NAME=orchestrator", () => {
	const { out, lines } = run({
		calls: [{ toolName: "read", input: { path: "a" } }],
		env: { ARBITER_FORK_FORCE: JSON.stringify({ cls: "probe" }) },
		agentName: "orchestrator",
		sessionFile: "C:/ws/.sessions/2026-09-15T04-19-13-843Z_01a0a34a/tasks/2026-09-15T04-22-16-260Z_01a0a34d.jsonl",
	});
	assert.equal(out[0].result, null, "a worker's call passes untouched");
	assert.equal(lines.length, 0, "and nothing is reported for it");
});
