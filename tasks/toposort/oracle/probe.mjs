#!/usr/bin/env node
/**
 * Probe runner for the toposort task — executes CRITIC's calls directly
 * against BUILDER's actual src/toposort.mjs, host-side. BUILDER is never in
 * this loop; the values reported back are real, not self-reported.
 *
 * Input (stdin): JSON array of {id, fn: "topoSort"|"layers"|"findCycle", args}.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value} | {id, ok:false, error: "<Name>: <message>"}
 */
import path from "node:path";

const workDir = process.argv[2];
const FUNCTIONS = ["topoSort", "layers", "findCycle"];

let mod;
try {
	const modPath = path.join(workDir, "src", "toposort.mjs");
	mod = await import(`file://${modPath.replace(/\\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/toposort.mjs: ${err.message}` }]));
	process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let probes;
try {
	probes = JSON.parse(input || "[]");
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: invalid probes JSON on stdin: ${err.message}` }]));
	process.exit(0);
}

const results = probes.map((p) => {
	const id = p?.id ?? "?";
	try {
		if (!FUNCTIONS.includes(p?.fn)) throw new Error(`fn must be one of ${FUNCTIONS.join(", ")}`);
		const fn = mod[p.fn];
		if (typeof fn !== "function") throw new Error(`${p.fn} is not exported`);
		const args = Array.isArray(p?.args) ? p.args : [];
		const value = fn(...args);
		return { id, ok: true, value: value === undefined ? null : value };
	} catch (err) {
		const name = err && err.name ? err.name : "Error";
		const message = err && err.message ? err.message : String(err);
		return { id, ok: false, error: `${name}: ${message}` };
	}
});
console.log(JSON.stringify(results));
