#!/usr/bin/env node
/**
 * Probe for dw-explore.
 *   {id, args: ["query", "<sql>"]}         -> rows (≤ 50) of a read-only query against the warehouse, or the error
 *   {id, args: ["observation", "<id>"]}    -> reproduction result for one observation of src/exploration.json
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
const results = probes.map((p) => {
	const id = p?.id ?? "?";
	const [kind, arg] = Array.isArray(p?.args) ? p.args : [];
	if (kind === "query") {
		if (typeof arg !== "string" || !arg.trim()) return { id, ok: false, error: 'args: ["query", "<sql>"]' };
		const res = runChecker(ws, ["--query", arg]);
		if (!res || (!("rows" in res) && !res.error)) return { id, ok: false, error: `checker failed: ${res?.error ?? ""}` };
		return res.error && res.rows == null ? { id, ok: true, value: { rows: null, error: res.error } } : { id, ok: true, value: { rows: res.rows } };
	}
	if (kind === "observation") {
		if (typeof arg !== "string" || !arg) return { id, ok: false, error: 'args: ["observation", "<observation id>"]' };
		const res = runChecker(ws, ["--observation", arg]);
		if (!res?.checks) return { id, ok: false, error: `checker failed: ${res?.error ?? ""}` };
		const c = res.checks[res.checks.length - 1];
		return { id, ok: true, value: { observation: arg, reproduces: c.ok, detail: c.detail } };
	}
	return { id, ok: false, error: 'args must be ["query", "<sql>"] or ["observation", "<id>"]' };
});
console.log(JSON.stringify(results));
