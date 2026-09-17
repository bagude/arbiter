#!/usr/bin/env node
/**
 * Probe runner for the memtest task — calls the real `canary()` from the
 * builder's src/canary.mjs, host-side, so the orchestrator can verify what the
 * function actually returns instead of trusting the worker's report.
 *
 * Input (stdin): JSON array of {id, fn, args}; fn must be "canary".
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

const modPath = path.join(workDir, "src", "canary.mjs");
let mod;
try {
	mod = await import(`file://${modPath.replace(/\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify(probes.map((p) => ({ id: p?.id ?? "?", ok: false, error: `failed to import src/canary.mjs: ${err.message}` }))));
	process.exit(0);
}

const results = probes.map((p) => {
	const id = p?.id ?? "?";
	if (p?.fn !== "canary") return { id, ok: false, error: `unknown fn ${JSON.stringify(p?.fn)}; the only probeable function is "canary"` };
	if (typeof mod.canary !== "function") return { id, ok: false, error: "src/canary.mjs does not export a function named canary" };
	try {
		return { id, ok: true, value: mod.canary(...(Array.isArray(p.args) ? p.args : [])) };
	} catch (err) {
		return { id, ok: false, error: `${err?.constructor?.name ?? "Error"}: ${err?.message ?? err}` };
	}
});
console.log(JSON.stringify(results));
