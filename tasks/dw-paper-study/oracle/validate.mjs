#!/usr/bin/env node
/**
 * Oracle for dw-paper-study: every claim's quotes verify on the paper's pages and its
 * checks reproduce; observed claims carry evidence, the others a settlement
 * criterion; the round cites several pages. Usage: node validate.mjs <workspace>.
 * Prints one JSON line {pass, total, summary, details}.
 */
import fs from "node:fs";
import path from "node:path";
import { checkStudy, loadStudyPages } from "./checks.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
let doc = null;
try {
	doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "study.json"), "utf8"));
} catch (e) {
	out({ pass: 0, total: 1, summary: `src/study.json missing or invalid: ${e.message}`.slice(0, 500), details: [] });
	process.exit(0);
}
const { checks, details } = checkStudy(doc, loadStudyPages());
const md = path.join(ws, "src", "study.md");
checks.push({ name: "study_md", ok: fs.existsSync(md) && fs.statSync(md).size > 200, detail: fs.existsSync(md) ? "present" : "src/study.md missing" });
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const digest = (doc.claims ?? []).map((c) => `${c.id} [${c.claim}] ${String(c.text ?? "").slice(0, 80)}`).join(" | ");
out({ pass, total: checks.length, summary: `${pass}/${checks.length} study checks${failed.length ? `; failing: ${failed.slice(0, 8).join(" | ")}` : ""}; quotes and checks verified, honesty of labels not. Findings digest: ${digest}`.slice(0, 4000), details });
