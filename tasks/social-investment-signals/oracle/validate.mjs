#!/usr/bin/env node
/**
 * Oracle for social-investment-signals: the watchlist's quotes are verbatim in posts
 * inside the seven-day window, tickers resolve through context, reposts are
 * clustered, ambiguous mentions stay unresolved, verification cites primary text,
 * attention is honest about baselines, and each candidate has its investigation
 * file. Usage: node validate.mjs <workspace>. Prints one JSON line
 * {pass, total, summary, details}. Expected values come from the task's pristine
 * exports, never from the workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { checkWatchlist, loadData, loadInvestigations } from "./checks.mjs";

const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
let doc = null;
try {
	doc = JSON.parse(fs.readFileSync(path.join(ws, "src", "watchlist.json"), "utf8"));
} catch (e) {
	out({ pass: 0, total: 1, summary: `src/watchlist.json missing or invalid: ${e.message}`.slice(0, 500), details: [] });
	process.exit(0);
}
const data = loadData();
const { checks, details } = checkWatchlist(data, doc, loadInvestigations(ws, doc));
const md = path.join(ws, "src", "briefing.md");
const mdText = fs.existsSync(md) ? fs.readFileSync(md, "utf8") : "";
const ids = (doc.candidates ?? []).map((c) => c?.id).filter(Boolean);
checks.push({ name: "briefing_md", ok: mdText.length > 300 && ids.every((id) => mdText.includes(id)), detail: mdText ? `${mdText.length} chars, names ${ids.filter((id) => mdText.includes(id)).length}/${ids.length} candidate ids` : "src/briefing.md missing" });
const pass = checks.filter((c) => c.ok).length;
const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
for (const l of failed) console.error(`FAIL: ${l}`);
const digest = (doc.candidates ?? []).map((c) => `${c.id} [${c.claim}] ${c.ticker} ${c.stance}: ${String(c.thesis ?? "").slice(0, 80)}`).join(" | ") || "no candidates";
out({ pass, total: checks.length, summary: `${pass}/${checks.length} watchlist checks${failed.length ? `; failing: ${failed.slice(0, 8).join(" | ")}` : ""}; quotes, window, coverage, clusters and primary citations verified, thesis quality not. Findings digest: ${digest}`.slice(0, 4000), details });
