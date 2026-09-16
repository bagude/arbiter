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

// These tests construct configs with arbitrary/fake models (zai, "p"/"m", …), so they
// opt out of the model preflight added in lib/model-store.mjs; preflight itself is
// covered separately below.
const SKIP = { ARBITER_SKIP_MODEL_PREFLIGHT: "1" };

test("loads a dyad config and fills cap defaults", () => {
	const cfg = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "dyad", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" }, critic: { provider: "anthropic", model: "claude-sonnet-5" } } }), env: SKIP });
	assert.equal(cfg.pattern, "dyad");
	assert.equal(cfg.caps.wallSec, 1500);
	assert.equal(cfg.caps.doneAttempts, 5);
	assert.equal(cfg.oracle.reportFailingInputs, false);
});
test("a missing role fails with the role named", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" } } });
	assert.throws(() => loadConfig({ configPath: p, env: SKIP }), /requires role "worker"/);
});
test("env overrides win over the file", () => {
	const p = tmpConfig({ task: "glob", pattern: "solo", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" } }, caps: { wallSec: 100 } });
	const cfg = loadConfig({ configPath: p, env: { ...SKIP, ROLE_builder_MODEL: "qwen3-flash", ARBITER_CAP_WALL: "6000", ARBITER_TASK: "orbit" } });
	assert.equal(cfg.roles.builder.model, "qwen3-flash");
	assert.equal(cfg.caps.wallSec, 6000);
	assert.equal(cfg.task, "orbit");
});
test("worker role defaults: max 1, foreground", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } } });
	const cfg = loadConfig({ configPath: p, env: SKIP });
	assert.equal(cfg.roles.worker.max, 1);
	assert.equal(cfg.roles.worker.background, false);
});
test("guards: context_diet is off by default, `true` means defaults, an object passes through, junk is rejected", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: SKIP }).guards.context_diet, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: true } }), env: SKIP }).guards.context_diet, {});
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: { ageAfterTurns: 3 } } }), env: SKIP }).guards.context_diet, { ageAfterTurns: 3 });
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: false } }), env: SKIP }).guards.context_diet, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { context_diet: "yes" } }), env: SKIP }), /guards\.context_diet/);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, guards: { nope: true } }), env: SKIP }), /unknown guard "nope"/);
});
test("memory: off by default, `true` means the default budget, an object passes through, junk is rejected", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: SKIP }).memory, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: true }), env: SKIP }).memory, { budgetChars: 2000, mode: "inject" });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { budgetChars: 500 } }), env: SKIP }).memory, { budgetChars: 500, mode: "inject" });
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: false }), env: SKIP }).memory, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: "on" }), env: SKIP }), /memory/);
});
test("parseArgs reads --config", () => {
	assert.equal(parseArgs(["node", "supervisor.mjs", "--config", "configs/x.json"]).configPath, "configs/x.json");
});
test("every pattern's prompt files exist", () => {
	for (const [name, p] of Object.entries(PATTERNS)) for (const f of Object.values(p.prompt)) assert.ok(fs.existsSync(path.join("prompts", f)), `${name}: prompts/${f}`);
});

test("repo: absent means null; a name is kept; junk is rejected", () => {
	const base = { task: "dw-bronze", pattern: "dyad", roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } } };
	assert.equal(loadConfig({ configPath: tmpConfig(base), env: SKIP }).repo, null);
	assert.equal(loadConfig({ configPath: tmpConfig({ ...base, repo: "data-warehousers" }), env: SKIP }).repo, "data-warehousers");
	assert.throws(() => loadConfig({ configPath: tmpConfig({ ...base, repo: "../x" }), env: SKIP }), /repo/);
});

test("memory search mode carries retrievalChars and memoryDir; other modes are rejected", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	const c = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", budgetChars: 1500 }, memoryDir: "tasks/x/store" }), env: SKIP });
	assert.deepEqual(c.memory, { budgetChars: 1500, mode: "search", retrievalChars: 6000, workerReserveChars: 2000 });
	assert.equal(c.memoryDir, "tasks/x/store");
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: SKIP }).memoryDir, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "graph" } }), env: SKIP }), /memory\.mode/);
});

test("memory search mode carries a worker reserve, default 2000, capped below retrievalChars", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search" } }), env: SKIP }).memory.workerReserveChars, 2000);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", retrievalChars: 4000, workerReserveChars: 1000 } }), env: SKIP }).memory.workerReserveChars, 1000);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", retrievalChars: 4000, workerReserveChars: 4000 } }), env: SKIP }), /workerReserveChars/);
});

test("memory.extraScopes are read scopes, validated", () => {
	const roles = { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } };
	const c = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", extraScopes: ["repo:data-warehousers-real"] } }), env: SKIP });
	assert.deepEqual(c.memory.extraScopes, ["repo:data-warehousers-real"]);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search" } }), env: SKIP }).memory.extraScopes, undefined);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, memory: { mode: "search", extraScopes: ["nope"] } }), env: SKIP }), /extraScopes/);
});

test("roles.<role>.thinking: absent by default, validated, the worker rejects max, env overrides", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } };
	const none = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: SKIP });
	assert.equal("thinking" in none.roles.worker, false);
	assert.equal("thinking" in none.roles.orchestrator, false);
	const set = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { ...roles.orchestrator, thinking: "max" }, worker: { ...roles.worker, thinking: "low" } } }), env: SKIP });
	assert.equal(set.roles.orchestrator.thinking, "max");
	assert.equal(set.roles.worker.thinking, "low");
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, worker: { ...roles.worker, thinking: "max" } } }), env: SKIP }), /roles\.worker\.thinking must be one of off, minimal, low, medium, high, xhigh in/);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, orchestrator: { ...roles.orchestrator, thinking: "lots" } } }), env: SKIP }), /roles\.orchestrator\.thinking must be one of off, minimal, low, medium, high, xhigh, max in/);
	const env = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: { ...SKIP, ROLE_worker_THINKING: "off" } });
	assert.equal(env.roles.worker.thinking, "off");
});

test("report: off by default, `true` means the tool with no auto-probe, an object sets autoProbe, junk is rejected", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } };
	const base = { task: "orbit", pattern: "orchestrator", roles };
	assert.equal(loadConfig({ configPath: tmpConfig(base), env: SKIP }).report, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, report: true }), env: SKIP }).report, { autoProbe: false });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, report: { autoProbe: true } }), env: SKIP }).report, { autoProbe: true });
	assert.equal(loadConfig({ configPath: tmpConfig({ ...base, report: false }), env: SKIP }).report, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ ...base, report: "yes" }), env: SKIP }), /report must be true, false or \{ autoProbe \}/);
});

test("caps.tokens: off by default, set from the file, env ARBITER_CAP_TOKENS overrides", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: SKIP }).caps.tokens, 0);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, caps: { tokens: 250000 } }), env: SKIP }).caps.tokens, 250000);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, caps: { tokens: 250000 } }), env: { ...SKIP, ARBITER_CAP_TOKENS: "1000" } }).caps.tokens, 1000);
});

function tmpStore(obj) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
	const p = path.join(dir, "models-store.json");
	fs.writeFileSync(p, JSON.stringify(obj));
	return { storePath: p, overridesPath: path.join(dir, "no-overrides.json") };
}

test("model preflight: an unknown model throws naming the role, the id, and the provider's sorted ids", () => {
	const { storePath, overridesPath } = tmpStore({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }, { id: "qwen3-flash" }, { id: "qwen3-uncensored" }] } });
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27x" } };
	const p = tmpConfig({ task: "glob", pattern: "solo", roles });
	assert.throws(
		() => loadConfig({ configPath: p, env: { ARBITER_MODEL_STORE: storePath, ARBITER_MODEL_OVERRIDES: overridesPath } }),
		/model preflight: roles\.builder names "llama\.cpp\/qwen3-27x" but pi has no such model; available for llama\.cpp: qwen3-27b, qwen3-flash, qwen3-uncensored \(from .*models-store\.json\)/,
	);
});

test("model preflight: known ids pass, roles get contextWindow, preflight.checked counts roles", () => {
	const { storePath, overridesPath } = tmpStore({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }] }, anthropic: { models: [{ id: "claude-sonnet-5", contextWindow: 1000000 }] } });
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" }, critic: { provider: "anthropic", model: "claude-sonnet-5" } };
	const p = tmpConfig({ task: "glob", pattern: "dyad", roles });
	const cfg = loadConfig({ configPath: p, env: { ARBITER_MODEL_STORE: storePath, ARBITER_MODEL_OVERRIDES: overridesPath } });
	assert.equal(cfg.roles.builder.contextWindow, 131072);
	assert.equal(cfg.roles.critic.contextWindow, 1000000);
	assert.deepEqual(cfg.preflight, { checked: 2, source: [storePath.replace(/\\/g, "/")] });
});

test("model preflight: no store files found skips the check and nulls contextWindow", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
	const storePath = path.join(dir, "nope-store.json");
	const overridesPath = path.join(dir, "nope-overrides.json");
	const roles = { builder: { provider: "anything", model: "whatever" } };
	const p = tmpConfig({ task: "glob", pattern: "solo", roles });
	const cfg = loadConfig({ configPath: p, env: { ARBITER_MODEL_STORE: storePath, ARBITER_MODEL_OVERRIDES: overridesPath } });
	assert.equal(cfg.roles.builder.contextWindow, null);
	assert.deepEqual(cfg.preflight, { skipped: "no model store found", looked: [storePath.replace(/\\/g, "/"), overridesPath.replace(/\\/g, "/")] });
});

test("model preflight: ARBITER_SKIP_MODEL_PREFLIGHT=1 skips even when the store has the model", () => {
	const { storePath, overridesPath } = tmpStore({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }] } });
	const roles = { builder: { provider: "llama.cpp", model: "does-not-exist" } };
	const p = tmpConfig({ task: "glob", pattern: "solo", roles });
	const cfg = loadConfig({ configPath: p, env: { ARBITER_MODEL_STORE: storePath, ARBITER_MODEL_OVERRIDES: overridesPath, ARBITER_SKIP_MODEL_PREFLIGHT: "1" } });
	assert.equal(cfg.roles.builder.contextWindow, null);
	assert.deepEqual(cfg.preflight, { skipped: "ARBITER_SKIP_MODEL_PREFLIGHT", looked: [storePath.replace(/\\/g, "/"), overridesPath.replace(/\\/g, "/")] });
});
