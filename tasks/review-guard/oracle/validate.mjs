#!/usr/bin/env node
/**
 * Grounding validator for the review-guard task — the oracle.
 *
 * Checks that src/findings.json is well-formed, that every cited quote is verbatim in
 * a corpus file, and that each finding's claimed `actual` is what the policy really
 * returns for its input. It cannot judge whether a verdict was WRONG — that is the
 * human's ruling (tools/verdict.mjs).
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line to stdout: {"pass": N, "total": M, "summary": "..."}
 */
import { loadFindings, checkFinding, corpusDirFor, loadPolicy, MIN_FINDINGS } from "./grounding.mjs";

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
const corpusDir = corpusDirFor(wsDir);
const policy = await loadPolicy(corpusDir);
const checks = [];
const ok = (cond, label) => checks.push({ ok: Boolean(cond), label });
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

ok(doc.findings.length >= MIN_FINDINGS, `at least ${MIN_FINDINGS} findings (got ${doc.findings.length})`);
const ids = doc.findings.map((f) => f?.id);
ok(new Set(ids).size === ids.length, `finding ids are unique (${ids.join(", ")})`);
for (const f of doc.findings) checks.push(...checkFinding({ corpusDir, policy, root: wsDir }, f).checks);
ok(isStr(doc.recommendation) && ids.some((id) => isStr(id) && doc.recommendation.includes(id)), "recommendation is non-empty and names a finding id");

const failed = checks.filter((c) => !c.ok).map((c) => c.label);
for (const label of failed) console.error(`FAIL: ${label}`);
const summary = `${doc.findings.length} findings; ${failed.length} failing check(s)${failed.length ? `: ${failed.join("; ")}` : ""}; grounding and policy-verdict checks only, not whether a verdict was wrong`;
console.log(JSON.stringify({ pass: checks.length - failed.length, total: checks.length, summary: summary.slice(0, 4000) }));
