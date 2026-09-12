/**
 * Shared plumbing for the dw-gold oracle and probe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// A relative workspace path would be resolved by uv against cwd (= the workspace) — resolve it once here.
const abs = (ws) => path.resolve(ws);

const here = path.dirname(fileURLToPath(import.meta.url));
// Inputs come from the task's pristine workspace (probes run in a scratch dir with only src/).
export const TASK_WS = path.join(here, "..", "ws-builder");
export const REFERENCE = path.join(here, "reference", "gold.py");
export const CHECKER = path.join(here, "gold_check.py");
export const MAX_LINES = 300;
export const FORBIDDEN = ["requests", "httpx", "urllib", "socket", "ftplib", "subprocess", "os.system"];

function uv(ws, extra) {
	ws = abs(ws);
	return spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(TASK_WS, "requirements.txt"), "python", ...extra], { cwd: TASK_WS, encoding: "utf8", timeout: 45_000 });
}

export function runGold(ws, script, outFile) {
	const r = uv(ws, [script, "--silver", path.join(TASK_WS, "data", "silver"), "--out", outFile, "--county-cycle", path.join(TASK_WS, "data", "reference", "OG_COUNTY_CYCLE.dsv")]);
	const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
	return { status: r.status ?? -1, tail: r.error ? `${r.error.message} ${tail}` : tail };
}

export function runChecker(ws, expected, actual, extra = []) {
	const r = uv(ws, [CHECKER, "--expected", expected, "--actual", actual, "--silver", path.join(TASK_WS, "data", "silver"), "--county-cycle", path.join(TASK_WS, "data", "reference", "OG_COUNTY_CYCLE.dsv"), ...extra]);
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
