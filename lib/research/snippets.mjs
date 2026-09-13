// Computations as evidence: a claim may carry a small Python snippet and the value it
// prints; the checker re-runs it and compares. The snippet is model-written code run
// host-side, so it runs in isolated mode, in a scratch directory, with a reduced
// environment and a 10 s limit, after a deny-list on filesystem, process and network
// modules. That is a tripwire, not a sandbox — the same code already ran inside the
// guarded workspace when the worker wrote it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// `sys` stays allowed: the rows arrive on sys.stdin. A bare `import json, sys` is fine;
// every module in the list is refused in both import forms, and any comma list that
// names one of them is caught by the second alternative.
const DENY = /\b(import\s+(os|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing)\b|import\s+[^\n]*,\s*(os|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing)\b|from\s+(os|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing)\b|__import__|open\s*\(|eval\s*\(|exec\s*\(|compile\s*\(|globals\s*\(|breakpoint\s*\()/;
export const MAX_SNIPPET_CHARS = 4000;

export function checkSnippet(code) {
	if (typeof code !== "string" || !code.trim()) return { ok: false, reason: "empty snippet" };
	if (code.length > MAX_SNIPPET_CHARS) return { ok: false, reason: `snippet over ${MAX_SNIPPET_CHARS} chars` };
	const m = DENY.exec(code);
	if (m) return { ok: false, reason: `snippet uses a refused construct: ${m[0].trim()}` };
	return { ok: true };
}

const WITH = "numpy,scipy";
const baseEnv = (dir) => ({ PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: dir, TMP: dir, USERPROFILE: process.env.USERPROFILE ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", APPDATA: process.env.APPDATA ?? "", ...(process.env.UV_CACHE_DIR ? { UV_CACHE_DIR: process.env.UV_CACHE_DIR } : {}), PYTHONIOENCODING: "utf-8" });
let warmed = false;
/** Resolve the numpy/scipy environment once (uv caches it) so the 10 s limit measures the snippet, not the install. */
export function warmEnvironment() {
	if (warmed) return true;
	const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with", WITH, "python", "-I", "-c", "import numpy, scipy"], { encoding: "utf8", timeout: 600_000, env: baseEnv(os.tmpdir()), stdio: ["ignore", "pipe", "pipe"] });
	warmed = r.status === 0;
	return warmed;
}

/**
 * runSnippet(code, { rows, timeoutMs }) → { ok, stdout, error }
 * `rows` (any JSON) arrives on stdin (`json.load(sys.stdin)`); the snippet prints one
 * JSON line. numpy and scipy are available; `sys` and `json` may be imported.
 */
export function runSnippet(code, { rows = null, timeoutMs = 10_000 } = {}) {
	const check = checkSnippet(code);
	if (!check.ok) return { ok: false, stdout: "", error: check.reason };
	if (!warmEnvironment()) return { ok: false, stdout: "", error: "the numpy/scipy environment could not be prepared" };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-snippet-"));
	try {
		const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with", WITH, "python", "-I", "-c", code], { cwd: dir, encoding: "utf8", timeout: timeoutMs, env: baseEnv(dir), input: JSON.stringify(rows ?? null), stdio: ["pipe", "pipe", "pipe"] });
		if (r.error) return { ok: false, stdout: r.stdout ?? "", error: r.error.code === "ETIMEDOUT" ? `snippet exceeded ${timeoutMs / 1000} s` : String(r.error.message) };
		if (r.status !== 0) return { ok: false, stdout: r.stdout ?? "", error: (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 400) };
		return { ok: true, stdout: (r.stdout ?? "").trim(), error: null };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Compare a printed JSON value with the expected one: numbers within tolerance, else deep equality. */
export function valuesMatch(printed, expected, { rel = 1e-4, abs = 1e-6 } = {}) {
	let got;
	try {
		got = JSON.parse(String(printed).trim().split("\n").pop());
	} catch {
		return { ok: false, reason: `snippet printed no JSON: ${String(printed).slice(0, 120)}` };
	}
	const same = (a, b) => {
		if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
		if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
		if (a && b && typeof a === "object" && typeof b === "object") {
			const ka = Object.keys(a).sort();
			const kb = Object.keys(b).sort();
			return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]));
		}
		return a === b;
	};
	return same(got, expected) ? { ok: true, got } : { ok: false, got, reason: `printed ${JSON.stringify(got).slice(0, 160)} but expected ${JSON.stringify(expected).slice(0, 160)}` };
}
