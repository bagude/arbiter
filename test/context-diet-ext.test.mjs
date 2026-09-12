import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/context-diet.ts through tsx with a fake `pi`. The guard is
// opt-in: it registers on the `context` event only when ARBITER_CONTEXT_DIET is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run(messages, env = {}) {
	const lifecycle = path.join(os.tmpdir(), `context-diet-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `context-diet-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/context-diet.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } };
		const result = handlers.context ? await handlers.context({ type: "context", messages: ${JSON.stringify(messages)} }, ctx) : "not-registered";
		console.log(JSON.stringify({ registered: Object.keys(handlers), result: result ?? null }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "builder", ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ARBITER_CONTEXT_DIET: "", ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines };
}

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: {}, stopReason: "stop" });
const MSGS = [
	user("go"),
	assistant([{ type: "thinking", thinking: "old" }, { type: "toolCall", id: "c1", name: "read", arguments: {} }]),
	{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "y".repeat(300) }], isError: false },
	assistant([{ type: "text", text: "2" }]),
	assistant([{ type: "text", text: "3" }]),
	user("next"),
	assistant([{ type: "thinking", thinking: "now" }, { type: "text", text: "hi" }]),
];

test("not registered when ARBITER_CONTEXT_DIET is unset", () => {
	const { registered, result } = run(MSGS);
	assert.deepEqual(registered, []);
	assert.equal(result, "not-registered");
});

test("with options from the env it rewrites the list and reports the stats", () => {
	const { registered, result, lines } = run(MSGS, { ARBITER_CONTEXT_DIET: JSON.stringify({ ageAfterTurns: 2, ageMinChars: 100 }) });
	assert.deepEqual(registered, ["context"]);
	assert.equal(result.messages.length, MSGS.length);
	assert.deepEqual(result.messages[1].content, [{ type: "toolCall", id: "c1", name: "read", arguments: {} }]);
	assert.match(result.messages[2].content[0].text, /elided by the supervisor: 300 chars/);
	assert.deepEqual(result.messages[6].content, MSGS[6].content);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "guard:context_diet_rewritten");
	assert.deepEqual(lines[0].data, { role: "builder", thinkingDropped: 1, resultsAged: 1, charsSaved: 300 - result.messages[2].content[0].text.length });
});

test("ARBITER_CONTEXT_DIET=1 means the defaults; a list with nothing to change is returned untouched and unreported", () => {
	const msgs = [user("go"), assistant([{ type: "text", text: "a" }])];
	const { registered, result, lines } = run(msgs, { ARBITER_CONTEXT_DIET: "1" });
	assert.deepEqual(registered, ["context"]);
	assert.equal(result, null);
	assert.deepEqual(lines, []);
});
