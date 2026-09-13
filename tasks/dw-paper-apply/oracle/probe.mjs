#!/usr/bin/env node
/**
 * Probe for dw-paper-apply.
 *   {id, args: ["query", "<sql>"]}        -> rows (≤ 50) of a read-only query, or the error
 *   {id, args: ["observation", "<id>"]}   -> reproduction result for one observation of src/exploration.json
 *   {id, args: ["compute", "<id>"]}       -> re-run that observation's compute on its rows; printed vs expect
 * Output: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
 */
import fs from "node:fs";
import path from "node:path";
import { runChecker } from "./harness.mjs";
import { checkCompute, checkApply } from "./checks.mjs";

const ws = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
function observation(id) {
	const doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "exploration.json"), "utf8"));
	return (doc.observations ?? []).find((o) => o?.id === id) ?? null;
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
		let apply = [];
		try {
			const o = observation(arg);
			apply = o ? checkApply(o).filter((b) => !b.startsWith("compute:")) : ["no such observation"];
		} catch (e) {
			apply = [`exploration.json unreadable: ${e.message}`];
		}
		return { id, ok: true, value: { observation: arg, reproduces: c.ok && apply.length === 0, detail: [c.detail, ...apply].join("; ") } };
	}
	if (kind === "compute") {
		let o;
		try {
			o = observation(arg);
		} catch (e) {
			return { id, ok: true, value: { valid: false, error: `exploration.json unreadable: ${e.message}` } };
		}
		if (!o) return { id, ok: false, error: `no observation ${arg}` };
		const r = checkCompute(o);
		return { id, ok: true, value: { observation: arg, reproduces: r.ok, printed: r.printed ?? null, reason: r.reason ?? "matches expect" } };
	}
	return { id, ok: false, error: 'args must be ["query", "<sql>"], ["observation", "<id>"] or ["compute", "<id>"]' };
});
console.log(JSON.stringify(results));
