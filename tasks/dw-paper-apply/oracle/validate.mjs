#!/usr/bin/env node
/**
 * Oracle for dw-paper-apply: the explorer's reproduction checks (queries against the
 * real warehouse) plus, per observation, a model from the paper, paper references,
 * and a compute snippet that re-runs on the rows and prints its expect.
 * Usage: node validate.mjs <workspace>. Prints one JSON line {pass, total, summary, details}.
 */
import fs from "node:fs";
import path from "node:path";
import { runChecker } from "./harness.mjs";
import { checkApply } from "./checks.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
if (!ws || !fs.existsSync(ws)) {
	out({ pass: 0, total: 1, summary: "no workspace dir given", details: [] });
	process.exit(0);
}
const res = runChecker(ws);
if (!res || !Array.isArray(res.checks)) {
	out({ pass: 0, total: 1, summary: `explore_check.py produced no result: ${res?.error ?? ""}`.slice(0, 1000), details: [] });
	process.exit(0);
}
let doc = null;
try {
	doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "exploration.json"), "utf8"));
} catch {
	doc = null;
}
const checks = [...res.checks];
const details = [...(res.details ?? [])];
for (const o of Array.isArray(doc?.observations) ? doc.observations : []) {
	const bad = checkApply(o);
	checks.push({ name: `apply ${o?.id ?? "?"}`, ok: bad.length === 0, detail: bad.join("; ") || `${o.model} fit reproduces` });
	const d = details.find((x) => x.id === o?.id);
	if (d) d.reproduced = d.reproduced && bad.length === 0;
}
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const summary = `${pass}/${checks.length} reproduction and fit checks${failed.length ? `; failing: ${failed.slice(0, 10).join(" | ")}` : ""}; this checks that queries and fits reproduce, not that a model is right. Findings digest: ${res.digest || "none"}`;
out({ pass, total: checks.length, summary: summary.slice(0, 4000), details });
