#!/usr/bin/env node
/**
 * Probe for dw-silver: compare one (table, state) of the candidate's output with the
 * reference's — the orchestrator's real-value verification channel.
 *
 * Input (stdin): JSON array of {id, args: ["<table>", "<STATE>"]}, e.g. ["production", "NM"].
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value:{table, state, pass, total, failed:[...]}} | {id, ok:false, error}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFERENCE, runChecker, runSilver } from "./harness.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const TABLES = { TX: ["wells", "production"], NM: ["wells", "production"], OK: ["wells", "completions"] };
const src = path.join(ws, "src", "silver.py");
const results = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-silver-probe-"));
try {
	let ran = null; // run both once, for all states, then answer every probe from it
	for (const p of probes) {
		const id = p?.id ?? "?";
		const [table, state] = Array.isArray(p?.args) ? p.args : [];
		if (!TABLES[state] || !TABLES[state].includes(table)) {
			results.push({ id, ok: false, error: `args must be ["<table>", "<STATE>"] with table in ${JSON.stringify(TABLES)}` });
			continue;
		}
		if (!fs.existsSync(src)) {
			results.push({ id, ok: false, error: "src/silver.py missing" });
			continue;
		}
		if (!ran) {
			const exp = path.join(scratch, "expected");
			const act = path.join(scratch, "actual");
			runSilver(ws, REFERENCE, exp);
			const r = runSilver(ws, src, act);
			ran = { exp, act, r };
		}
		if (ran.r.status !== 0) {
			results.push({ id, ok: true, value: { table, state, pass: 0, total: 1, failed: [`silver.py exited ${ran.r.status}: ${ran.r.tail}`] } });
			continue;
		}
		const res = runChecker(ws, ran.exp, ran.act, ["--tables", table, "--states", state]);
		if (!res) results.push({ id, ok: false, error: "checker produced no result" });
		else results.push({ id, ok: true, value: { table, state, pass: res.pass, total: res.total, failed: res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) } });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
