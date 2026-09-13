#!/usr/bin/env node
/**
 * Probe for dw-water-bench.
 *   {id, args: ["header", "<file under data/>"]}  -> the header's columns and whether a water column exists
 *   {id, args: ["finding"]}                       -> every benchmark rule against the current src/finding.json
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import path from "node:path";
import { checkFinding, readHeader, TASK_WS } from "./checks.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, arg] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "header") {
		const rel = String(arg ?? "").replace(/\\/g, "/");
		if (!rel.startsWith("data/")) return { id, ok: false, error: 'args: ["header", "data/<file>"]' };
		const file = path.join(TASK_WS, rel);
		if (!fs.existsSync(file)) return { id, ok: false, error: `no such file ${rel}` };
		const h = readHeader(file);
		return { id, ok: true, value: { file: rel, columns: h.columns, has_water_column: h.hasWater } };
	}
	if (kind === "finding") {
		let finding;
		try {
			finding = JSON.parse(fs.readFileSync(path.join(ws, "src", "finding.json"), "utf8"));
		} catch (e) {
			return { id, ok: true, value: { valid: false, error: `src/finding.json missing or invalid: ${e.message}` } };
		}
		const checks = checkFinding(finding);
		return { id, ok: true, value: { pass: checks.filter((c) => c.ok).length, total: checks.length, failing: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) } };
	}
	return { id, ok: false, error: 'args must be ["header", "data/<file>"] or ["finding"]' };
});
console.log(JSON.stringify(results));
