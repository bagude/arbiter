/**
 * Shared plumbing for the dw-gold oracle and probe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REFERENCE = path.join(here, "reference", "gold.py");
export const CHECKER = path.join(here, "gold_check.py");
export const MAX_LINES = 300;
export const FORBIDDEN = ["requests", "httpx", "urllib", "socket", "ftplib", "subprocess", "os.system"];

function uv(ws, extra) {
	return spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(ws, "requirements.txt"), "python", ...extra], { cwd: ws, encoding: "utf8", timeout: 45_000 });
}

export function runGold(ws, script, outFile) {
	const r = uv(ws, [script, "--silver", path.join(ws, "data", "silver"), "--out", outFile, "--county-cycle", path.join(ws, "data", "reference", "OG_COUNTY_CYCLE.dsv")]);
	const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
	return { status: r.status ?? -1, tail: r.error ? `${r.error.message} ${tail}` : tail };
}

export function runChecker(ws, expected, actual, extra = []) {
	const r = uv(ws, [CHECKER, "--expected", expected, "--actual", actual, "--silver", path.join(ws, "data", "silver"), "--county-cycle", path.join(ws, "data", "reference", "OG_COUNTY_CYCLE.dsv"), ...extra]);
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

export function interfaceChecks(src) {
	const text = fs.readFileSync(src, "utf8");
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
	const checks = [{ ok: lines.length <= MAX_LINES, label: `src/gold.py is at most ${MAX_LINES} code lines (${lines.length})` }];
	const hits = FORBIDDEN.filter((m) => new RegExp(`(^|\\n)\\s*(import\\s+${m.replace(".", "\\.")}\\b|from\\s+${m.replace(".", "\\.")}\\b)|${m.replace(".", "\\.")}\\(`).test(text));
	checks.push({ ok: hits.length === 0, label: `no network/process modules (${hits.length ? hits.join(", ") : "none found"})` });
	return checks;
}
