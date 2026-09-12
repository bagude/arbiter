#!/usr/bin/env node
/**
 * Oracle for dw-bronze: runs the candidate's src/bronze.py twice against the
 * workspace's remote/ (into scratch directories outside the workspace) and grades
 * both outputs with bronze_check.py — layout, completeness, byte integrity,
 * manifest truth, idempotence — plus the interface rules (size, no network modules).
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line: {"pass": N, "total": M, "summary": "..."}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCandidate, runChecker, interfaceChecks, REQ } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const out = (o) => console.log(JSON.stringify(o));
if (!ws || !fs.existsSync(ws)) {
	out({ pass: 0, total: 1, summary: "no workspace dir given" });
	process.exit(0);
}
const src = path.join(ws, "src", "bronze.py");
if (!fs.existsSync(src)) {
	out({ pass: 0, total: 1, summary: "src/bronze.py missing" });
	process.exit(0);
}
const checks = interfaceChecks(src);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-bronze-"));
try {
	const b1 = path.join(scratch, "b1");
	const b2 = path.join(scratch, "b2");
	const r1 = runCandidate(ws, src, b1);
	checks.push({ ok: r1.status === 0, label: `first run exits 0 (exit ${r1.status}${r1.status === 0 ? "" : `: ${r1.tail}`})` });
	const r2 = runCandidate(ws, src, b2);
	checks.push({ ok: r2.status === 0, label: `second run exits 0 (exit ${r2.status})` });
	if (r1.status === 0 && r2.status === 0) {
		const res = runChecker(path.join(here, "bronze_check.py"), ["check", "--remote", path.join(ws, "remote"), "--bronze", b1, "--bronze2", b2]);
		if (!res) checks.push({ ok: false, label: "bronze_check.py produced no result" });
		else for (const c of res.checks) checks.push({ ok: c.ok, label: `${c.state}/${c.name}: ${c.detail}` });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).map((c) => c.label);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${checks.length - failed.length}/${checks.length} bronze checks${failed.length ? `; failing: ${failed.slice(0, 12).join(" | ")}` : ""}`;
out({ pass: checks.length - failed.length, total: checks.length, summary: summary.slice(0, 4000) });
