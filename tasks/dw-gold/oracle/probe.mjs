#!/usr/bin/env node
/**
 * Probe for dw-gold: compare one gold table of the candidate's build with the
 * reference's.
 *
 * Input (stdin): JSON array of {id, args: ["<table>"]} with table in
 *   production_monthly | decline_curve_inputs | wells | completions.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value:{table, pass, total, failed:[...]}} | {id, ok:false, error}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFERENCE, runChecker, runGold } from "./harness.mjs";

const TABLES = ["production_monthly", "decline_curve_inputs", "wells", "completions"];
const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const src = path.join(ws, "src", "gold.py");
const results = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gold-probe-"));
try {
	let ran = null;
	for (const p of probes) {
		const id = p?.id ?? "?";
		const table = Array.isArray(p?.args) ? p.args[0] : undefined;
		if (!TABLES.includes(table)) {
			results.push({ id, ok: false, error: `args must be ["<table>"] with table in ${TABLES.join(", ")}` });
			continue;
		}
		if (!fs.existsSync(src)) {
			results.push({ id, ok: false, error: "src/gold.py missing" });
			continue;
		}
		if (!ran) {
			const exp = path.join(scratch, "expected.duckdb");
			const act = path.join(scratch, "actual.duckdb");
			runGold(ws, REFERENCE, exp);
			ran = { exp, act, r: runGold(ws, src, act) };
		}
		if (ran.r.status !== 0) {
			results.push({ id, ok: true, value: { table, pass: 0, total: 1, failed: [`gold.py exited ${ran.r.status}: ${ran.r.tail}`] } });
			continue;
		}
		const res = runChecker(ws, ran.exp, ran.act, ["--tables", table]);
		if (!res) results.push({ id, ok: false, error: "checker produced no result" });
		else results.push({ id, ok: true, value: { table, pass: res.pass, total: res.total, failed: res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) } });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
