#!/usr/bin/env node
/**
 * Probe runner for the tmpl task — executes CRITIC's test calls directly
 * against BUILDER's actual src/tmpl.mjs, host-side. BUILDER is never in this
 * loop; the values reported back are real, not self-reported.
 *
 * Input (stdin): JSON array of {id, args: [template, data]}.
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

const modPath = path.join(workDir, "src", "tmpl.mjs");
let render;
try {
	({ render } = await import(`file://${modPath.replace(/\\/g, "/")}`));
} catch (err) {
	console.log(JSON.stringify(probes.map((p) => ({ id: p?.id ?? "?", ok: false, error: `failed to import src/tmpl.mjs: ${err.message}` }))));
	process.exit(0);
}

const results = probes.map((p) => {
	const id = p?.id ?? "?";
	if (!Array.isArray(p?.args) || p.args.length !== 2) {
		return { id, ok: false, error: "each probe needs args: [template, data]" };
	}
	try {
		const value = render(p.args[0], p.args[1]);
		return { id, ok: true, value };
	} catch (err) {
		return { id, ok: false, error: `${err.name}: ${err.message}` };
	}
});
console.log(JSON.stringify(results));
