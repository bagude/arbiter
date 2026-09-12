#!/usr/bin/env node
/**
 * Probe runner for the jsondiff task — executes CRITIC's test calls directly
 * against BUILDER's actual src/jsondiff.mjs, host-side. BUILDER is never in
 * this loop; the values reported back are real, not self-reported.
 *
 * Input (stdin): JSON array of {id, fn: "diff"|"apply"|"pointer", args}.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value} | {id, ok:false, error}
 */
import fs from "node:fs";
import path from "node:path";

const workDir = process.argv[2];
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: invalid probes JSON on stdin: ${err.message}` }]));
	process.exit(0);
}
if (!Array.isArray(probes)) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: "probe.mjs: probes must be a JSON array" }]));
	process.exit(0);
}

const modPath = path.join(workDir, "src", "jsondiff.mjs");
let mod;
try {
	mod = await import(`file://${modPath.replace(/\\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify(probes.map((p) => ({ id: p?.id ?? "?", ok: false, error: `failed to import src/jsondiff.mjs: ${err.message}` }))));
	process.exit(0);
}

const ALLOWED = new Set(["diff", "apply", "pointer"]);

const results = probes.map((p) => {
	const id = p?.id ?? "?";
	if (!ALLOWED.has(p?.fn)) {
		return { id, ok: false, error: `each probe needs fn: one of ${[...ALLOWED].join(", ")}` };
	}
	if (!Array.isArray(p?.args)) {
		return { id, ok: false, error: "each probe needs args: an array" };
	}
	const impl = mod[p.fn];
	if (typeof impl !== "function") {
		return { id, ok: false, error: `src/jsondiff.mjs does not export ${p.fn}` };
	}
	try {
		const value = impl(...p.args);
		return { id, ok: true, value };
	} catch (err) {
		return { id, ok: false, error: `${err.name}: ${err.message}` };
	}
});
console.log(JSON.stringify(results));
