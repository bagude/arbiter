#!/usr/bin/env node
/**
 * Probe runner for the review-guard task — grounds findings by id on demand and
 * reports the policy's real verdict for each finding's input.
 *
 * Input (stdin): JSON array of {id, args: ["<finding id>"]}.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value:{finding, grounded, policy, failed:[...]}} | {id, ok:false, error}
 */
import fs from "node:fs";
import { loadFindings, checkFinding, corpusDirFor, loadPolicy } from "./grounding.mjs";

const workDir = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: invalid probes JSON on stdin: ${err.message}` }]));
	process.exit(0);
}
if (!Array.isArray(probes)) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: "probe.mjs: probes must be a JSON array" }]));
	process.exit(0);
}
const { doc, error } = loadFindings(workDir);
if (error) {
	console.log(JSON.stringify(probes.map((p) => ({ id: p?.id ?? "?", ok: false, error }))));
	process.exit(0);
}
const corpusDir = corpusDirFor(workDir);
const policy = await loadPolicy(corpusDir);
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const fid = Array.isArray(p?.args) ? p.args[0] : undefined;
	if (typeof fid !== "string" || !fid) return { id, ok: false, error: 'each probe needs args: ["<finding id>"]' };
	const finding = doc.findings.find((f) => f?.id === fid);
	if (!finding) return { id, ok: false, error: `no finding ${fid} in src/findings.json (ids: ${doc.findings.map((f) => f?.id).join(", ")})` };
	const { checks, verdict } = checkFinding({ corpusDir, policy, root: workDir }, finding);
	const failed = checks.filter((c) => !c.ok).map((c) => c.label);
	return { id, ok: true, value: { finding: fid, grounded: failed.length === 0, policy: verdict, failed } };
});
console.log(JSON.stringify(results));
