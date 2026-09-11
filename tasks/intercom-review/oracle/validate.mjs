#!/usr/bin/env node
/**
 * Grounding validator for the intercom-review task.
 *
 * This is NOT a quality oracle — there is no ground truth for "is this a good
 * recommendation." It only checks that BUILDER's findings are well-formed and
 * that every citation resolves to real, non-trivial code inside the vendored
 * ./intercom/ tree. A finding can pass every check here and still be useless;
 * a finding can be a genuinely good idea and still fail here if BUILDER cited
 * it sloppily. Whether the recommendations are actually good is CRITIC's and
 * the supervisor's judgment call from reading the transcript, not this file's.
 *
 * Usage: node validate.mjs <builder-workspace-dir>
 * Prints progress to stderr, and exactly one JSON line to stdout:
 *   {"pass": N, "total": M, "summary": "..."}
 */
import fs from "node:fs";
import path from "node:path";

const wsDir = process.argv[2];
if (!wsDir) {
	console.log(JSON.stringify({ pass: 0, total: 1, summary: "no workspace dir given" }));
	process.exit(0);
}

const DUO_TARGETS = new Set(["supervisor.mjs", "mail-ext.ts", "prompts/builder.md", "prompts/critic.md", "new-file"]);
const MIN_FINDINGS = 4;

let checks = 0;
let passed = 0;
const notes = [];
function check(ok, label) {
	checks++;
	if (ok) passed++;
	else notes.push(`FAIL: ${label}`);
	return ok;
}

const findingsPath = path.join(wsDir, "src", "findings.json");
if (!check(fs.existsSync(findingsPath), "src/findings.json exists")) {
	console.log(JSON.stringify({ pass: 0, total: 1, summary: "src/findings.json not found" }));
	process.exit(0);
}

let findings;
try {
	findings = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
} catch (err) {
	console.log(JSON.stringify({ pass: 0, total: 1, summary: `findings.json is not valid JSON: ${err.message}` }));
	process.exit(0);
}

if (!check(Array.isArray(findings), "findings.json is a JSON array")) {
	console.log(JSON.stringify({ pass: passed, total: checks, summary: "not an array" }));
	process.exit(0);
}

check(findings.length >= MIN_FINDINGS, `at least ${MIN_FINDINGS} findings (got ${findings.length})`);

const intercomRoot = path.resolve(wsDir, "intercom");
const seenCitations = new Set();
let duplicateCitations = 0;

findings.forEach((f, i) => {
	const tag = `finding[${i}]`;
	const requiredFields = ["intercom_path", "line_start", "line_end", "what_it_does", "duo_target", "why", "risk"];
	const hasAllFields = requiredFields.every((k) => f && Object.prototype.hasOwnProperty.call(f, k));
	if (!check(hasAllFields, `${tag} has all required fields`)) return;

	const nonEmptyText = ["what_it_does", "why", "risk"].every((k) => typeof f[k] === "string" && f[k].trim().length > 0);
	check(nonEmptyText, `${tag} what_it_does/why/risk are non-empty strings`);

	check(DUO_TARGETS.has(f.duo_target), `${tag} duo_target "${f.duo_target}" is one of the allowed values`);

	const linesValid =
		Number.isInteger(f.line_start) && Number.isInteger(f.line_end) && f.line_start >= 1 && f.line_start <= f.line_end;
	if (!check(linesValid, `${tag} line_start/line_end are a valid integer range`)) return;

	let resolved = null;
	try {
		resolved = path.resolve(intercomRoot, f.intercom_path);
	} catch {
		resolved = null;
	}
	const insideIntercom = resolved && (resolved === intercomRoot || resolved.startsWith(intercomRoot + path.sep));
	if (!check(insideIntercom, `${tag} intercom_path "${f.intercom_path}" resolves inside ./intercom/`)) return;
	if (!check(fs.existsSync(resolved) && fs.statSync(resolved).isFile(), `${tag} cited file exists`)) return;

	const lines = fs.readFileSync(resolved, "utf8").split("\n");
	const rangeValid = f.line_end <= lines.length;
	if (!check(rangeValid, `${tag} line range is within the file (${lines.length} lines)`)) return;

	const cited = lines.slice(f.line_start - 1, f.line_end);
	const substantive = cited.some((l) => {
		const t = l.trim();
		if (t.length === 0) return false;
		if (/^(\/\/|\*|\/\*)/.test(t)) return false;
		if (/^(import|export\s*\{)/.test(t)) return false;
		return true;
	});
	check(substantive, `${tag} cited range contains real code, not just blanks/comments/imports`);

	const key = `${f.intercom_path}:${f.line_start}-${f.line_end}`;
	if (seenCitations.has(key)) duplicateCitations++;
	seenCitations.add(key);
});

check(duplicateCitations === 0, `no duplicate citations (found ${duplicateCitations})`);

for (const n of notes) console.error(n);
const summary = `${findings.length} findings, ${duplicateCitations} duplicate citation(s); this checks grounding only, not quality`;
console.log(JSON.stringify({ pass: passed, total: checks, summary }));
