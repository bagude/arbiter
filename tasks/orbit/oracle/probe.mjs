#!/usr/bin/env node
// Probe runner for the `orbit` task — executes CRITIC's calls directly against
// BUILDER's actual current src/orbit.mjs, host-side. BUILDER is never in this
// loop; the values reported back are real, not self-reported.
//
// argv[2]: a work directory containing a fresh copy of BUILDER's src/ (the
//   supervisor sets this up per-probe, mirroring every other task's probe.mjs).
// stdin:  JSON array of cases: { id, fn, args, expect?, tol? }
//   fn    one of: gravityDeriv | rk4Step | integrate | invariants | simulateOrbit
//   args  positional argument list. Because rk4Step / integrate take a derivative
//         function, an argument may be a *descriptor* object instead of a value:
//           { "$fn": "gravityDeriv", "mu": 1 }      ->  (t, s) => gravityDeriv(s, mu)
//           { "$js": "[s[1], -s[0]]" }              ->  (t, s) => <expression>  (t and s in scope)
//           { "$const": [1, 2] }                    ->  (t, s) => [1, 2]
//         Special numbers may be written as strings: "NaN", "Infinity", "-Infinity".
//   expect (optional) expected value; compared numerically with tolerance `tol` (default 1e-9),
//         deep over arrays/objects. Result gets `match: true|false` and `diff` on mismatch.
// stdout: JSON array of { id, ok: true, value, match?, diff? } or { id, ok: false, error }.

import path from "node:path";

const workDir = process.argv[2];
let mod;
try {
	const modPath = path.join(workDir, "src", "orbit.mjs");
	mod = await import(`file://${modPath.replace(/\\/g, "/")}`);
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/orbit.mjs: ${err.message}` }]));
	process.exit(0);
}

const FUNCTIONS = ["gravityDeriv", "rk4Step", "integrate", "invariants", "simulateOrbit"];

function decode(v) {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if ("$fn" in v) {
      const name = v.$fn;
      if (!FUNCTIONS.includes(name)) throw new Error(`probe: unknown $fn ${name}`);
      const extra = Object.keys(v).filter((k) => k !== "$fn").map((k) => decode(v[k]));
      return (t, s) => mod[name](s, ...extra);
    }
    if ("$js" in v) {
      const body = new Function("t", "s", `"use strict"; return (${v.$js});`);
      return (t, s) => body(t, s);
    }
    if ("$const" in v) {
      const c = decode(v.$const);
      return () => (Array.isArray(c) ? c.slice() : c);
    }
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
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}

function compare(actual, expected, tol, path = "$") {
  if (typeof expected === "number") {
    if (typeof actual !== "number") return `${path}: expected number, got ${typeof actual}`;
    if (Number.isNaN(expected)) return Number.isNaN(actual) ? null : `${path}: expected NaN, got ${actual}`;
    if (!Number.isFinite(expected)) return actual === expected ? null : `${path}: expected ${expected}, got ${actual}`;
    const d = Math.abs(actual - expected);
    return d <= tol ? null : `${path}: |${actual} - ${expected}| = ${d} > ${tol}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected array`;
    if (actual.length !== expected.length) return `${path}: length ${actual.length} != ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const r = compare(actual[i], expected[i], tol, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return `${path}: expected object`;
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) return `${path}.${k}: missing`;
      const r = compare(actual[k], expected[k], tol, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
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
  const id = c?.id;
  try {
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
    const name = e && e.name ? e.name : "Error";
    const message = e && e.message ? e.message : String(e);
    results.push({ id, ok: false, error: `${name}: ${message}` });
  }
}
process.stdout.write(JSON.stringify(results) + "\n");
