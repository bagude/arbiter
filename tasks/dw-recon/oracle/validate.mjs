#!/usr/bin/env node
/**
 * Oracle for dw-recon (grounding kind): the KPI block must equal an independent
 * recomputation; every finding must rest on a real file + verbatim quote or a KPI.
 * Whether the findings are insightful is not checked here.
 *
 * Usage: node validate.mjs <workspace-dir>
 * Prints exactly one JSON line: {"pass": N, "total": M, "summary": "..."}
 * The summary ends with "KPI digest: …" so memory retention keeps the landing history.
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
	out({ pass: 0, total: 1, summary: `recon_check.py produced no result: ${res?.error ?? ""}`.slice(0, 1000) });
	process.exit(0);
}
const failed = res.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${res.pass}/${res.total} grounding checks${failed.length ? `; failing: ${failed.slice(0, 10).join(" | ")}` : ""}; this checks numbers and citations, not insight. KPI digest: ${res.digest}`;
out({ pass: res.pass, total: res.total, summary: summary.slice(0, 4000) });
