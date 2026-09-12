#!/usr/bin/env node
/**
 * Probe for dw-bronze: run the candidate for one state and return the checker's
 * verdict for that state — the orchestrator's real-value verification channel.
 *
 * Input (stdin): JSON array of {id, args: ["tx" | "nm" | "ok"]}.
 * Output (stdout): one JSON line, an array of
 *   {id, ok:true, value:{state, pass, total, failed:[...]}} | {id, ok:false, error}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCandidate, runChecker } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
let probes;
try {
	probes = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Array.isArray(probes)) throw new Error("probes must be a JSON array");
} catch (err) {
	console.log(JSON.stringify([{ id: "*", ok: false, error: `probe.mjs: ${err.message}` }]));
	process.exit(0);
}
const src = path.join(ws, "src", "bronze.py");
const results = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dw-bronze-probe-"));
try {
	for (const [i, p] of probes.entries()) {
		const id = p?.id ?? "?";
		const state = Array.isArray(p?.args) ? p.args[0] : undefined;
		if (!["tx", "nm", "ok"].includes(state)) {
			results.push({ id, ok: false, error: 'each probe needs args: ["tx"|"nm"|"ok"]' });
			continue;
		}
		if (!fs.existsSync(src)) {
			results.push({ id, ok: false, error: "src/bronze.py missing" });
			continue;
		}
		const out = path.join(scratch, `p${i}`);
		const r = runCandidate(ws, src, out, [state]);
		if (r.status !== 0) {
			results.push({ id, ok: true, value: { state, pass: 0, total: 1, failed: [`bronze.py exited ${r.status}: ${r.tail}`] } });
			continue;
		}
		const res = runChecker(path.join(here, "bronze_check.py"), ["check", "--remote", path.join(ws, "remote"), "--bronze", out, "--states", state]);
		if (!res) results.push({ id, ok: false, error: "checker produced no result" });
		else results.push({ id, ok: true, value: { state, pass: res.pass, total: res.total, failed: res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) } });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(results));
