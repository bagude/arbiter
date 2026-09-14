import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/report-ext.ts through tsx with a fake `pi` that captures registerTool,
// then calls the tool's execute() the way a worker session would. Registers nothing
// unless ARBITER_REPORT_FILE is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run({ calls, on = false }) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-ext-"));
	const lifecycle = path.join(tmp, "lifecycle.jsonl");
	const reports = path.join(tmp, "reports.jsonl");
	const driver = path.join(tmp, "driver.mjs");
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/report-ext.ts"))}).href);
		const tools = {};
		mod.default({ registerTool: (t) => { tools[t.name] = t; }, on() {}, events: { on() {} } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => "C:/sessions/orchestrator/tasks/abc123.jsonl" } };
		const out = [];
		for (const params of ${JSON.stringify(calls)}) out.push(tools.report ? await tools.report.execute("t1", params, undefined, undefined, ctx) : "not-registered");
		console.log(JSON.stringify({ registered: Object.keys(tools), schema: tools.report?.parameters ?? null, out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, ARBITER_HOME: path.resolve("."), NODE_PATH: `${PI}/node_modules`, ARBITER_REPORT_FILE: on ? reports : "" },
	});
	assert.equal(r.status, 0, r.stderr);
	const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	return { ...JSON.parse(r.stdout.trim()), lines: read(lifecycle), entries: read(reports) };
}

const REPORT = {
	status: "done",
	summary: "implemented stage 1",
	changed: ["src/orbit.mjs"],
	findings: [{ claim: "observed", text: "node --test passes 4/4", evidence_refs: ["src/orbit.test.mjs"] }],
	verify: [{ id: "c1", args: [1, 2], expect: 3 }],
	open_questions: [],
};

test("not registered when ARBITER_REPORT_FILE is unset", () => {
	const { registered, out } = run({ calls: [REPORT] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, ["not-registered"]);
});

test("schema: the required keys, the claim union and the probe-shaped verify case", () => {
	const { schema } = run({ calls: [], on: true });
	assert.deepEqual(schema.required, ["status", "summary", "changed", "findings", "verify", "open_questions"]);
	assert.deepEqual(schema.properties.status.anyOf.map((s) => s.const), ["done", "partial", "blocked"]);
	assert.deepEqual(schema.properties.findings.items.properties.claim.anyOf.map((s) => s.const), ["observed", "interpreted", "hypothesis"]);
	assert.deepEqual(schema.properties.findings.items.required, ["claim", "text"]);
	assert.equal(schema.properties.findings.items.properties.settlement_criterion.maxLength, 400);
	assert.deepEqual(schema.properties.verify.items.required, ["id", "args"]);
	assert.equal(schema.properties.verify.maxItems, 12);
	assert.equal(schema.properties.summary.maxLength, 600);
});

test("execute appends the entry under the worker's session name and emits worker:report with the verify cases", () => {
	const { out, lines, entries } = run({ calls: [REPORT], on: true });
	assert.equal(out[0].isError, false);
	assert.match(out[0].content[0].text, /report recorded \(done; 1 findings, 1 verify cases\)/);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].role, "worker:abc123");
	assert.equal(entries[0].status, "done");
	assert.deepEqual(entries[0].verify, REPORT.verify);
	assert.deepEqual(entries[0].findings, REPORT.findings);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "worker:report");
	assert.equal(lines[0].data.role, "worker:abc123");
	assert.equal(lines[0].data.status, "done");
	assert.equal(lines[0].data.findings, 1);
	assert.equal(lines[0].data.verify, 1);
	assert.deepEqual(lines[0].data.verifyCases, REPORT.verify);
});

test("an identical consecutive report from the same worker is a no-op; a changed one files again", () => {
	const { out, lines, entries } = run({ calls: [REPORT, REPORT, { ...REPORT, status: "partial" }], on: true });
	assert.equal(entries.length, 2);
	assert.equal(lines.length, 2);
	assert.equal(out[1].details.duplicate, true);
	assert.match(out[1].content[0].text, /already recorded/);
	assert.equal(entries[1].status, "partial");
});
