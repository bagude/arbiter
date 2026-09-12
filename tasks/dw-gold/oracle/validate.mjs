#!/usr/bin/env node
/**
 * Oracle for dw-gold: build the reference gold and the candidate's gold from the
 * workspace's data/silver (both into scratch), compare table by table, run the
 * contract's assertions on the candidate, reconcile TX against the county rollup.
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line: {"pass": N, "total": M, "summary": "..."}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFERENCE, interfaceChecks, runChecker, runGold } from "./harness.mjs";

const ws = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const out = (o) => console.log(JSON.stringify(o));
if (!ws || !fs.existsSync(ws)) {
	out({ pass: 0, total: 1, summary: "no workspace dir given" });
	process.exit(0);
}
const src = path.join(ws, "src", "gold.py");
if (!fs.existsSync(src)) {
	out({ pass: 0, total: 1, summary: "src/gold.py missing" });
	process.exit(0);
}
const checks = interfaceChecks(src);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gold-"));
try {
	const exp = path.join(scratch, "expected.duckdb");
	const act = path.join(scratch, "actual.duckdb");
	const ref = runGold(ws, REFERENCE, exp);
	if (ref.status !== 0) checks.push({ ok: false, label: `reference failed (oracle bug): ${ref.tail}` });
	const r = runGold(ws, src, act);
	checks.push({ ok: r.status === 0, label: `src/gold.py exits 0 (exit ${r.status}${r.status === 0 ? "" : `: ${r.tail}`})` });
	if (ref.status === 0 && r.status === 0) {
		const res = runChecker(ws, exp, act);
		if (!res) checks.push({ ok: false, label: "gold_check.py produced no result" });
		else for (const c of res.checks) checks.push({ ok: c.ok, label: `${c.table}/${c.name}: ${c.detail}` });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.ok).map((c) => c.label);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${checks.length - failed.length}/${checks.length} gold checks${failed.length ? `; failing: ${failed.slice(0, 12).join(" | ")}` : ""}`;
out({ pass: checks.length - failed.length, total: checks.length, summary: summary.slice(0, 4000) });
