#!/usr/bin/env node
// Probe runner for the `raid` task — executes the orchestrator's calls directly
// against the workspace's actual current src/raid.mjs and src/scene.mjs, host-side.
// The values reported back are real, not self-reported.
//
// argv[2]: a work directory containing a fresh copy of the workspace's src/.
// stdin:  JSON array of cases: { id, fn, args, expect?, tol? }
//   fn    an export of src/raid.mjs (e.g. "computeDamage", "runBattle") or of
//         src/scene.mjs prefixed "scene." (e.g. "scene.buildScene").
//   args  positional argument list. An argument may be a descriptor instead of a value:
//           { "$rng": 1 }                        -> mulberry32(1) from the workspace module
//           { "$champ": "kael" }                 -> makeChampion(SAMPLE_CHAMPIONS.kael) (probe's own copy of the def)
//           { "$champ": "kael", "level": 5 }     -> makeChampion(def, 5)
//           { "$champ": "kael", "hp": 700 }      -> the champion with hp overridden
//           { "$def": "kael" }                   -> the raw sample def
//           { "$js": "[1, 2].map(x => x * 2)" }  -> any expression (SAMPLE in scope as the defs)
//         Special numbers may be written as strings: "NaN", "Infinity", "-Infinity".
//   expect (optional) expected value; compared with tolerance `tol` (default 1e-9), deep
//         over arrays/objects (only the keys present in `expect` are compared).
// stdout: JSON array of { id, ok: true, value, match?, diff? } or { id, ok: false, error }.
// three.js objects in results are summarised as { name, type, position, visible, scale,
// color?, geometry?, userData?, children } to a depth of 4.

import path from "node:path";

const workDir = process.argv[2];
const load = async (file) => {
	const p = path.join(workDir, "src", file);
	return import(`file://${p.replace(/\\/g, "/")}`);
};

let raid;
try {
	raid = await load("raid.mjs");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/raid.mjs: ${err.message}` }]));
	process.exit(0);
}
let scene = null;
let sceneError = null;

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
		if ("$rng" in v) {
			if (typeof raid.mulberry32 !== "function") throw new Error("probe: $rng needs mulberry32 exported");
			return raid.mulberry32(decode(v.$rng));
		}
		if ("$def" in v) {
			if (!(v.$def in SAMPLE)) throw new Error(`probe: unknown $def ${v.$def}`);
			return clone(SAMPLE[v.$def]);
		}
		if ("$champ" in v) {
			if (!(v.$champ in SAMPLE)) throw new Error(`probe: unknown $champ ${v.$champ}`);
			if (typeof raid.makeChampion !== "function") throw new Error("probe: $champ needs makeChampion exported");
			const c = v.level != null ? raid.makeChampion(clone(SAMPLE[v.$champ]), decode(v.level)) : raid.makeChampion(clone(SAMPLE[v.$champ]));
			const extra = Object.keys(v).filter((k) => k !== "$champ" && k !== "level");
			return extra.length ? { ...c, ...Object.fromEntries(extra.map((k) => [k, decode(v[k])])) } : c;
		}
		if ("$js" in v) {
			const body = new Function("SAMPLE", "raid", `"use strict"; return (${v.$js});`);
			return body(clone(SAMPLE), raid);
		}
		const out = {};
		for (const k of Object.keys(v)) out[k] = decode(v[k]);
		return out;
	}
	return v;
}

function isObject3D(v) {
	return v && typeof v === "object" && v.isObject3D === true;
}
function summarise(o, depth) {
	const s = { name: o.name, type: o.type };
	if (o.position) s.position = o.position.toArray();
	s.visible = o.visible;
	if (o.scale) s.scale = o.scale.toArray();
	if (o.rotation) s.rotation = [o.rotation.x, o.rotation.y, o.rotation.z];
	if (o.material?.color) s.color = o.material.color.getHex();
	if (o.material?.type) s.material = o.material.type;
	if (o.geometry) s.geometry = { type: o.geometry.type, ...(o.geometry.parameters ? { parameters: o.geometry.parameters } : {}) };
	if (o.userData && Object.keys(o.userData).length) s.userData = o.userData;
	if (o.isScene && o.background?.getHex) s.background = o.background.getHex();
	if (o.isCamera) Object.assign(s, { fov: o.fov, aspect: o.aspect, near: o.near, far: o.far });
	if (depth > 0 && o.children?.length) s.children = o.children.map((c) => summarise(c, depth - 1));
	else if (o.children?.length) s.children = `${o.children.length} children (depth limit)`;
	return s;
}

function encode(v, depth = 0) {
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "NaN";
		if (v === Infinity) return "Infinity";
		if (v === -Infinity) return "-Infinity";
		return v;
	}
	if (typeof v === "function") return "[function]";
	if (isObject3D(v)) return summarise(v, 4);
	if (Array.isArray(v)) return v.map((x) => encode(x, depth + 1));
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v)) out[k] = encode(v[k], depth + 1);
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
		let mod = raid;
		let name = c.fn;
		if (name.startsWith("scene.")) {
			if (!scene && !sceneError) {
				try {
					scene = await load("scene.mjs");
				} catch (err) {
					sceneError = err.message;
				}
			}
			if (!scene) throw new Error(`failed to import src/scene.mjs: ${sceneError}`);
			mod = scene;
			name = name.slice("scene.".length);
		}
		const fn = mod[name];
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
		const name = e && e.name ? e.name : "Error";
		const message = e && e.message ? e.message : String(e);
		results.push({ id, ok: false, error: `${name}: ${message}` });
	}
}
process.stdout.write(JSON.stringify(results) + "\n");
