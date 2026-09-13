#!/usr/bin/env node
/**
 * Oracle for dw-explore (grounding kind): every observation's query must reproduce
 * its reported result against the warehouse. Interest is not checked here.
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line: {"pass": N, "total": M, "summary": "..."}
 * The summary ends with "Findings digest: …" so memory retention keeps what was found.
 */
import fs from "node:fs";
import { runChecker } from "./harness.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
if (!ws || !fs.existsSync(ws)) {
	out({ pass: 0, total: 1, summary: "no workspace dir given" });
	process.exit(0);
}
const res = runChecker(ws);
if (!res || !Array.isArray(res.checks)) {
	out({ pass: 0, total: 1, summary: `explore_check.py produced no result: ${res?.error ?? ""}`.slice(0, 1000) });
	process.exit(0);
}
const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${res.pass}/${res.total} reproduction checks${failed.length ? `; failing: ${failed.slice(0, 10).join(" | ")}` : ""}; this checks that observations reproduce, not that they matter. Findings digest: ${res.digest || "none"}`;
out({ pass: res.pass, total: res.total, summary: summary.slice(0, 4000), details: res.details ?? [] });
