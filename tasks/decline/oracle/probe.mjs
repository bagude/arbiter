// Probe runner for the `decline` task.
//
// usage:  node probe.mjs <workDir> < cases.json
//   workDir  directory containing src/decline.mjs (the supervisor copies BUILDER's
//            current src/ there). Imported dynamically at runtime.
// stdin:  JSON array of cases: { id, fn, args, expect?, tol? }
//   fn     one of: declineRate | cumulativeProduction | terminalSwitch | forecastAt | estimateEUR
//   args   positional argument list. Special numbers may be written as strings:
//          "NaN", "Infinity", "-Infinity".
//   expect (optional) expected value; compared numerically with tolerance `tol`
//          (default 1e-9, RELATIVE for numbers with |expected| > 1, absolute otherwise),
//          deep over arrays/objects. Result gets `match: true|false` and `diff` on mismatch.
// stdout: JSON array of { id, ok: true, value, match?, diff? } or { id, ok: false, error }.
// Any failure to load the workspace or parse stdin yields a single-item error array,
// never an uncaught crash. Exit code is always 0 unless stdout itself cannot be written.

import path from "node:path";
import { pathToFileURL } from "node:url";

const FUNCTIONS = ["declineRate", "cumulativeProduction", "terminalSwitch", "forecastAt", "estimateEUR"];

function decode(v) {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = decode(v[k]);
    return out;
  }
  return v;
}

function encode(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return v;
  }
  if (typeof v === "function") return "[function]";
  if (typeof v === "undefined") return "[undefined]";
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}

function compare(actual, expected, tol, p = "$") {
  if (typeof expected === "number") {
    if (typeof actual !== "number") return `${p}: expected number, got ${typeof actual}`;
    if (Number.isNaN(expected)) return Number.isNaN(actual) ? null : `${p}: expected NaN, got ${actual}`;
    if (!Number.isFinite(expected)) return actual === expected ? null : `${p}: expected ${expected}, got ${actual}`;
    const d = Math.abs(actual - expected);
    const bound = tol * Math.max(1, Math.abs(expected));
    return d <= bound ? null : `${p}: |${actual} - ${expected}| = ${d} > ${bound}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${p}: expected array`;
    if (actual.length !== expected.length) return `${p}: length ${actual.length} != ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const r = compare(actual[i], expected[i], tol, `${p}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return `${p}: expected object`;
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) return `${p}.${k}: missing`;
      const r = compare(actual[k], expected[k], tol, `${p}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : `${p}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

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
  const file = path.join(path.resolve(workDir), "src", "decline.mjs");
  mod = await import(pathToFileURL(file).href);
} catch (e) {
  emit([{ id: null, ok: false, error: `probe: failed to import src/decline.mjs from ${workDir}: ${errorString(e)}` }]);
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
  const id = c && typeof c === "object" ? c.id ?? null : null;
  try {
    if (!c || typeof c !== "object") throw new Error("probe: each case must be an object");
    if (!FUNCTIONS.includes(c.fn)) throw new Error(`probe: fn must be one of ${FUNCTIONS.join(", ")}`);
    const fn = mod[c.fn];
    if (typeof fn !== "function") throw new Error(`probe: ${c.fn} is not exported`);
    const args = Array.isArray(c.args) ? c.args.map(decode) : [];
    const value = fn(...args);
    const out = { id, ok: true, value: encode(value) };
    if ("expect" in c) {
      const diff = compare(value, decode(c.expect), typeof c.tol === "number" ? c.tol : 1e-9);
      out.match = diff === null;
      if (diff) out.diff = diff;
    }
    results.push(out);
  } catch (e) {
    results.push({ id, ok: false, error: errorString(e) });
  }
}
emit(results);
