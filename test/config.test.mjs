import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseArgs } from "../lib/config.mjs";
import { PATTERNS } from "../lib/patterns.mjs";

function tmpConfig(obj) {
	const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-cfg-")), "arbiter.json");
	fs.writeFileSync(p, JSON.stringify(obj));
	return p;
}

test("loads a dyad config and fills cap defaults", () => {
	const cfg = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "dyad", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" }, critic: { provider: "anthropic", model: "claude-sonnet-5" } } }), env: {} });
	assert.equal(cfg.pattern, "dyad");
	assert.equal(cfg.caps.wallSec, 1500);
	assert.equal(cfg.caps.doneAttempts, 5);
	assert.equal(cfg.oracle.reportFailingInputs, false);
});
test("a missing role fails with the role named", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" } } });
	assert.throws(() => loadConfig({ configPath: p, env: {} }), /requires role "worker"/);
});
test("env overrides win over the file", () => {
	const p = tmpConfig({ task: "glob", pattern: "solo", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" } }, caps: { wallSec: 100 } });
	const cfg = loadConfig({ configPath: p, env: { ROLE_builder_MODEL: "qwen3-flash", ARBITER_CAP_WALL: "6000", ARBITER_TASK: "orbit" } });
	assert.equal(cfg.roles.builder.model, "qwen3-flash");
	assert.equal(cfg.caps.wallSec, 6000);
	assert.equal(cfg.task, "orbit");
});
test("worker role defaults: max 1, foreground", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } } });
	const cfg = loadConfig({ configPath: p, env: {} });
	assert.equal(cfg.roles.worker.max, 1);
	assert.equal(cfg.roles.worker.background, false);
});
test("guards: context_diet is off by default, `true` means defaults, an object passes through, junk is rejected", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: {} }).guards.context_diet, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: true } }), env: {} }).guards.context_diet, {});
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: { ageAfterTurns: 3 } } }), env: {} }).guards.context_diet, { ageAfterTurns: 3 });
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: false } }), env: {} }).guards.context_diet, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: "yes" } }), env: {} }), /guards\.context_diet/);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { nope: true } }), env: {} }), /unknown guard "nope"/);
});
test("parseArgs reads --config", () => {
	assert.equal(parseArgs(["node", "supervisor.mjs", "--config", "configs/x.json"]).configPath, "configs/x.json");
});
test("every pattern's prompt files exist", () => {
	for (const [name, p] of Object.entries(PATTERNS)) for (const f of Object.values(p.prompt)) assert.ok(fs.existsSync(path.join("prompts", f)), `${name}: prompts/${f}`);
});
