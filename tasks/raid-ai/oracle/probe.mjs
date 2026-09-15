#!/usr/bin/env node
// Probe runner shared by the raid follow-on tasks (raid-gear, raid-save, raid-timeline,
// raid-arena, raid-ai): executes the orchestrator's calls host-side against the
// workspace's actual current src/. The task's own module is src/<name>.mjs where
// <name> is the task directory name without the "raid-" prefix; the given v1 core is
// src/raid.mjs.
//
// argv[2]: a work directory containing a fresh copy of the workspace's src/.
// stdin:  JSON array of cases: { id, fn, args, expect?, tol? }
//   fn    an export of the task module (e.g. "gearStats"), or "raid.<name>" for an
//         export of src/raid.mjs (e.g. "raid.runBattle").
//   args  positional argument list; an argument may be a descriptor instead of a value:
//           { "$rng": 1 }                    -> raid.mulberry32(1)
//           { "$champ": "kael" }             -> raid.makeChampion(sample def)   (probe's own copy of the def)
//           { "$champ": "kael", "level": 5 } -> raid.makeChampion(def, 5)
//           { "$champ": "kael", "hp": 700 }  -> the champion with hp overridden
//           { "$def": "kael" }               -> the raw sample def
//           { "$js": "raid.runBattle([raid.makeChampion(SAMPLE.kael)], [raid.makeChampion(SAMPLE.grim)], 1)" }
//                                            -> any expression; SAMPLE (the defs), raid and mod (the task module) in scope
//         Special numbers may be written as strings: "NaN", "Infinity", "-Infinity".
//   expect (optional) expected value; compared with tolerance `tol` (default 1e-9), deep
//         over arrays/objects (only the keys present in `expect` are compared).
// stdout: JSON array of { id, ok: true, value, match?, diff? } or { id, ok: false, error }.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.basename(path.dirname(here)).replace(/^raid-/, "");
const workDir = process.argv[2];
const load = async (file) => import(`file://${path.join(workDir, "src", file).replace(/\\/g, "/")}`);

let raid;
let mod;
try {
	raid = await load("raid.mjs");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/raid.mjs: ${err.message}` }]));
	process.exit(0);
}
try {
	mod = await load(`${MAIN}.mjs`);
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/${MAIN}.mjs: ${err.message}` }]));
	process.exit(0);
}

const SAMPLE = {
	kael: { id: "kael", name: "Kael the Ember", affinity: "force", rarity: "epic", base: { hp: 1500, atk: 130, def: 90, spd: 104, crit: 0.3, critDmg: 1.6 }, skills: [{ name: "Cinder Cut", multiplier: 1.0, cooldown: 0, target: "enemy" }, { name: "Flame Wall", multiplier: 0.7, cooldown: 3, target: "allEnemies" }, { name: "Ignite", multiplier: 1.8, cooldown: 4, target: "enemy", effects: [{ stat: "def", pct: -30, turns: 2 }] }] },
	vell: { id: "vell", name: "Sister Vell", affinity: "spirit", rarity: "rare", base: { hp: 1250, atk: 95, def: 120, spd: 98, crit: 0.15, critDmg: 1.5 }, skills: [{ name: "Censer Strike", multiplier: 1.0, cooldown: 0, target: "enemy" }, { name: "Litany", multiplier: 0, cooldown: 3, target: "allAllies", effects: [{ stat: "atk", pct: 25, turns: 2 }] }] },
	grim: { id: "grim", name: "Grimjaw", affinity: "magic", rarity: "rare", base: { hp: 1800, atk: 110, def: 100, spd: 91, crit: 0.2, critDmg: 1.5 }, skills: [{ name: "Maul", multiplier: 1.1, cooldown: 0, target: "enemy" }, { name: "Bellow", multiplier: 0, cooldown: 4, target: "self", effects: [{ stat: "def", pct: 40, turns: 3 }] }] },
	nyx: { id: "nyx", name: "Nyx of the Hollow", affinity: "void", rarity: "legendary", base: { hp: 1400, atk: 150, def: 85, spd: 110, crit: 0.35, critDmg: 1.7 }, skills: [{ name: "Shade Lash", multiplier: 1.0, cooldown: 0, target: "enemy" }, { name: "Hollow Step", multiplier: 0, cooldown: 4, target: "self", effects: [{ stat: "spd", pct: 30, turns: 2 }] }, { name: "Oblivion", multiplier: 2.2, cooldown: 5, target: "enemy" }] },
};
const clone = (v) => JSON.parse(JSON.stringify(v));

function decode(v) {
	if (v === "NaN") return NaN;
	if (v === "Infinity") return Infinity;
	if (v === "-Infinity") return -Infinity;
	if (Array.isArray(v)) return v.map(decode);
	if (v && typeof v === "object") {
		if ("$rng" in v) return raid.mulberry32(decode(v.$rng));
		if ("$def" in v) {
			if (!(v.$def in SAMPLE)) throw new Error(`probe: unknown $def ${v.$def}`);
			return clone(SAMPLE[v.$def]);
		}
		if ("$champ" in v) {
			if (!(v.$champ in SAMPLE)) throw new Error(`probe: unknown $champ ${v.$champ}`);
			const c = v.level != null ? raid.makeChampion(clone(SAMPLE[v.$champ]), decode(v.level)) : raid.makeChampion(clone(SAMPLE[v.$champ]));
			const extra = Object.keys(v).filter((k) => k !== "$champ" && k !== "level");
			return extra.length ? { ...c, ...Object.fromEntries(extra.map((k) => [k, decode(v[k])])) } : c;
		}
		if ("$js" in v) {
			const body = new Function("SAMPLE", "raid", "mod", `"use strict"; return (${v.$js});`);
			return body(clone(SAMPLE), raid, mod);
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
	if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), encode(x)]));
	if (v instanceof Set) return [...v].map(encode);
	if (Array.isArray(v)) return v.map(encode);
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v)) out[k] = encode(v[k]);
		return out;
	}
	return v;
}

function compare(actual, expected, tol, at = "$") {
	if (typeof expected === "number") {
		if (typeof actual !== "number") return `${at}: expected number, got ${typeof actual}`;
		if (Number.isNaN(expected)) return Number.isNaN(actual) ? null : `${at}: expected NaN, got ${actual}`;
		if (!Number.isFinite(expected)) return actual === expected ? null : `${at}: expected ${expected}, got ${actual}`;
		const d = Math.abs(actual - expected);
		return d <= tol ? null : `${at}: |${actual} - ${expected}| = ${d} > ${tol}`;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return `${at}: expected array`;
		if (actual.length !== expected.length) return `${at}: length ${actual.length} != ${expected.length}`;
		for (let i = 0; i < expected.length; i++) {
			const r = compare(actual[i], expected[i], tol, `${at}[${i}]`);
			if (r) return r;
		}
		return null;
	}
	if (expected && typeof expected === "object") {
		if (!actual || typeof actual !== "object") return `${at}: expected object`;
		for (const k of Object.keys(expected)) {
			if (!(k in actual)) return `${at}.${k}: missing`;
			const r = compare(actual[k], expected[k], tol, `${at}.${k}`);
			if (r) return r;
		}
		return null;
	}
	return Object.is(actual, expected) ? null : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
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
		if (typeof c.fn !== "string") throw new Error("probe: fn must be a string");
		const [m, name] = c.fn.startsWith("raid.") ? [raid, c.fn.slice(5)] : [mod, c.fn];
		const fn = m[name];
		if (typeof fn !== "function") throw new Error(`probe: ${c.fn} is not an exported function`);
		const args = Array.isArray(c.args) ? c.args.map(decode) : [];
		const value = fn(...args);
		const out = { id, ok: true, value: encode(value) };
		if ("expect" in c) {
			const diff = compare(encode(value), decode(c.expect), typeof c.tol === "number" ? c.tol : 1e-9);
			out.match = diff === null;
			if (diff) out.diff = diff;
		}
		results.push(out);
	} catch (e) {
		results.push({ id, ok: false, error: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}` });
	}
}
process.stdout.write(JSON.stringify(results) + "\n");
