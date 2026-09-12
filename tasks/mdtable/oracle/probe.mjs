#!/usr/bin/env node
// Probe runner for the `mdtable` task.
//
// usage:  node probe.mjs <workDir> < cases.json
//   workDir  directory containing src/mdtable.mjs (the supervisor copies BUILDER's
//            current src/ there). Imported dynamically at runtime.
// stdin:  JSON array of cases: { id, fn, args }
//   fn     one of: renderTable | parseTable
//   args   positional argument list, e.g. [header, rows, options] for renderTable
//          or [text] for parseTable.
// stdout: JSON array of { id, ok: true, value } or { id, ok: false, error }.
// Any failure to load the workspace or parse stdin yields a single-item error array,
// never an uncaught crash. Exit code is always 0 unless stdout itself cannot be written.

import path from "node:path";
import { pathToFileURL } from "node:url";

const FUNCTIONS = ["renderTable", "parseTable"];

function errorString(e) {
	const name = e && e.name ? e.name : "Error";
	const message = e && e.message ? e.message : String(e);
	return `${name}: ${message}`;
}

function emit(results) {
	process.stdout.write(JSON.stringify(results) + "\n");
}

// ---- load workspace ---------------------------------------------------------------

const workDir = process.argv[2];
if (!workDir) {
	emit([{ id: null, ok: false, error: "probe: missing work directory argument (argv[2])" }]);
	process.exit(0);
}

let mod;
try {
	const file = path.join(path.resolve(workDir), "src", "mdtable.mjs");
	mod = await import(pathToFileURL(file).href);
} catch (e) {
	emit([{ id: null, ok: false, error: `probe: failed to import src/mdtable.mjs from ${workDir}: ${errorString(e)}` }]);
	process.exit(0);
}

// ---- read cases ---------------------------------------------------------------------

let cases;
try {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	cases = JSON.parse(input.trim() === "" ? "[]" : input);
	if (!Array.isArray(cases)) throw new Error("stdin must be a JSON array of cases");
} catch (e) {
	emit([{ id: null, ok: false, error: `probe: bad input: ${errorString(e)}` }]);
	process.exit(0);
}

// ---- run ------------------------------------------------------------------------------

const results = [];
for (const c of cases) {
	const id = c && typeof c === "object" ? (c.id ?? null) : null;
	try {
		if (!c || typeof c !== "object") throw new Error("probe: each case must be an object");
		if (!FUNCTIONS.includes(c.fn)) throw new Error(`probe: fn must be one of ${FUNCTIONS.join(", ")}`);
		const fn = mod[c.fn];
		if (typeof fn !== "function") throw new Error(`probe: ${c.fn} is not exported`);
		const args = Array.isArray(c.args) ? c.args : [];
		const value = fn(...args);
		results.push({ id, ok: true, value });
	} catch (e) {
		results.push({ id, ok: false, error: errorString(e) });
	}
}
emit(results);
