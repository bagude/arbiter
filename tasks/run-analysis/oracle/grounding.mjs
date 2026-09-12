// Grounding checks shared by validate.mjs (the oracle) and probe.mjs (on-demand).
//
// This is NOT a quality judge. It only establishes that a finding is well-formed
// and that every quote it cites is a verbatim substring of a real file in a real
// run. A finding can pass every check here and still be a bad idea; that judgment
// is the reader's, from the transcript.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The pristine corpus shipped with the task. The probe runs in a scratch copy that
// holds only src/, and a workspace's runs/ is writable by agents; the task copy is
// the truth either way.
const PRISTINE_RUNS = path.resolve(here, "..", "ws-builder", "runs");

export const MIN_FINDINGS = 5;
export const MIN_EVIDENCE = 2;
export const MIN_QUOTE = 40;

export function runsDirFor(wsDir) {
	const local = path.join(wsDir, "runs");
	return fs.existsSync(local) ? local : PRISTINE_RUNS;
}

export function loadFindings(wsDir) {
	const file = path.join(wsDir, "src", "findings.json");
	if (!fs.existsSync(file)) return { error: "src/findings.json not found" };
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return { error: `findings.json is not valid JSON: ${err.message}` };
	}
	if (!doc || typeof doc !== "object" || !Array.isArray(doc.findings)) return { error: "findings.json must be an object with a findings array" };
	return { doc };
}

/** One evidence entry: returns null when grounded, else the reason. */
export function checkEvidence(runsDir, e) {
	if (!e || typeof e !== "object") return "evidence entry is not an object";
	if (typeof e.run !== "string" || !e.run) return "evidence has no run";
	const runDir = path.join(runsDir, e.run);
	if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) return `run "${e.run}" does not exist`;
	if (typeof e.file !== "string" || !e.file) return "evidence has no file";
	const file = path.resolve(runDir, e.file);
	if (!file.startsWith(runDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return `file "${e.file}" does not exist in run ${e.run}`;
	if (typeof e.quote !== "string" || e.quote.length < MIN_QUOTE) return `quote is shorter than ${MIN_QUOTE} characters`;
	const text = fs.readFileSync(file, "utf8");
	if (!text.includes(e.quote) && !text.replace(/\r\n/g, "\n").includes(e.quote)) return `quote is not found verbatim in ${e.run}/${e.file}`;
	return null;
}

/**
 * All checks for one finding as an ordered list of {ok, label}. Each evidence entry
 * is exactly one check, so a single bad quote costs a single check.
 */
export function checkFinding(runsDir, f) {
	const tag = f?.id ?? "?";
	const checks = [];
	const ok = (cond, label) => checks.push({ ok: Boolean(cond), label: `${tag}: ${label}` });
	const isStr = (v) => typeof v === "string" && v.trim().length > 0;
	if (!f || typeof f !== "object") {
		ok(false, "finding is not an object");
		return checks;
	}
	ok(isStr(f.id) && isStr(f.signature) && isStr(f.description), "id, signature and description are non-empty strings");
	ok(Number.isInteger(f.occurrences) && f.occurrences >= 2, `occurrences is an integer ≥ 2 (got ${JSON.stringify(f.occurrences)})`);
	ok(Array.isArray(f.runs) && f.runs.length > 0 && f.runs.every(isStr), "runs is a non-empty list of run ids");
	const evidence = Array.isArray(f.evidence) ? f.evidence : [];
	ok(evidence.length >= MIN_EVIDENCE, `at least ${MIN_EVIDENCE} evidence entries (got ${evidence.length})`);
	evidence.forEach((e, i) => {
		const why = checkEvidence(runsDir, e);
		ok(why === null, `evidence[${i}] ${why ?? "grounded"}`);
	});
	const distinctRuns = new Set(evidence.map((e) => e?.run).filter(Boolean));
	ok(distinctRuns.size >= 2, `evidence from at least 2 different runs (got ${distinctRuns.size})`);
	ok(isStr(f.cost) && isStr(f.proposed_guard), "cost and proposed_guard are non-empty");
	ok(typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1, "confidence is a number in [0, 1]");
	return checks;
}
