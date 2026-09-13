#!/usr/bin/env node
/**
 * Oracle for dw-paper-synthesis: every claim's citations resolve in the run's memory
 * and obey the claim rules, quotes verify on the paper's pages, the report has
 * enough claims and names what is unresolved. Usage: node validate.mjs <workspace>.
 */
import fs from "node:fs";
import path from "node:path";
import { checkReport, loadReportPages, env } from "./checks.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
let doc = null;
try {
	doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "report.json"), "utf8"));
} catch (e) {
	out({ pass: 0, total: 1, summary: `src/report.json missing or invalid: ${e.message}`.slice(0, 500), details: [] });
	process.exit(0);
}
const { checks, details } = checkReport(doc, loadReportPages(), env());
const md = path.join(ws, "src", "report.md");
checks.push({ name: "report_md", ok: fs.existsSync(md) && fs.statSync(md).size > 400, detail: fs.existsSync(md) ? "present" : "src/report.md missing" });
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const digest = (doc.claims ?? []).map((c) => `${c.id} [${c.claim}] ${String(c.text ?? "").slice(0, 80)}`).join(" | ");
out({ pass, total: checks.length, summary: `${pass}/${checks.length} synthesis checks${failed.length ? `; failing: ${failed.slice(0, 8).join(" | ")}` : ""}; citations and quotes verified, judgement not. Findings digest: ${digest}`.slice(0, 4000), details });
