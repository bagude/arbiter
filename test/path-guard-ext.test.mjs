import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/path-guard.ts through tsx with a fake `pi` that records the tool_call
// handler, then feeds it events and prints the results — the same shape as
// test/mail-ext-render.test.mjs. The extension is host-side pi code; nothing here
// starts a model.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run(events, { root, role = "builder", env = {} }) {
	const lifecycle = path.join(os.tmpdir(), `path-guard-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `path-guard-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/path-guard.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const out = [];
		for (const { sessionFile, ...ev } of ${JSON.stringify(events)}) {
			const ctx = { cwd: ${JSON.stringify(root)}, sessionManager: { getSessionFile: () => sessionFile } };
			out.push(await handlers.tool_call({ type: "tool_call", toolCallId: "t1", ...ev }, ctx));
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: role, ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines };
}

const ROOT = path.resolve("C:/work/runs/.ws-run/ws-builder");

test("registers a tool_call handler and lets an inside read through", () => {
	const { registered, out, lines } = run([{ toolName: "read", input: { path: "src/glob.mjs" } }], { root: ROOT });
	assert.deepEqual(registered, ["tool_call"]);
	assert.equal(out[0], null); // the handler returns undefined; JSON carries it as null
	assert.deepEqual(lines, []);
});

test("blocks an outside read with a redirect reason and records the deny", () => {
	const { out, lines } = run([{ toolName: "read", input: { path: "../../tasks/glob/oracle/glob.test.mjs" } }], { root: ROOT, role: "orchestrator" });
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /workspace/);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "guard:path_denied");
	assert.deepEqual(lines[0].data, { role: "orchestrator", tool: "read", fragment: "../../tasks/glob/oracle/glob.test.mjs" });
	assert.equal(typeof lines[0].ts, "number");
});

test("a worker (child session under tasks/) is named worker:<id> in the deny record", () => {
	const { lines } = run([{ toolName: "read", input: { path: "../x" }, sessionFile: "C:/work/runs/.sessions-r/orchestrator/2026_abc/tasks/2026_def.jsonl" }], {
		root: ROOT,
		role: "orchestrator",
	});
	assert.equal(lines[0].data.role, "worker:2026_def");
});

test("R8: a file-tool path that is a link pointing outside the workspace is denied by the adapter", () => {
	// A real directory junction (no admin needed on Windows) from inside the workspace
	// to a directory outside it; the pure policy cannot see it, the adapter must.
	const outer = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-link-"));
	const root = path.join(outer, "ws");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(outer, "secret"));
	fs.writeFileSync(path.join(outer, "secret", "flag.txt"), "x");
	fs.symlinkSync(path.join(outer, "secret"), path.join(root, "src", "link-out"), "junction");
	const { out } = run([{ toolName: "read", input: { path: "src/link-out/flag.txt" } }, { toolName: "read", input: { path: "src/link-out" } }], { root });
	assert.equal(out[0]?.block, true, "file through the link");
	assert.equal(out[1]?.block, true, "the link itself");
});

test("a declared read-only mount (ARBITER_MOUNTS) lets reads through the junction and refuses writes", () => {
	const outer = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-mount-"));
	const root = path.join(outer, "ws");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	const snapshot = path.join(outer, "snapshot");
	fs.mkdirSync(snapshot);
	fs.writeFileSync(path.join(snapshot, "warehouse.duckdb"), "x");
	fs.mkdirSync(path.join(root, "data"));
	fs.symlinkSync(snapshot, path.join(root, "data", "real"), "junction");
	const env = { ARBITER_MOUNTS: JSON.stringify([{ path: path.join(root, "data", "real"), target: fs.realpathSync.native(snapshot) }]) };
	const { out, lines } = run(
		[
			{ toolName: "read", input: { path: "data/real/warehouse.duckdb" } },
			{ toolName: "ls", input: { path: "data/real" } },
			{ toolName: "write", input: { path: "data/real/notes.txt", content: "no" } },
			{ toolName: "read", input: { path: "src/link-out/flag.txt" } },
		],
		{ root, env },
	);
	assert.equal(out[0], null, "read through the mount");
	assert.equal(out[1], null, "ls of the mount");
	assert.equal(out[2]?.block, true, "write into the mount");
	assert.match(out[2].reason, /read-only mount/);
	assert.equal(lines.length, 1);
});

test("blocks a bash command that leaves the workspace", () => {
	const { out } = run([{ toolName: "bash", input: { command: "cd C:/Users/me/AppData/Local/Temp && node chk.mjs" } }], { root: ROOT });
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /AppData/);
});
