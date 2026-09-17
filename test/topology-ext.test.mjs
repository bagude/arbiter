import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/topology.ts through tsx with a fake `pi`, a temp workspace as
// ctx.cwd, and a scripted sequence of tool_call events. Opt-in: registers nothing
// unless ARBITER_TOPOLOGY is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";
const NEEDS = { tester: ["api"], implementer: ["api", "tests"] };

function run({ calls, env = {}, workspace }) {
	const ws = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "topology-ws-"));
	const lifecycle = path.join(os.tmpdir(), `topology-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `topology-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import fs from "node:fs";
		import path from "node:path";
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/topology.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const ctx = { cwd: ${JSON.stringify(ws)}, sessionManager: { getSessionFile: () => undefined } };
		const out = [];
		for (const step of ${JSON.stringify(calls)}) {
			if (step.writeTests) { fs.mkdirSync(path.join(ctx.cwd, "src", "__tests__"), { recursive: true }); fs.writeFileSync(path.join(ctx.cwd, "src", "__tests__", step.writeTests), "// t\\n"); await new Promise(r => setTimeout(r, 20)); out.push("wrote"); continue; }
			out.push(handlers.tool_call ? await handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName: step.tool, input: step.input }, ctx) : "not-registered");
			await new Promise(r => setTimeout(r, 20));
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ARBITER_TOPOLOGY: "", ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines, ws };
}

const SPAWN = (subagent_type, prompt = "Do it.") => ({ tool: "subagent", input: { subagent_type, description: "d", prompt } });
const ENV = { ARBITER_TOPOLOGY: JSON.stringify({ mode: "nudge", needs: NEEDS }) };

test("not registered when ARBITER_TOPOLOGY is unset", () => {
	const { registered, out } = run({ calls: [SPAWN("implementer")] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, ["not-registered"]);
});

test("nudge: implementer spawn with no tests is denied once with the tester-first reason, then waived; both reported", () => {
	const { out, lines } = run({ calls: [SPAWN("implementer"), SPAWN("implementer")], env: ENV });
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /^topology: implementer needs tests, and src\/__tests__\/ has none/);
	assert.equal(out[1], null, "second attempt passes (guard returns undefined; JSON carries it as null)");
	assert.deepEqual(lines.map((l) => l.ev), ["guard:topology_denied", "guard:topology_waived"]);
	assert.equal(lines[0].data.role, "orchestrator");
	assert.equal(lines[0].data.specialist, "implementer");
	assert.equal(lines[0].data.failed, "tests:missing");
});

test("tester spawn is never judged; tests written then read lets the implementer through silently", () => {
	const { out, lines } = run({
		calls: [SPAWN("tester"), { writeTests: "pathnorm.test.mjs" }, { tool: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, SPAWN("implementer")],
		env: ENV,
	});
	assert.deepEqual(out, [null, "wrote", null, null]);
	assert.deepEqual(lines, []);
});

test("tests written but not read: denied with the read reason", () => {
	const { out, lines } = run({ calls: [{ writeTests: "x.test.mjs" }, SPAWN("implementer")], env: { ARBITER_TOPOLOGY: JSON.stringify({ mode: "enforce", needs: NEEDS }) } });
	assert.equal(out[1].block, true);
	assert.match(out[1].reason, /you have not read them since they were written/);
	assert.equal(lines[0].data.failed, "tests:unread");
});

test("skip line passes and is reported with the reason", () => {
	const { out, lines } = run({ calls: [SPAWN("implementer", "topology: skip — nothing to test\nImplement.")], env: { ARBITER_TOPOLOGY: JSON.stringify({ mode: "enforce", needs: NEEDS }) } });
	assert.equal(out[0], null);
	assert.equal(lines[0].ev, "guard:topology_skipped");
	assert.equal(lines[0].data.reason, "nothing to test");
});

test("src/__tests__ existing as a file, not a directory, denies as tests:missing instead of crashing", () => {
	// A worker could be mid-edit (replacing the directory) when the orchestrator spawns;
	// testsFiles() must never let an fs error escape the tool_call handler.
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topology-ws-"));
	fs.mkdirSync(path.join(ws, "src"), { recursive: true });
	fs.writeFileSync(path.join(ws, "src", "__tests__"), "not a directory");
	const { out } = run({ calls: [SPAWN("implementer")], env: ENV, workspace: ws });
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /has none/);
});
