#!/usr/bin/env node
/**
 * Probe runner for the bucket task — executes CRITIC's test scripts directly
 * against BUILDER's actual src/bucket.mjs, host-side. BUILDER is never in this
 * loop; the values reported back are real, not self-reported.
 *
 * Input (stdin): JSON array of {id, script}, where `script` is a JS snippet
 * evaluated as a function body with `createBucket` in scope. The snippet
 * must `return` a JSON-serialisable value. Example:
 *   {
 *     "id": "1",
 *     "script": "const b = createBucket({capacity:2, refillPerSecond:1}); return [b.take(1,0), b.take(2,0), b.available(1500)];"
 *   }
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

const modPath = path.join(workDir, "src", "bucket.mjs");
let createBucket;
try {
	({ createBucket } = await import(`file://${modPath.replace(/\\/g, "/")}`));
} catch (err) {
	console.log(JSON.stringify(probes.map((p) => ({ id: p?.id ?? "?", ok: false, error: `failed to import src/bucket.mjs: ${err.message}` }))));
	process.exit(0);
}

const results = probes.map((p) => {
	const id = p?.id ?? "?";
	if (typeof p?.script !== "string") {
		return { id, ok: false, error: "each probe needs a string `script`" };
	}
	try {
		const fn = new Function("createBucket", p.script);
		const value = fn(createBucket);
		return { id, ok: true, value: value === undefined ? null : value };
	} catch (err) {
		return { id, ok: false, error: `${err.name}: ${err.message}` };
	}
});
console.log(JSON.stringify(results));
