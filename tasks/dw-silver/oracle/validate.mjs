#!/usr/bin/env node
/**
 * Oracle for dw-silver: run the candidate's src/silver.py and the reference reader
 * on the workspace's data/bronze (both into scratch dirs outside the workspace),
 * then compare table by table and check the hand-traced labels.
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line: {"pass": N, "total": M, "summary": "..."}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFERENCE, contractUntouched, interfaceChecks, runChecker, runSilver } from "./harness.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
if (!ws || !fs.existsSync(ws)) {
	out({ pass: 0, total: 1, summary: "no workspace dir given" });
	process.exit(0);
}
const src = path.join(ws, "src", "silver.py");
if (!fs.existsSync(src)) {
	out({ pass: 0, total: 1, summary: "src/silver.py missing" });
	process.exit(0);
}
const checks = [contractUntouched(ws), ...interfaceChecks(src)];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-silver-"));
try {
	const exp = path.join(scratch, "expected");
	const act = path.join(scratch, "actual");
	const ref = runSilver(ws, REFERENCE, exp);
	if (ref.status !== 0) checks.push({ ok: false, label: `reference failed (oracle bug): ${ref.tail}` });
	const r = runSilver(ws, src, act);
	checks.push({ ok: r.status === 0, label: `src/silver.py exits 0 (exit ${r.status}${r.status === 0 ? "" : `: ${r.tail}`})` });
	if (ref.status === 0 && r.status === 0) {
		const res = runChecker(ws, exp, act);
		if (!res) checks.push({ ok: false, label: "silver_check.py produced no result" });
		else for (const c of res.checks) checks.push({ ok: c.ok, label: `${c.table}/${c.state}/${c.name}: ${c.detail}` });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).map((c) => c.label);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${checks.length - failed.length}/${checks.length} silver checks${failed.length ? `; failing: ${failed.slice(0, 12).join(" | ")}` : ""}`;
out({ pass: checks.length - failed.length, total: checks.length, summary: summary.slice(0, 4000) });
