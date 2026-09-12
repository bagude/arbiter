/**
 * Shared plumbing for the dw-explore-real oracle and probe: the same checker as
 * dw-explore, pointed at the real-data snapshot the task mounts (mounts.json).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TASK_WS = path.join(here, "..", "ws-builder");
export const CHECKER = path.join(here, "..", "..", "dw-explore", "oracle", "explore_check.py");
const mounts = JSON.parse(fs.readFileSync(path.join(here, "..", "mounts.json"), "utf8")).mounts;
export const DB = path.resolve(here, "..", "..", "..", mounts[0].target, "warehouse.duckdb");
// The supervisor gives an oracle 60 s: at most 8 observations, each query under 10 s.
export const MAX_OBS = 8;

export function runChecker(ws, extra = []) {
	const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with-requirements", path.join(TASK_WS, "requirements.txt"), "python", CHECKER, path.resolve(ws), "--data", TASK_WS, "--db", DB, "--max-obs", String(MAX_OBS), ...extra], { cwd: TASK_WS, encoding: "utf8", timeout: 58_000 });
	try {
		return JSON.parse(r.stdout);
	} catch {
		return { error: `${r.error?.message ?? ""} ${(r.stderr ?? "").slice(-400)}`.trim() };
	}
}
