import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerDefinition, writeWorkerDefinition, installWorkspaceExtension } from "../lib/worker-def.mjs";

test("installWorkspaceExtension copies an extension into the workspace's .pi/extensions", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const src = path.join(ws, "guard-src.ts");
	fs.writeFileSync(src, "export default function () {}\n");
	const p = installWorkspaceExtension(ws, src);
	assert.equal(p, path.join(ws, ".pi", "extensions", "guard-src.ts"));
	assert.equal(fs.readFileSync(p, "utf8"), "export default function () {}\n");
});

test("definition has the frontmatter pi-subagents reads", () => {
	const md = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read", "bash"], prompt: "Build it.", maxTurns: 12 });
	assert.match(md, /^---\nname: worker\n/);
	assert.match(md, /\ntools: read,bash\n/);
	assert.match(md, /\nmodel: llama\.cpp\/qwen3-27b\n/);
	assert.match(md, /\nmax_turns: 12\n/);
	assert.match(md, /\nrun_in_background: false\n---\nBuild it\.\n$/);
});
test("definition carries a thinking line only when a level is set", () => {
	const none = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x" });
	assert.doesNotMatch(none, /\nthinking:/);
	const low = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x", thinking: "low" });
	assert.match(low, /\nmodel: llama\.cpp\/qwen3-27b\nthinking: low\nmax_turns: 60\n/);
});

test("writeWorkerDefinition creates the agent file and the concurrency setting", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const p = writeWorkerDefinition(ws, { provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x", max: 1 });
	assert.equal(p, path.join(ws, ".pi", "agents", "worker.md"));
	assert.ok(fs.existsSync(p));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, ".pi", "subagents.json"), "utf8")), { maxConcurrent: 1 });
});

test("resolveWorkerPrompt prefers the task's own worker.md, falls back to prompts/worker.md, and appends the memory excerpt", async () => {
	const { resolveWorkerPrompt } = await import("../lib/worker-def.mjs");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-home-"));
	fs.mkdirSync(path.join(home, "prompts"));
	fs.writeFileSync(path.join(home, "prompts", "worker.md"), "GENERIC\n");
	const task = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-task-"));
	assert.deepEqual(resolveWorkerPrompt({ taskDir: task, home }), { prompt: "GENERIC", file: path.join(home, "prompts", "worker.md") });
	fs.writeFileSync(path.join(task, "worker.md"), "OWN\n");
	const r = resolveWorkerPrompt({ taskDir: task, home, memoryText: "# MEMORY\n- fact" });
	assert.equal(r.file, path.join(task, "worker.md"));
	assert.equal(r.prompt, "OWN\n\n# MEMORY\n- fact");
});

test("resolveWorkerPrompt inserts the report instruction between the prompt and the memory excerpt when asked", async () => {
	const { resolveWorkerPrompt, REPORT_INSTRUCTION } = await import("../lib/worker-def.mjs");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-home-"));
	fs.mkdirSync(path.join(home, "prompts"));
	fs.writeFileSync(path.join(home, "prompts", "worker.md"), "GENERIC\n");
	const task = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-task-"));
	assert.equal(resolveWorkerPrompt({ taskDir: task, home }).prompt, "GENERIC");
	assert.equal(resolveWorkerPrompt({ taskDir: task, home, report: true }).prompt, `GENERIC\n\n${REPORT_INSTRUCTION}`);
	assert.equal(resolveWorkerPrompt({ taskDir: task, home, report: true, memoryText: "# MEMORY" }).prompt, `GENERIC\n\n${REPORT_INSTRUCTION}\n\n# MEMORY`);
	assert.match(REPORT_INSTRUCTION, /call the `report` tool once/);
});
