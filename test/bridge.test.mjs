import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PI = "C:/Users/user/open_harnessess/pi/pi";
const TSX = `${PI}/node_modules/tsx/dist/cli.mjs`;

test("bridge subscribes to every lifecycle event and appends JSON lines", () => {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-bridge-")), "lifecycle.jsonl");
	const driver = path.join(os.tmpdir(), `bridge-driver-${process.pid}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const handlers = new Map();
		const pi = { events: { on: (name, fn) => handlers.set(name, fn) } };
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/subagents-bridge.ts"))}).href);
		mod.default(pi);
		console.log(JSON.stringify([...handlers.keys()]));
		handlers.get("subagents:created")({ id: "abc", agent: "worker" });
		handlers.get("subagents:completed")({ id: "abc", result: "x".repeat(5000) });
	`);
	const r = spawnSync(process.execPath, [TSX, driver], { encoding: "utf8", env: { ...process.env, ARBITER_LIFECYCLE_FILE: out, NODE_PATH: `${PI}/node_modules` } });
	assert.equal(r.status, 0, r.stderr);
	const names = JSON.parse(r.stdout.trim().split("\n")[0]);
	for (const ev of ["subagents:created", "subagents:started", "subagents:update", "subagents:completed", "subagents:failed", "subagents:resuming", "subagents:resumed", "subagents:steered", "subagents:compacted"]) assert.ok(names.includes(ev), ev);
	const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines.length, 2);
	assert.equal(lines[0].ev, "subagents:created");
	assert.equal(lines[0].data.id, "abc");
	assert.ok(lines[1].data.result.length <= 1600, "results are capped before they are written");
});
