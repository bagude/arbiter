import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/context-usage-ext.ts through tsx with a fake `pi`: a `context` event
// caches the message list's size, then the registered `context_usage` tool is
// executed and its text result captured. Copies the harness pattern from
// test/pre-spawn-compact-ext.test.mjs, adding a registerTool collector (that fake
// `pi` only has `on`/`events`).
import { PI_ROOT } from "../lib/pi-root.mjs";
const PI = PI_ROOT;

function run({ contextMessages, env = {} }) {
	const driver = path.join(os.tmpdir(), `context-usage-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/context-usage-ext.ts"))}).href);
		const handlers = {};
		const tools = {};
		mod.default({
			on: (ev, fn) => { handlers[ev] = fn; },
			events: { on() {} },
			registerTool: (def) => { tools[def.name] = def; },
		});
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } };
		if (handlers.context) await handlers.context({ type: "context", messages: ${JSON.stringify(contextMessages ?? [])} }, ctx);
		const tool = tools.context_usage;
		const result = tool ? await tool.execute("call1", {}, undefined, undefined, ctx) : null;
		console.log(JSON.stringify({ registeredEvents: Object.keys(handlers), registeredTools: Object.keys(tools), result }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", NODE_PATH: `${PI}/node_modules`, ARBITER_CONTEXT_WINDOW: "", ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim());
}

test("registers a context_usage tool and the context event unconditionally (no env opt-in)", () => {
	const { registeredEvents, registeredTools } = run({ contextMessages: [] });
	assert.deepEqual(registeredEvents, ["context"]);
	assert.deepEqual(registeredTools, ["context_usage"]);
});

test("returns the policy text for a known message list and context window", () => {
	const known = JSON.stringify([{ role: "user", content: "x".repeat(100) }]);
	const { result } = run({ contextMessages: [{ role: "user", content: "x".repeat(100) }], env: { ARBITER_CONTEXT_WINDOW: "131072" } });
	const expectedChars = known.length;
	const expectedTokens = Math.round(expectedChars / 3.3);
	const expectedPercent = ((expectedTokens / 131072) * 100).toFixed(1);
	assert.equal(
		result.content[0].text,
		`Context: ~${expectedChars.toLocaleString("en-US")} chars (~${expectedTokens.toLocaleString("en-US")} tokens est.) of 131,072 (${expectedPercent}% used).`,
	);
	assert.equal(result.isError, false);
});

test("no ARBITER_CONTEXT_WINDOW: text says the window is unknown", () => {
	const { result } = run({ contextMessages: [{ role: "user", content: "hi" }], env: { ARBITER_CONTEXT_WINDOW: "" } });
	assert.ok(result.content[0].text.endsWith("context window unknown."));
});

test("estimate is computed at call time, not per context event: a call before any context event reports on the empty message list", () => {
	// Same driver as run(), but skips firing the context handler entirely — the tool's
	// execute() must still work, off whatever the (never-updated) stored message list is.
	const driver = path.join(os.tmpdir(), `context-usage-driver-nocontext-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/context-usage-ext.ts"))}).href);
		const tools = {};
		mod.default({
			on: () => {},
			events: { on() {} },
			registerTool: (def) => { tools[def.name] = def; },
		});
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } };
		const result = await tools.context_usage.execute("call1", {}, undefined, undefined, ctx);
		console.log(JSON.stringify({ result }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", NODE_PATH: `${PI}/node_modules`, ARBITER_CONTEXT_WINDOW: "" },
	});
	assert.equal(r.status, 0, r.stderr);
	const { result } = JSON.parse(r.stdout.trim());
	// The stored message list defaults to [] (no context event has fired), and
	// estimateContextChars serializes it with JSON.stringify — "[]" is 2 chars, not 0.
	assert.equal(result.content[0].text, "Context: ~2 chars (~1 tokens est.); context window unknown.");
});
