import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/bash-timeout.ts through tsx with a fake `pi`, the same way
// test/path-guard-ext.test.mjs drives the path guard. The handler must mutate the
// event's input in place (pi reads the mutated object) and report the rewrite.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run(events, env = {}) {
	const lifecycle = path.join(os.tmpdir(), `bash-timeout-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `bash-timeout-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/bash-timeout.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const out = [];
		for (const ev of ${JSON.stringify(events)}) {
			const event = { type: "tool_call", toolCallId: "t1", ...ev };
			const result = await handlers.tool_call(event, { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } });
			out.push({ result: result ?? null, input: event.input });
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "builder", ARBITER_LIFECYCLE_FILE: lifecycle, ARBITER_BASH_TIMEOUT_SEC: "90", NODE_PATH: `${PI}/node_modules`, ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines };
}

test("a bash call without a timeout gets the default injected in place and is reported", () => {
	const { registered, out, lines } = run([{ toolName: "bash", input: { command: "node x.mjs" } }]);
	assert.deepEqual(registered, ["tool_call"]);
	assert.equal(out[0].result, null); // never blocks
	assert.equal(out[0].input.timeout, 90);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "guard:bash_timeout_rewritten");
	assert.deepEqual(lines[0].data, { role: "builder", from: null, to: 90 });
});

test("a bash call with a sane timeout is left alone and not reported", () => {
	const { out, lines } = run([{ toolName: "bash", input: { command: "node x.mjs", timeout: 30 } }]);
	assert.equal(out[0].input.timeout, 30);
	assert.deepEqual(lines, []);
});

test("non-bash tools are ignored", () => {
	const { out, lines } = run([{ toolName: "read", input: { path: "src/x.mjs" } }]);
	assert.deepEqual(out[0].input, { path: "src/x.mjs" });
	assert.deepEqual(lines, []);
});

test("the default comes from ARBITER_BASH_TIMEOUT_SEC", () => {
	const { out } = run([{ toolName: "bash", input: { command: "x" } }], { ARBITER_BASH_TIMEOUT_SEC: "45" });
	assert.equal(out[0].input.timeout, 45);
});
