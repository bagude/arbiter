#!/usr/bin/env node
// Probe runner for `raid-tests`. Executes host-side against the workspace's current
// src/. Cases (JSON array on stdin, `{ id, fn, args, expect?, tol? }`):
//   fn "runSuite"          — runs src/raid.test.mjs against the given src/raid.mjs;
//                            value: { ran, pass, fail, failing: [test names] }
//   fn "raid.<export>"     — calls an export of src/raid.mjs with `args` (descriptors:
//                            {"$rng": seed}, {"$champ": "kael", "level"?: n, ...overrides},
//                            {"$def": "kael"}, {"$js": "<expression>"} with SAMPLE and raid in scope)
// The planted bugs are hidden; there is no way to run the suite against them here.
// stdout: JSON array of { id, ok: true, value, match?, diff? } or { id, ok: false, error }.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workDir = process.argv[2];
const load = async (file) => import(`file://${path.join(workDir, "src", file).replace(/\\/g, "/")}`);
let raid;
try {
	raid = await load("raid.mjs");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `failed to import src/raid.mjs: ${err.message}` }]));
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
		if ("$def" in v) return clone(SAMPLE[v.$def]);
		if ("$champ" in v) {
			const c = v.level != null ? raid.makeChampion(clone(SAMPLE[v.$champ]), decode(v.level)) : raid.makeChampion(clone(SAMPLE[v.$champ]));
			const extra = Object.keys(v).filter((k) => k !== "$champ" && k !== "level");
			return extra.length ? { ...c, ...Object.fromEntries(extra.map((k) => [k, decode(v[k])])) } : c;
		}
		if ("$js" in v) return new Function("SAMPLE", "raid", `"use strict"; return (${v.$js});`)(clone(SAMPLE), raid);
		const out = {};
		for (const k of Object.keys(v)) out[k] = decode(v[k]);
		return out;
	}
	return v;
}
function encode(v) {
	if (typeof v === "number") return Number.isNaN(v) ? "NaN" : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : v;
	if (typeof v === "function") return "[function]";
	if (Array.isArray(v)) return v.map(encode);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).map((k) => [k, encode(v[k])]));
	return v;
}
function compare(actual, expected, tol, at = "$") {
	if (typeof expected === "number") {
		if (typeof actual !== "number") return `${at}: expected number, got ${typeof actual}`;
		if (!Number.isFinite(expected)) return Object.is(actual, expected) ? null : `${at}: expected ${expected}, got ${actual}`;
		return Math.abs(actual - expected) <= tol ? null : `${at}: |${actual} - ${expected}| > ${tol}`;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) return `${at}: array length/shape differs`;
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

function runSuite() {
	const suitePath = path.join(workDir, "src", "raid.test.mjs");
	if (!fs.existsSync(suitePath)) throw new Error("src/raid.test.mjs does not exist");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-raid-tests-probe-"));
	try {
		fs.mkdirSync(path.join(scratch, "src"));
		fs.copyFileSync(path.join(workDir, "src", "raid.mjs"), path.join(scratch, "src", "raid.mjs"));
		fs.copyFileSync(suitePath, path.join(scratch, "src", "raid.test.mjs"));
		const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "src/raid.test.mjs"], { cwd: scratch, encoding: "utf8", timeout: 40_000 });
		const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		const pass = Number(/^# pass (\d+)/m.exec(text)?.[1] ?? 0);
		const fail = Number(/^# fail (\d+)/m.exec(text)?.[1] ?? 0);
		const failing = (text.match(/^not ok \d+ - (.*)$/gm) ?? []).map((l) => l.replace(/^not ok \d+ - /, ""));
		const loadError = pass + fail === 0 ? text.split("\n").filter((l) => /Error|error/.test(l)).slice(0, 3).join(" | ").slice(0, 300) : undefined;
		return { ran: pass + fail, pass, fail, failing, ...(loadError ? { loadError } : {}) };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let cases;
try {
	cases = JSON.parse(input || "[]");
	if (!Array.isArray(cases)) throw new Error("stdin must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: invalid probes JSON on stdin: ${err.message}` }]));
	process.exit(0);
}
const results = [];
for (const c of cases) {
	const id = c?.id;
	try {
		let value;
		if (c.fn === "runSuite") value = runSuite();
		else if (typeof c.fn === "string" && c.fn.startsWith("raid.")) {
			const fn = raid[c.fn.slice(5)];
			if (typeof fn !== "function") throw new Error(`${c.fn} is not an exported function`);
			value = fn(...(Array.isArray(c.args) ? c.args.map(decode) : []));
		} else throw new Error(`fn must be "runSuite" or "raid.<export>", got ${JSON.stringify(c.fn)}`);
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
