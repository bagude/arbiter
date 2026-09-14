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
test("memory: off by default, `true` means the default budget, an object passes through, junk is rejected", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: {} }).memory, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: true }), env: {} }).memory, { budgetChars: 2000, mode: "inject" });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { budgetChars: 500 } }), env: {} }).memory, { budgetChars: 500, mode: "inject" });
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: false }), env: {} }).memory, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: "on" }), env: {} }), /memory/);
});
test("parseArgs reads --config", () => {
	assert.equal(parseArgs(["node", "supervisor.mjs", "--config", "configs/x.json"]).configPath, "configs/x.json");
});
test("every pattern's prompt files exist", () => {
	for (const [name, p] of Object.entries(PATTERNS)) for (const f of Object.values(p.prompt)) assert.ok(fs.existsSync(path.join("prompts", f)), `${name}: prompts/${f}`);
});

test("repo: absent means null; a name is kept; junk is rejected", () => {
	const base = { task: "dw-bronze", pattern: "dyad", roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } } };
	assert.equal(loadConfig({ configPath: tmpConfig(base), env: {} }).repo, null);
	assert.equal(loadConfig({ configPath: tmpConfig({ ...base, repo: "data-warehousers" }), env: {} }).repo, "data-warehousers");
	assert.throws(() => loadConfig({ configPath: tmpConfig({ ...base, repo: "../x" }), env: {} }), /repo/);
});

test("memory search mode carries retrievalChars and memoryDir; other modes are rejected", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	const c = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", budgetChars: 1500 }, memoryDir: "tasks/x/store" }), env: {} });
	assert.deepEqual(c.memory, { budgetChars: 1500, mode: "search", retrievalChars: 6000, workerReserveChars: 2000 });
	assert.equal(c.memoryDir, "tasks/x/store");
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: {} }).memoryDir, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "graph" } }), env: {} }), /memory\.mode/);
});

test("memory search mode carries a worker reserve, default 2000, capped below retrievalChars", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search" } }), env: {} }).memory.workerReserveChars, 2000);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", retrievalChars: 4000, workerReserveChars: 1000 } }), env: {} }).memory.workerReserveChars, 1000);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", retrievalChars: 4000, workerReserveChars: 4000 } }), env: {} }), /workerReserveChars/);
});

test("memory.extraScopes are read scopes, validated", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	const c = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", extraScopes: ["repo:data-warehousers-real"] } }), env: {} });
	assert.deepEqual(c.memory.extraScopes, ["repo:data-warehousers-real"]);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search" } }), env: {} }).memory.extraScopes, undefined);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", extraScopes: ["nope"] } }), env: {} }), /extraScopes/);
});

test("roles.<role>.thinking: absent by default, validated, the worker rejects max, env overrides", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } };
	const none = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: {} });
	assert.equal("thinking" in none.roles.worker, false);
	assert.equal("thinking" in none.roles.orchestrator, false);
	const set = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { ...roles.orchestrator, thinking: "max" }, worker: { ...roles.worker, thinking: "low" } } }), env: {} });
	assert.equal(set.roles.orchestrator.thinking, "max");
	assert.equal(set.roles.worker.thinking, "low");
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, worker: { ...roles.worker, thinking: "max" } } }), env: {} }), /roles\.worker\.thinking must be one of off, minimal, low, medium, high, xhigh in/);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, orchestrator: { ...roles.orchestrator, thinking: "lots" } } }), env: {} }), /roles\.orchestrator\.thinking must be one of off, minimal, low, medium, high, xhigh, max in/);
	const env = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: { ROLE_worker_THINKING: "off" } });
	assert.equal(env.roles.worker.thinking, "off");
});
