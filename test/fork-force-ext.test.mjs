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

function run({ calls, env = {}, agentName = "orchestrator" }) {
	const lifecycle = path.join(os.tmpdir(), `fork-force-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `fork-force-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/fork-force.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } };
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
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines };
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

test("a worker's tool_call is never forced (role gate)", () => {
	const { out, lines } = run({
		calls: [{ toolName: "read", input: { path: "a" } }],
		env: { ARBITER_FORK_FORCE: JSON.stringify({ cls: "probe" }) },
		agentName: "tester",
	});
	assert.equal(out[0].result, null);
	assert.equal(lines.length, 0);
});
