#!/usr/bin/env node
/**
 * Probe runner for the semver task — executes CRITIC's calls directly against
 * BUILDER's actual src/semver.mjs, host-side. BUILDER is never in this loop;
 * the values reported back are real, not self-reported.
 *
 * argv[2]: a work directory containing a copy of BUILDER's src/.
 * stdin:  JSON array of { id, fn, args }
 *   fn    one of: parse | compare | satisfies
 *   args  positional argument list passed to the function.
 * stdout: one JSON line, an array of
 *   { id, ok: true, value } | { id, ok: false, error: "<Name>: <message>" }
 */
import path from "node:path";

const workDir = process.argv[2];
const FUNCTIONS = ["parse", "compare", "satisfies"];

let mod;
try {
	const modPath = path.join(workDir, "src", "semver.mjs");
	mod = await import(`file://${modPath.replace(/\\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/semver.mjs: ${err.message}` }]));
	process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

let cases;
try {
	cases = JSON.parse(input || "[]");
	if (!Array.isArray(cases)) throw new Error("probe: stdin must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: invalid probes JSON on stdin: ${err.message}` }]));
	process.exit(0);
}

const results = cases.map((c) => {
	const id = c?.id ?? "?";
	try {
		if (!FUNCTIONS.includes(c?.fn)) throw new Error(`probe: fn must be one of ${FUNCTIONS.join(", ")}`);
		const fn = mod[c.fn];
		if (typeof fn !== "function") throw new Error(`probe: ${c.fn} is not exported`);
		const args = Array.isArray(c.args) ? c.args : [];
		const value = fn(...args);
		return { id, ok: true, value };
	} catch (err) {
		const name = err && err.name ? err.name : "Error";
		const message = err && err.message ? err.message : String(err);
		return { id, ok: false, error: `${name}: ${message}` };
	}
});
console.log(JSON.stringify(results));
