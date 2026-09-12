#!/usr/bin/env node
/**
 * Grounding validator for the run-analysis task — the oracle.
 *
 * Checks that src/findings.json is well-formed and that every cited quote is a
 * verbatim substring of a real file in a real run. It says nothing about whether
 * the findings are insightful; that is judged from the transcript.
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line to stdout: {"pass": N, "total": M, "summary": "..."}
 */
import { loadFindings, checkFinding, runsDirFor, MIN_FINDINGS } from "./grounding.mjs";

const wsDir = process.argv[2];
if (!wsDir) {
	console.log(JSON.stringify({ pass: 0, total: 1, summary: "no workspace dir given" }));
	process.exit(0);
}
const { doc, error } = loadFindings(wsDir);
if (error) {
	console.log(JSON.stringify({ pass: 0, total: 1, summary: error }));
	process.exit(0);
}

const runsDir = runsDirFor(wsDir);
const checks = [];
const ok = (cond, label) => checks.push({ ok: Boolean(cond), label });
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

ok(isStr(doc.question), "question is a non-empty string");
ok(doc.findings.length >= MIN_FINDINGS, `at least ${MIN_FINDINGS} findings (got ${doc.findings.length})`);
const ids = doc.findings.map((f) => f?.id);
ok(new Set(ids).size === ids.length, `finding ids are unique (${ids.join(", ")})`);
const sigs = doc.findings.map((f) => String(f?.signature ?? "").trim().toLowerCase());
ok(new Set(sigs).size === sigs.length, "signatures are distinct");
for (const f of doc.findings) checks.push(...checkFinding(runsDir, f));
ok(isStr(doc.recommendation) && ids.some((id) => isStr(id) && doc.recommendation.includes(id)), "recommendation is non-empty and names one of the findings by id");

const failed = checks.filter((c) => !c.ok).map((c) => c.label);
for (const label of failed) console.error(`FAIL: ${label}`);
const summary = `${doc.findings.length} findings; ${failed.length} failing check(s)${failed.length ? `: ${failed.join("; ")}` : ""}; this checks grounding only, not quality`;
console.log(JSON.stringify({ pass: checks.length - failed.length, total: checks.length, summary: summary.slice(0, 4000) }));
