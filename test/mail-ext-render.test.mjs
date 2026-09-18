import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PI = "C:/Users/user/open_harnessess/pi/pi";
// ARBITER_MANAGE is passed explicitly (default "") rather than inherited: the env spread below
// would otherwise let an ambient value decide whether kind="escalate" exists, and the
// orchestrator's kind list is pinned exactly.
function render(agent, peer, extraEnv = {}) {
	const driver = path.join(os.tmpdir(), `mail-render-${process.pid}-${agent}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/mail-ext.ts"))}).href + "?" + ${JSON.stringify(agent)});
		mod.default({ registerTool: (t) => console.log(JSON.stringify({ description: t.description, kinds: t.parameters.properties.kind.anyOf.map((k) => k.const) })) });
	`);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], { encoding: "utf8", env: { ...process.env, AGENT_NAME: agent, PEER: peer, BUS_FILE: "", ARBITER_MANAGE: "", NODE_PATH: `${PI}/node_modules`, ...extraEnv } });
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
	assert.ok(!t.kinds.includes("escalate"), "escalate exists only in a run with a manager");
	assert.ok(!/escalate/.test(t.description), "and the stable prefix of a manage-free run must not mention it");
});
test("with management on, the orchestrator also has kind=escalate and is told what it is for", () => {
	const t = render("orchestrator", "supervisor", { ARBITER_MANAGE: "1" });
	assert.deepEqual(t.kinds.sort(), ["done", "escalate", "memory", "probe", "status"]);
	assert.match(t.description, /kind="escalate" asks the manager for a decision you cannot make/);
	// The kind belongs to the orchestrator alone: no other role has a manager above it.
	assert.ok(!render("critic", "builder", { ARBITER_MANAGE: "1" }).kinds.includes("escalate"));
});
test("every role can send kind=memory, and the description says it is a candidate for future runs", () => {
	for (const [agent, peer] of [["builder", "critic"], ["critic", "builder"], ["builder", "supervisor"]]) {
		const t = render(agent, peer);
		assert.ok(t.kinds.includes("memory"), `${agent} kinds: ${t.kinds}`);
		assert.match(t.description, /kind="memory".*future runs/);
	}
});
