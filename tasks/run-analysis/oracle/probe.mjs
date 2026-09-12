#!/usr/bin/env node
/**
 * Probe runner for the run-analysis task — grounds individual findings on demand.
 *
 * The orchestrator's kind="probe" is normally "run these inputs against the real
 * code". For a research task the equivalent is "check these findings against the
 * real corpus": a worker's report that its quotes are verbatim is a claim; this is
 * the fact.
 *
 * Input (stdin): JSON array of {id, args: ["<finding id>"]}.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value:{finding, grounded, failed:[...]}} | {id, ok:false, error}
 */
import fs from "node:fs";
import { loadFindings, checkFinding, runsDirFor } from "./grounding.mjs";

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
const runsDir = runsDirFor(workDir);
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const fid = Array.isArray(p?.args) ? p.args[0] : undefined;
	if (typeof fid !== "string" || !fid) return { id, ok: false, error: 'each probe needs args: ["<finding id>"]' };
	const finding = doc.findings.find((f) => f?.id === fid);
	if (!finding) return { id, ok: false, error: `no finding ${fid} in src/findings.json (ids: ${doc.findings.map((f) => f?.id).join(", ")})` };
	const failed = checkFinding(runsDir, finding)
		.filter((c) => !c.ok)
		.map((c) => c.label);
	return { id, ok: true, value: { finding: fid, grounded: failed.length === 0, failed } };
});
console.log(JSON.stringify(results));
