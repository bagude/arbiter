#!/usr/bin/env node
/**
 * Oracle for dw-water-bench: evidence found (the loader-inspection record cited),
 * the cause kept unsettled unless a reproduced header check is present, nothing
 * from another snapshot cited as support, a worker fetched memory itself, and the
 * memory budget held. Usage: node validate.mjs <workspace>. Prints one JSON line
 * {pass, total, summary, details}.
 */
import fs from "node:fs";
import path from "node:path";
import { checkFinding } from "./checks.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
let finding = null;
try {
	finding = JSON.parse(fs.readFileSync(path.join(ws, "src", "finding.json"), "utf8"));
} catch (e) {
	out({ pass: 0, total: 1, summary: `src/finding.json missing or invalid: ${e.message}`.slice(0, 500), details: [] });
	process.exit(0);
}
const checks = checkFinding(finding);
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
out({ pass, total: checks.length, summary: `${pass}/${checks.length} benchmark checks${failed.length ? `; failing: ${failed.join(" | ")}` : ""}`.slice(0, 4000), details: checks });
