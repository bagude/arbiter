import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";

// Drives ext/memory-ext.ts through tsx with a fake `pi` whose registerTool collects
// tools, the same harness pattern as test/context-usage-ext.test.mjs. memory_search
// and memory_get are covered by lib/memory-tools.mjs's own unit tests; this file
// exercises the ext adapter's registration and lifecycle reporting for `remember`,
// which needs the real pi.registerTool wiring (role detection via guard-kit, the
// lifecycle file) that lib/memory-tools.mjs's rememberTool itself does not touch.
import { PI_ROOT } from "../lib/pi-root.mjs";
const PI = PI_ROOT;

function buildIndexFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-memext-"));
	const log = path.join(dir, "records.jsonl");
	appendLog(log, [makeRecord({ id: "m_1", scope: "global", kind: "semantic", source: "supervisor", claim: "observed", text: "a seed record for the memory ext test." })]);
	return buildIndex(dir, resolveLedger(log));
}

function run({ toolName, params, sessionFile, env = {} }) {
	const lifecycle = path.join(os.tmpdir(), `memory-ext-lifecycle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
	const driver = path.join(os.tmpdir(), `memory-ext-driver-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/memory-ext.ts"))}).href);
		const tools = {};
		mod.default({ registerTool: (def) => { tools[def.name] = def; } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => (${JSON.stringify(sessionFile ?? null)} || undefined) } };
		const names = Object.keys(tools);
		const toolName = ${JSON.stringify(toolName ?? null)};
		let result = null;
		if (toolName && tools[toolName]) {
			result = await tools[toolName].execute("call1", ${JSON.stringify(params ?? {})}, undefined, undefined, ctx);
		}
		console.log(JSON.stringify({ names, result }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", NODE_PATH: `${PI}/node_modules`, ARBITER_LIFECYCLE_FILE: lifecycle, ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lifecycleLines = fs.existsSync(lifecycle)
		? fs
				.readFileSync(lifecycle, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
	return { ...JSON.parse(r.stdout.trim()), lifecycleLines };
}

test("without ARBITER_REMEMBER_FILE, remember is not registered even though the memory tools are", () => {
	const indexFile = buildIndexFile();
	const { names } = run({ toolName: null, env: { ARBITER_MEMORY_INDEX: indexFile, ARBITER_MEMORY_BUDGET: "6000", ARBITER_REMEMBER_FILE: "" } });
	assert.ok(names.includes("memory_search"));
	assert.ok(names.includes("memory_get"));
	assert.ok(!names.includes("remember"));
});

test("with ARBITER_REMEMBER_FILE set, a worker's remember call is registered, writes the line, and reports memory:remember", () => {
	const indexFile = buildIndexFile();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-memext-rem-"));
	const rememberFile = path.join(dir, "remember.jsonl");
	const { names, result, lifecycleLines } = run({
		toolName: "remember",
		params: { text: "the loader drops rows whose water_bbl column is entirely null in TX.", evidence_refs: ["file:loader.py"] },
		sessionFile: "C:/ws/.pi/sessions/orchestrator/2026_x/tasks/w1.jsonl",
		env: { ARBITER_MEMORY_INDEX: indexFile, ARBITER_MEMORY_BUDGET: "6000", ARBITER_REMEMBER_FILE: rememberFile },
	});
	assert.ok(names.includes("remember"));
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /remembered as a candidate for review \(1 of 5 this run\)/);
	const lines = fs
		.readFileSync(rememberFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	assert.equal(lines[0].role, "worker:w1");
	assert.deepEqual(lines[0].evidence_refs, ["file:loader.py"]);
	const ev = lifecycleLines.find((l) => l.ev === "memory:remember");
	assert.ok(ev, "expected a memory:remember lifecycle event");
	assert.equal(ev.data.role, "worker:w1");
	assert.equal(ev.data.chars, "the loader drops rows whose water_bbl column is entirely null in TX.".length);
	assert.equal(ev.data.detail, "the loader drops rows whose water_bbl column is entirely null in TX.".slice(0, 80));
});

test("an orchestrator's remember call is refused and no memory:remember lifecycle event is recorded", () => {
	const indexFile = buildIndexFile();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-memext-rem2-"));
	const rememberFile = path.join(dir, "remember.jsonl");
	const { result, lifecycleLines } = run({
		toolName: "remember",
		params: { text: "a lesson that would otherwise be long enough to be accepted here." },
		sessionFile: null,
		env: { ARBITER_MEMORY_INDEX: indexFile, ARBITER_MEMORY_BUDGET: "6000", ARBITER_REMEMBER_FILE: rememberFile },
	});
	assert.match(result.content[0].text, /remember is for workers/);
	assert.equal(fs.existsSync(rememberFile), false);
	assert.equal(
		lifecycleLines.some((l) => l.ev === "memory:remember"),
		false,
	);
	const refused = lifecycleLines.find((l) => l.ev === "memory:refused");
	assert.ok(refused, "expected a memory:refused lifecycle event");
	assert.match(refused.data.detail, /remember is for workers/);
	assert.equal(refused.data.chars, 0);
});
