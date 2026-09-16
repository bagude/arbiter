import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerDefinition, writeWorkerDefinition, installWorkspaceExtension, writeRosterDefinitions, workerPromptSuffix, REPORT_INSTRUCTION } from "../lib/worker-def.mjs";

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

test("workerPromptSuffix joins the report instruction and the memory excerpt, empty when neither is given", () => {
	assert.equal(workerPromptSuffix({}), "");
	assert.equal(workerPromptSuffix({ memoryText: "# MEMORY\n- fact" }), "# MEMORY\n- fact");
	assert.equal(workerPromptSuffix({ report: true }), REPORT_INSTRUCTION);
	assert.equal(workerPromptSuffix({ report: true, memoryText: "# MEMORY" }), `${REPORT_INSTRUCTION}\n\n# MEMORY`);
});

test("writeRosterDefinitions writes one .pi/agents/<name>.md per specialist and subagents.json with maxConcurrent", async () => {
	const { parseRosterFile } = await import("../lib/roster.mjs");
	const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-roster-"));
	fs.writeFileSync(path.join(rosterDir, "worker.md"), "---\nname: worker\ndescription: Builds one piece of the task from the orchestrator's brief.\ntools: read, bash\n---\nGENERIC WORKER BODY\n");
	fs.writeFileSync(path.join(rosterDir, "scout.md"), "---\nname: scout\ndescription: Maps the repo.\ntools: read, ls\n---\nSCOUT BODY\n");
	const specialists = [parseRosterFile(path.join(rosterDir, "worker.md")), parseRosterFile(path.join(rosterDir, "scout.md"))];
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const workers = { default: { provider: "p", model: "m" }, overrides: {}, max: 2 };
	const { files } = writeRosterDefinitions(ws, { specialists, workers, promptSuffixFor: (spec) => `SUFFIX FOR ${spec.name}` });
	assert.deepEqual(files, [path.join(ws, ".pi", "agents", "worker.md"), path.join(ws, ".pi", "agents", "scout.md")]);
	for (const f of files) assert.ok(fs.existsSync(f));
	const workerMd = fs.readFileSync(files[0], "utf8");
	assert.match(workerMd, /\nmodel: p\/m\n/);
	assert.match(workerMd, /GENERIC WORKER BODY/);
	assert.match(workerMd, /SUFFIX FOR worker\n$/);
	const scoutMd = fs.readFileSync(files[1], "utf8");
	assert.match(scoutMd, /\nmodel: p\/m\n/);
	assert.match(scoutMd, /SUFFIX FOR scout\n$/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, ".pi", "subagents.json"), "utf8")), { maxConcurrent: 2 });
});

test("writeRosterDefinitions replaces the worker spec's body with taskDir/worker.md when it exists, leaves other specialists alone", async () => {
	const { parseRosterFile } = await import("../lib/roster.mjs");
	const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-roster-"));
	fs.writeFileSync(path.join(rosterDir, "worker.md"), "---\nname: worker\ndescription: Builds one piece of the task from the orchestrator's brief.\ntools: read\n---\nGENERIC WORKER BODY\n");
	const specialists = [parseRosterFile(path.join(rosterDir, "worker.md"))];
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-task-"));
	fs.writeFileSync(path.join(taskDir, "worker.md"), "TASK-SPECIFIC WORKER BODY\n");
	const workers = { default: { provider: "p", model: "m" }, overrides: {}, max: 1 };
	const { files } = writeRosterDefinitions(ws, { specialists, workers, taskDir });
	const md = fs.readFileSync(files[0], "utf8");
	assert.match(md, /TASK-SPECIFIC WORKER BODY/);
	assert.doesNotMatch(md, /GENERIC WORKER BODY/);
});

test("writeRosterDefinitions applies per-name overrides (provider/model/thinking/background) and extraTools", async () => {
	const { parseRosterFile } = await import("../lib/roster.mjs");
	const rosterDir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-roster-"));
	fs.writeFileSync(path.join(rosterDir, "tester.md"), "---\nname: tester\ndescription: Tests things.\ntools: read, bash\nbackground: false\n---\nTESTER BODY\n");
	const specialists = [parseRosterFile(path.join(rosterDir, "tester.md"))];
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const workers = { default: { provider: "p", model: "m", thinking: "off" }, overrides: { tester: { provider: "q", model: "n", thinking: "low", background: true } }, max: 1 };
	const { files } = writeRosterDefinitions(ws, { specialists, workers, extraTools: ["report"] });
	const md = fs.readFileSync(files[0], "utf8");
	assert.match(md, /\nmodel: q\/n\n/);
	assert.match(md, /\nthinking: low\n/);
	assert.match(md, /\nrun_in_background: true\n/);
	assert.match(md, /\ntools: read,bash,report\n/);
});
