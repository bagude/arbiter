import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PI = "C:/Users/user/open_harnessess/pi/pi";
function render(agent, peer) {
	const driver = path.join(os.tmpdir(), `mail-render-${process.pid}-${agent}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/mail-ext.ts"))}).href + "?" + ${JSON.stringify(agent)});
		mod.default({ registerTool: (t) => console.log(JSON.stringify({ description: t.description, kinds: t.parameters.properties.kind.anyOf.map((k) => k.const) })) });
	`);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], { encoding: "utf8", env: { ...process.env, AGENT_NAME: agent, PEER: peer, BUS_FILE: "", NODE_PATH: `${PI}/node_modules` } });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim());
}

test("builder has no probe kind", () => {
	assert.ok(!render("builder", "critic").kinds.includes("probe"));
});
test("critic has probe", () => {
	assert.ok(render("critic", "builder").kinds.includes("probe"));
});
test("orchestrator has probe and done, addressed to the supervisor", () => {
	const t = render("orchestrator", "supervisor");
	assert.deepEqual(t.kinds.sort(), ["done", "memory", "probe", "status"]);
	assert.match(t.description, /shared workspace/);
	assert.match(t.description, /host-side/);
});
test("every role can send kind=memory, and the description says it is a candidate for future runs", () => {
	for (const [agent, peer] of [["builder", "critic"], ["critic", "builder"], ["builder", "supervisor"]]) {
		const t = render(agent, peer);
		assert.ok(t.kinds.includes("memory"), `${agent} kinds: ${t.kinds}`);
		assert.match(t.description, /kind="memory".*future runs/);
	}
});
