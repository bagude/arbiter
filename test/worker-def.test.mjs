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
test("writeWorkerDefinition creates the agent file and the concurrency setting", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const p = writeWorkerDefinition(ws, { provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x", max: 1 });
	assert.equal(p, path.join(ws, ".pi", "agents", "worker.md"));
	assert.ok(fs.existsSync(p));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, ".pi", "subagents.json"), "utf8")), { maxConcurrent: 1 });
});
