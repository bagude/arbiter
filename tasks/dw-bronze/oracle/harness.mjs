/**
 * Shared plumbing for the dw-bronze oracle and probe: run the candidate with uv,
 * run the Python checker, and apply the interface rules from contract-bronze.md §4.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Inputs (remote/, requirements.txt) always come from the task's pristine workspace:
// the supervisor runs probes in a scratch dir holding only the candidate's src/, and a
// candidate must not be able to grade itself against inputs it edited.
const here = path.dirname(fileURLToPath(import.meta.url));
export const TASK_WS = path.join(here, "..", "ws-builder");

// A relative workspace path would be resolved by uv against cwd (= the workspace) — resolve it once here.
const abs = (ws) => path.resolve(ws);

export const REQ = "requirements.txt";
export const MAX_LINES = 250;
export const FORBIDDEN = ["requests", "httpx", "urllib", "socket", "ftplib", "http.client", "subprocess", "aiohttp", "os.system"];

export function uvArgs(ws) {
	return ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(TASK_WS, REQ), "python"];
}

export function runCandidate(ws, src, outDir, states = null) {
	ws = abs(ws);
	const args = [...uvArgs(ws), src, "--remote", path.join(TASK_WS, "remote"), "--out", outDir, "--pull-date", "2026-02-11"];
	if (states) args.push("--states", ...states);
	const r = spawnSync("uv", args, { cwd: TASK_WS, encoding: "utf8", timeout: 40_000 });
	const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
	return { status: r.status ?? -1, tail: r.error ? `${r.error.message} ${tail}` : tail };
}

export function runChecker(checker, args) {
	const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with", "openpyxl==3.1.5", "python", checker, ...args], { encoding: "utf8", timeout: 40_000 });
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

/** Size and no-network rules: cheap static checks the oracle can state exactly. */
export function interfaceChecks(src) {
	const text = fs.readFileSync(src, "utf8");
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
	const checks = [{ ok: lines.length <= MAX_LINES, label: `src/bronze.py is at most ${MAX_LINES} code lines (${lines.length})` }];
	const hits = FORBIDDEN.filter((m) => new RegExp(`(^|\\n)\\s*(import\\s+${m.replace(".", "\\.")}\\b|from\\s+${m.replace(".", "\\.")}\\b)|${m.replace(".", "\\.")}\\(`).test(text));
	checks.push({ ok: hits.length === 0, label: `no network/process modules (${hits.length ? hits.join(", ") : "none found"})` });
	return checks;
}
