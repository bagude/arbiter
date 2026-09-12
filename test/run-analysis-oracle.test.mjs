import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The research task's oracle is a grounding validator, not a quality judge: it can
// only say whether findings.json is well-formed and every quote is really in the
// cited file. These tests drive validate.mjs and probe.mjs against a tiny fake
// workspace with two runs.
const ORACLE = path.resolve("tasks/run-analysis/oracle");
const QUESTION = "What failure signatures recur across arbiter runs, and which guard would remove the most cost?";

function workspace(findings) {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ra-"));
	for (const id of ["run-a", "run-b"]) {
		fs.mkdirSync(path.join(ws, "runs", id), { recursive: true });
		fs.writeFileSync(path.join(ws, "runs", id, "audit.jsonl"), `{"t":"1.0","type":"tool","msg":"bash {\\"command\\":\\"find / -name x\\"}"}\n{"t":"95.0","type":"bash_timeout","msg":"bash call running 95s (limit 90s), aborting: find / -name x"}\n`);
		fs.writeFileSync(path.join(ws, "runs", id, "summary.json"), JSON.stringify({ runId: id, reason: "CAP: wall 1500s >= 1500s" }));
	}
	fs.mkdirSync(path.join(ws, "src"), { recursive: true });
	if (findings !== undefined) fs.writeFileSync(path.join(ws, "src", "findings.json"), typeof findings === "string" ? findings : JSON.stringify(findings));
	return ws;
}
const QUOTE = 'bash call running 95s (limit 90s), aborting: find / -name x';
const finding = (i, over = {}) => ({
	id: `F${i}`,
	signature: `signature ${i}`,
	description: "a bash call without a timeout runs until the watchdog aborts it",
	occurrences: 2,
	runs: ["run-a", "run-b"],
	evidence: [
		{ run: "run-a", file: "audit.jsonl", quote: QUOTE },
		{ run: "run-b", file: "audit.jsonl", quote: QUOTE },
	],
	cost: "95 s per occurrence, 2 occurrences",
	proposed_guard: "tool_call on bash: inject timeout when absent",
	confidence: 0.9,
	...over,
});
const good = () => ({ question: QUESTION, findings: [1, 2, 3, 4, 5].map((i) => finding(i)), recommendation: "F1 — it removes 190 s across two runs" });

function validate(ws) {
	const r = spawnSync(process.execPath, [path.join(ORACLE, "validate.mjs"), ws], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
function probe(ws, cases) {
	const r = spawnSync(process.execPath, [path.join(ORACLE, "probe.mjs"), ws], { encoding: "utf8", input: JSON.stringify(cases) });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("a well-formed, fully grounded findings.json passes every check", () => {
	const v = validate(workspace(good()));
	assert.equal(v.pass, v.total, v.summary);
	assert.ok(v.total >= 10);
});

test("a missing or malformed findings.json fails with a clear summary", () => {
	assert.deepEqual(validate(workspace(undefined)), { pass: 0, total: 1, summary: "src/findings.json not found" });
	assert.match(validate(workspace("{not json")).summary, /not valid JSON/);
});

test("a paraphrased quote, a nonexistent run, and a single-run finding each fail exactly their check", () => {
	const g = good();
	g.findings[0].evidence[0].quote = "bash call ran for 95 seconds and was aborted by the watchdog";
	g.findings[1].evidence[1].run = "run-zzz";
	g.findings[2].evidence = [{ run: "run-a", file: "audit.jsonl", quote: QUOTE }, { run: "run-a", file: "audit.jsonl", quote: QUOTE }];
	const v = validate(workspace(g));
	assert.equal(v.total - v.pass, 3, v.summary);
	assert.match(v.summary, /F1.*verbatim/);
	assert.match(v.summary, /F2.*run-zzz/);
	assert.match(v.summary, /F3.*2 different runs/);
});

test("fewer than 5 findings, duplicate ids, and a recommendation naming no finding are failures", () => {
	const g = good();
	g.findings = g.findings.slice(0, 4);
	g.findings[1].id = "F1";
	g.recommendation = "build everything";
	const v = validate(workspace(g));
	assert.ok(v.total - v.pass >= 3, v.summary);
	assert.match(v.summary, /at least 5/);
	assert.match(v.summary, /unique/);
	assert.match(v.summary, /recommendation/);
});

test("probe grounds individual findings by id and names the failing check", () => {
	const g = good();
	g.findings[2].evidence[1].quote = "not in the file at all, definitely not, forty chars";
	const ws = workspace(g);
	const out = probe(ws, [{ id: "a", args: ["F1"] }, { id: "b", args: ["F3"] }, { id: "c", args: ["F9"] }, { id: "d", args: [] }]);
	assert.equal(out[0].ok, true);
	assert.deepEqual(out[0].value, { finding: "F1", grounded: true, failed: [] });
	assert.equal(out[1].value.grounded, false);
	assert.match(out[1].value.failed[0], /verbatim/);
	assert.equal(out[2].ok, false);
	assert.match(out[2].error, /F9/);
	assert.equal(out[3].ok, false);
});
