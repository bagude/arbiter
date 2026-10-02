import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/replay-capture.ts through tsx with a fake pi: fires before_provider_request
// as the orchestrator and as a worker, then reads what landed in ARBITER_REQUESTS_DIR.
import { PI_ROOT } from "../lib/pi-root.mjs";
const PI = PI_ROOT;

function run({ env = {}, calls, ws = "C:/ws-none" }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-capture-"));
	const driver = path.join(os.tmpdir(), `replay-capture-driver-${process.pid}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/replay-capture.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const orch = { cwd: ${JSON.stringify(ws)}, sessionManager: { getSessionFile: () => "C:/ws/sessions/orchestrator/x.jsonl" } };
		const worker = { cwd: "C:/ws", sessionManager: { getSessionFile: () => "C:/ws/sessions/orchestrator/x/tasks/w.jsonl" } };
		for (const c of ${JSON.stringify(calls)}) if (handlers.before_provider_request) await handlers.before_provider_request({ type: "before_provider_request", payload: c.payload }, c.role === "worker" ? worker : orch);
		console.log(JSON.stringify({ registered: Object.keys(handlers) }));
	`);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], { encoding: "utf8", env: { ...process.env, AGENT_NAME: "orchestrator", NODE_PATH: `${PI}/node_modules`, ARBITER_REQUESTS_DIR: "", ...env } });
	assert.equal(r.status, 0, r.stderr);
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
	return { ...JSON.parse(r.stdout.trim()), dir, files, read: (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) };
}

test("registers nothing when ARBITER_REQUESTS_DIR is unset", () => {
	const { registered, files } = run({ calls: [{ role: "orchestrator", payload: { a: 1 } }] });
	assert.deepEqual(registered, []);
	assert.deepEqual(files, []);
});

test("writes each orchestrator request verbatim with a 1-based sequence and a src/ snapshot; worker requests are skipped", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-capture-out-"));
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "replay-capture-ws-"));
	fs.mkdirSync(path.join(ws, "src", "__tests__"), { recursive: true });
	fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(ws, ".pi", "agents", "worker.md"), "harness-installed, never snapshotted");
	fs.writeFileSync(path.join(ws, "README.md"), "# ws");
	fs.writeFileSync(path.join(ws, "scratch.txt"), "notes");
	fs.writeFileSync(path.join(ws, "src", "a.mjs"), "export const a = 1;\n");
	fs.writeFileSync(path.join(ws, "src", "__tests__", "a.test.mjs"), "// t\n");
	const payload1 = { model: "qwen3-27b", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read" } }], stream: true };
	const payload2 = { ...payload1, messages: [...payload1.messages, { role: "assistant", content: "ok" }] };
	const { registered, files, read } = run({
		env: { ARBITER_REQUESTS_DIR: dir },
		calls: [{ role: "orchestrator", payload: payload1 }, { role: "worker", payload: { skipped: true } }, { role: "orchestrator", payload: payload2 }],
		ws,
	});
	assert.deepEqual(registered, ["before_provider_request"]);
	const out = fs.readdirSync(dir).sort();
	assert.deepEqual(out, ["0001-ws", "0001.json", "0002-ws", "0002.json"]);
	const first = JSON.parse(fs.readFileSync(path.join(dir, "0001.json"), "utf8"));
	assert.equal(first.seq, 1);
	assert.deepEqual(first.payload, payload1);
	assert.equal(first.snapshot, "0001-ws");
	assert.equal(fs.readFileSync(path.join(dir, "0001-ws", "src", "a.mjs"), "utf8"), "export const a = 1;\n");
	assert.ok(fs.existsSync(path.join(dir, "0002-ws", "src", "__tests__", "a.test.mjs")), "nested files are copied");
	assert.ok(fs.existsSync(path.join(dir, "0001-ws", "README.md")) && fs.existsSync(path.join(dir, "0001-ws", "scratch.txt")), "the whole observable workspace, not only src/");
	assert.ok(!fs.existsSync(path.join(dir, "0001-ws", ".pi")), ".pi/ is harness-installed and guarded: not part of the snapshot");
	assert.match(first.hash, /^[0-9a-f]{40}$/);
	const second = JSON.parse(fs.readFileSync(path.join(dir, "0002.json"), "utf8"));
	assert.equal(second.hash, first.hash, "nothing changed between the two requests, so the tree hashes are equal");
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "0002.json"), "utf8")).payload.messages.length, 3);
	assert.deepEqual(files, [], "nothing lands in the unused default dir");
});
