#!/usr/bin/env node
// Probe runner for the `lru` task — executes CRITIC's scripted calls directly
// against BUILDER's actual current src/lru.mjs, host-side. BUILDER is never in
// this loop; the values reported back are real, not self-reported.
//
// argv[2]: a work directory containing a fresh copy of BUILDER's src/ (the
//   supervisor sets this up per-probe, mirroring every other task's probe.mjs).
// stdin:  JSON array of cases: { id, script }
//   script  a snippet of JS source, run as the body of an async function with
//           `createLRU` (the module's export) and `clock` (a fresh { t: 0 }
//           object, unique per case) in scope. Drive TTL behaviour by passing
//           `now: () => clock.t` to createLRU and mutating `clock.t` between
//           calls. The snippet may `return` a value.
// stdout: one JSON line, an array of {id, ok:true, value} | {id, ok:false, error}.
//   Returned values are JSON-serialised: NaN/Infinity/-Infinity become the
//   strings "NaN"/"Infinity"/"-Infinity", `undefined` becomes "$undefined",
//   arrays/plain objects are serialised recursively, anything else is
//   passed through JSON.stringify as-is (or stringified as a last resort).

import path from "node:path";

const workDir = process.argv[2];
let mod;
try {
	const modPath = path.join(workDir, "src", "lru.mjs");
	mod = await import(`file://${modPath.replace(/\\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/lru.mjs: ${err.message}` }]));
	process.exit(0);
}

function encode(v) {
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "NaN";
		if (v === Infinity) return "Infinity";
		if (v === -Infinity) return "-Infinity";
		return v;
	}
	if (v === undefined) return "$undefined";
	if (typeof v === "function") return "[function]";
	if (Array.isArray(v)) return v.map(encode);
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v)) out[k] = encode(v[k]);
		return out;
	}
	return v;
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

const results = [];
for (const c of cases) {
	const id = c?.id ?? "?";
	try {
		if (typeof c?.script !== "string") throw new Error("probe: each case needs a string `script`");
		const clock = { t: 0 };
		const run = new Function("createLRU", "clock", `"use strict"; return (async () => {\n${c.script}\n})();`);
		const value = await run(mod.createLRU, clock);
		results.push({ id, ok: true, value: encode(value) });
	} catch (e) {
		const name = e && e.name ? e.name : "Error";
		const message = e && e.message ? e.message : String(e);
		results.push({ id, ok: false, error: `${name}: ${message}` });
	}
}
process.stdout.write(JSON.stringify(results) + "\n");
