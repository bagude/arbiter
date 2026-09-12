/**
 * Shared plumbing for the dw-recon oracle and probe: run the Python checker with uv
 * against the candidate's src/ and the task's pristine inputs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TASK_WS = path.join(here, "..", "ws-builder");
export const CHECKER = path.join(here, "recon_check.py");

export function runChecker(ws, extra = []) {
	const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(TASK_WS, "requirements.txt"), "python", CHECKER, path.resolve(ws), "--data", TASK_WS, ...extra], { cwd: TASK_WS, encoding: "utf8", timeout: 50_000 });
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { error: `${r.error?.message ?? ""} ${(r.stderr ?? "").slice(-400)}`.trim() };
	}
}
