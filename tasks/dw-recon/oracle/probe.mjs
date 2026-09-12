#!/usr/bin/env node
/**
 * Probe for dw-recon.
 *   {id, args: ["kpi", "<STATE>"]}     -> the oracle's own KPI block for that state
 *   {id, args: ["finding", "<id>"]}    -> grounding result for one finding of src/health.json
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import { runChecker } from "./harness.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
let kpiCache = null;
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, arg] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "kpi") {
		if (!["TX", "NM", "OK"].includes(arg)) return { id, ok: false, error: 'args: ["kpi", "TX"|"NM"|"OK"]' };
		if (!kpiCache) kpiCache = runChecker(ws, ["--kpi-only"]);
		if (!kpiCache?.kpi) return { id, ok: false, error: `kpi computation failed: ${kpiCache?.error ?? ""}` };
		return { id, ok: true, value: { state: arg, kpi: kpiCache.kpi[arg] } };
	}
	if (kind === "finding") {
		if (typeof arg !== "string" || !arg) return { id, ok: false, error: 'args: ["finding", "<finding id>"]' };
		const res = runChecker(ws, ["--finding", arg]);
		if (!res?.checks) return { id, ok: false, error: `checker failed: ${res?.error ?? ""}` };
		const c = res.checks[res.checks.length - 1];
		return { id, ok: true, value: { finding: arg, grounded: c.ok, detail: c.detail } };
	}
	return { id, ok: false, error: 'args must be ["kpi", "<STATE>"] or ["finding", "<id>"]' };
});
console.log(JSON.stringify(results));
