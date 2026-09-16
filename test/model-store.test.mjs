import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultModelStorePaths, loadModelStore, preflightRoles } from "../lib/model-store.mjs";

function tmpFile(obj) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
	const p = path.join(dir, "store.json");
	fs.writeFileSync(p, JSON.stringify(obj));
	return p;
}

test("defaultModelStorePaths: env vars win, else <home>/.pi/agent/*", () => {
	const withEnv = defaultModelStorePaths({ ARBITER_MODEL_STORE: "/tmp/s.json", ARBITER_MODEL_OVERRIDES: "/tmp/o.json" });
	assert.equal(withEnv.store, "/tmp/s.json");
	assert.equal(withEnv.overrides, "/tmp/o.json");
	const fallback = defaultModelStorePaths({});
	assert.equal(fallback.store, path.join(os.homedir(), ".pi", "agent", "models-store.json"));
	assert.equal(fallback.overrides, path.join(os.homedir(), ".pi", "agent", "models.json"));
});

test("loadModelStore: available map built from store only when no overrides file exists", () => {
	const storePath = tmpFile({
		"llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }, { id: "qwen3-flash" }] },
	});
	const overridesPath = path.join(path.dirname(storePath), "does-not-exist.json");
	const store = loadModelStore({ storePath, overridesPath });
	assert.deepEqual(store.available.get("llama.cpp/qwen3-27b"), { provider: "llama.cpp", id: "qwen3-27b", contextWindow: 131072 });
	assert.deepEqual(store.available.get("llama.cpp/qwen3-flash"), { provider: "llama.cpp", id: "qwen3-flash", contextWindow: null });
	assert.deepEqual(store.source, [storePath.replace(/\\/g, "/")]);
});

test("loadModelStore: overrides contribute additional ids via modelOverrides keys and a models list", () => {
	const storePath = tmpFile({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }] } });
	const overridesPath = tmpFile({
		providers: {
			"llama.cpp": { modelOverrides: { "qwen3-27b": { reasoning: true }, "qwen3-uncensored": {} } },
			zai: { models: [{ id: "glm-5.3-flash", contextWindow: 200000 }] },
		},
	});
	const store = loadModelStore({ storePath, overridesPath });
	// store's contextWindow wins for an id present in both
	assert.deepEqual(store.available.get("llama.cpp/qwen3-27b"), { provider: "llama.cpp", id: "qwen3-27b", contextWindow: 131072 });
	// override-only id via modelOverrides key, no contextWindow -> null
	assert.deepEqual(store.available.get("llama.cpp/qwen3-uncensored"), { provider: "llama.cpp", id: "qwen3-uncensored", contextWindow: null });
	// override-only id via models list, with contextWindow
	assert.deepEqual(store.available.get("zai/glm-5.3-flash"), { provider: "zai", id: "glm-5.3-flash", contextWindow: 200000 });
	assert.equal(store.source.length, 2);
});

test("loadModelStore: missing files are skipped, not errors", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
	const store = loadModelStore({ storePath: path.join(dir, "nope-store.json"), overridesPath: path.join(dir, "nope-overrides.json") });
	assert.deepEqual(store.source, []);
	assert.equal(store.available.size, 0);
});

test("loadModelStore: malformed JSON throws naming the path", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-store-"));
	const storePath = path.join(dir, "store.json");
	fs.writeFileSync(storePath, "{ not json");
	assert.throws(() => loadModelStore({ storePath, overridesPath: path.join(dir, "nope.json") }), new RegExp(storePath.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("preflightRoles: adds contextWindow for a known id, null when the id has no contextWindow, collects missing lines", () => {
	const storePath = tmpFile({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }, { id: "qwen3-flash" }, { id: "qwen3-uncensored" }] } });
	const store = loadModelStore({ storePath, overridesPath: path.join(path.dirname(storePath), "nope.json") });
	const roles = {
		builder: { provider: "llama.cpp", model: "qwen3-27b" },
		critic: { provider: "llama.cpp", model: "qwen3-flash" },
	};
	const { roles: out, missing } = preflightRoles(roles, store);
	assert.equal(out.builder.contextWindow, 131072);
	assert.equal(out.critic.contextWindow, null);
	assert.deepEqual(missing, []);
});

test("preflightRoles: unknown id for a known provider names available ids sorted", () => {
	const storePath = tmpFile({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }, { id: "qwen3-flash" }, { id: "qwen3-uncensored" }] } });
	const store = loadModelStore({ storePath, overridesPath: path.join(path.dirname(storePath), "nope.json") });
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27x" } };
	const { roles: out, missing } = preflightRoles(roles, store);
	assert.equal(out.builder.contextWindow, null);
	assert.deepEqual(missing, [
		'roles.builder names "llama.cpp/qwen3-27x" but pi has no such model; available for llama.cpp: qwen3-27b, qwen3-flash, qwen3-uncensored',
	]);
});

test("preflightRoles: unknown provider names it absent and lists known providers", () => {
	const storePath = tmpFile({ "llama.cpp": { models: [{ id: "qwen3-27b", contextWindow: 131072 }] }, anthropic: { models: [{ id: "claude-sonnet-5", contextWindow: 1000000 }] } });
	const store = loadModelStore({ storePath, overridesPath: path.join(path.dirname(storePath), "nope.json") });
	const roles = { builder: { provider: "openai", model: "gpt-5" } };
	const { missing } = preflightRoles(roles, store);
	assert.deepEqual(missing, [
		'roles.builder names "openai/gpt-5" but pi has no such model; available for openai: no models for provider "openai" (known: anthropic, llama.cpp)',
	]);
});
