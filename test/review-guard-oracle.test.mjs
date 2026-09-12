import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The review-guard oracle grounds findings AND runs the policy on each finding's
// input, so "actual" must be what decidePath really returns. It still cannot judge
// whether a denial was wrong; that stays with a human verdict.
const ORACLE = path.resolve("tasks/review-guard/oracle");
const CORPUS_SRC = path.resolve("tasks/review-guard/ws-builder/corpus");

function workspace(doc) {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-rg-"));
	fs.mkdirSync(path.join(ws, "corpus"));
	for (const f of fs.readdirSync(CORPUS_SRC)) fs.copyFileSync(path.join(CORPUS_SRC, f), path.join(ws, "corpus", f));
	fs.mkdirSync(path.join(ws, "src"));
	if (doc !== undefined) fs.writeFileSync(path.join(ws, "src", "findings.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
	return ws;
}
const policyLine = (needle) => {
	const lines = fs.readFileSync(path.join(CORPUS_SRC, "path-policy.mjs"), "utf8").split("\n");
	const i = lines.findIndex((l) => l.includes(needle));
	return { line: i + 1, quote: lines[i].trim().slice(0, 60) };
};
const ev = policyLine("PROTECTED_DIRS");
const finding = (i, over = {}) => ({
	id: `R${i}`,
	kind: "false_positive",
	tool: "bash",
	input: { command: "cat .pi/agents/worker.md" },
	expected: "allow",
	actual: "deny",
	why: "a worker may want to see its own definition",
	evidence: [{ file: "path-policy.mjs", line: ev.line, quote: ev.quote }],
	proposed_fix: "allow reads of .pi/agents",
	confidence: 0.6,
	...over,
});
const good = () => ({ findings: [1, 2, 3, 4].map((i) => finding(i)), recommendation: "R1 first" });

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

test("a grounded findings.json whose claimed verdicts match the policy passes every check", () => {
	const v = validate(workspace(good()));
	assert.equal(v.pass, v.total, v.summary);
});

test("a finding whose claimed `actual` is not what the policy returns fails that check", () => {
	const g = good();
	g.findings[0].input = { command: "node --test src/x.test.mjs" }; // the policy allows this
	const v = validate(workspace(g));
	assert.equal(v.total - v.pass, 1, v.summary);
	assert.match(v.summary, /R1.*policy returns allow/);
});

test("expected must differ from actual, quotes must be verbatim, and the file must exist in corpus", () => {
	const g = good();
	g.findings[1].expected = "deny";
	g.findings[2].evidence[0].quote = "this text is definitely not in the policy file at all";
	g.findings[3].evidence[0].file = "nope.mjs";
	const v = validate(workspace(g));
	assert.equal(v.total - v.pass, 3, v.summary);
	assert.match(v.summary, /R2.*differ/);
	assert.match(v.summary, /R3.*verbatim/);
	assert.match(v.summary, /R4.*nope\.mjs/);
});

test("missing file, malformed JSON, too few findings", () => {
	assert.deepEqual(validate(workspace(undefined)), { pass: 0, total: 1, summary: "src/findings.json not found" });
	assert.match(validate(workspace("{oops")).summary, /not valid JSON/);
	const g = good();
	g.findings = g.findings.slice(0, 2);
	assert.match(validate(workspace(g)).summary, /at least 4/);
});

test("probe grounds a finding by id and reports the policy's real verdict", () => {
	const g = good();
	g.findings[1].input = { path: "src/a.mjs" };
	g.findings[1].tool = "read";
	const out = probe(workspace(g), [{ id: "a", args: ["R1"] }, { id: "b", args: ["R2"] }, { id: "c", args: ["R9"] }]);
	assert.deepEqual(out[0].value, { finding: "R1", grounded: true, policy: "deny", failed: [] });
	assert.equal(out[1].value.grounded, false);
	assert.equal(out[1].value.policy, "allow");
	assert.equal(out[2].ok, false);
});
