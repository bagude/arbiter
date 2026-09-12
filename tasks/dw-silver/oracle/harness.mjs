/**
 * Shared plumbing for the dw-silver oracle and probe: run a silver implementation
 * (candidate or reference) with uv, run the Python checker, interface rules.
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
export const REFERENCE = path.join(here, "reference", "silver.py");
export const CHECKER = path.join(here, "silver_check.py");
export const LABELS = path.join(here, "labels.json");
export const MAX_LINES = 450;
export const FORBIDDEN = ["requests", "httpx", "urllib", "socket", "ftplib", "subprocess", "os.system"];

function uv(ws, extra, env = {}) {
	ws = abs(ws);
	return spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(TASK_WS, "requirements.txt"), "python", ...extra], { cwd: TASK_WS, encoding: "utf8", timeout: 45_000, env: { ...process.env, ...env } });
}

/** Run a silver script from the workspace (cwd = ws so contract/ resolves). */
export function runSilver(ws, script, outDir, states = null) {
	const args = [script, "--bronze", path.join(TASK_WS, "data", "bronze"), "--out", outDir];
	if (states) args.push("--states", ...states);
	const r = uv(ws, args, { DW_CONTRACT: path.join(TASK_WS, "contract") });
	const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-4).join(" / ").slice(0, 400);
	return { status: r.status ?? -1, tail: r.error ? `${r.error.message} ${tail}` : tail };
}

export function runChecker(ws, expected, actual, extra = []) {
	const r = uv(ws, [CHECKER, "--expected", expected, "--actual", actual, "--contract", path.join(TASK_WS, "contract"), "--labels", LABELS, ...extra]);
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

export function interfaceChecks(src) {
	const text = fs.readFileSync(src, "utf8");
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
	const checks = [{ ok: lines.length <= MAX_LINES, label: `src/silver.py is at most ${MAX_LINES} code lines (${lines.length})` }];
	const hits = FORBIDDEN.filter((m) => new RegExp(`(^|\\n)\\s*(import\\s+${m.replace(".", "\\.")}\\b|from\\s+${m.replace(".", "\\.")}\\b)|${m.replace(".", "\\.")}\\(`).test(text));
	checks.push({ ok: hits.length === 0, label: `no network/process modules (${hits.length ? hits.join(", ") : "none found"})` });
	return checks;
}

/** The contract file in the workspace must be the oracle's copy, untouched. */
export function contractUntouched(ws) {
	const p = path.join(ws, "contract", "silver_schema.py");
	if (!fs.existsSync(p)) return { ok: true, label: "no contract copy in the graded dir (inputs are the task's own)" };
	const a = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
	const b = fs.readFileSync(path.join(here, "silver_schema.py"), "utf8").replace(/\r\n/g, "\n");
	return { ok: a === b, label: "contract/silver_schema.py is unmodified" };
}
