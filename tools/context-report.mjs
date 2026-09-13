// Context report: how big each role's context was on every request of a run, from
// the pi session files (input + cacheRead of each assistant message), plus the
// compactions, archived handles and checkpoints the summary recorded.
//
//   node tools/context-report.mjs <runDir | runId> [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const arg = process.argv[2];
if (!arg) {
	console.error("usage: node tools/context-report.mjs <runDir | runId> [--json]");
	process.exit(1);
}
const run = fs.existsSync(arg) ? path.resolve(arg) : path.join(ROOT, "runs", arg);
const asJson = process.argv.includes("--json");

function series(file) {
	const rows = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const m = e?.message;
		if (e?.type === "message" && m?.role === "assistant" && m.usage) {
			const tools = (m.content ?? []).filter((c) => c?.type === "toolCall").map((c) => c.name);
			rows.push({ context: (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0), output: m.usage.output ?? 0, tools });
		}
		if (e?.type === "compaction") rows.push({ compaction: true, summaryChars: String(e.summary ?? "").length, tokensBefore: e.tokensBefore ?? null });
	}
	return rows;
}

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

const sessions = path.join(run, "sessions");
const files = walk(sessions);
const roles = [];
for (const f of files) {
	const rel = path.relative(sessions, f).replace(/\\/g, "/");
	const role = /\/tasks\//.test(rel) ? `worker:${path.basename(f, ".jsonl").slice(-8)}` : rel.split("/")[0];
	const rows = series(f);
	if (!rows.some((r) => !r.compaction)) continue;
	const reqs = rows.filter((r) => !r.compaction);
	roles.push({
		role,
		file: rel,
		requests: reqs.length,
		peak: Math.max(...reqs.map((r) => r.context)),
		promptTokens: reqs.reduce((a, r) => a + r.context, 0),
		outputTokens: reqs.reduce((a, r) => a + r.output, 0),
		compactionsInSession: rows.filter((r) => r.compaction).length,
		rows,
	});
}
let summary = null;
try {
	summary = JSON.parse(fs.readFileSync(path.join(run, "summary.json"), "utf8"));
} catch {}

if (asJson) {
	console.log(JSON.stringify({ run: path.basename(run), roles: roles.map(({ rows, ...r }) => r), compactions: summary?.compactions ?? [], handles: summary?.handles ?? null, checkpoints: summary?.checkpoints ?? [] }, null, 2));
} else {
	console.log(`# context report — ${path.basename(run)}${summary ? ` (${summary.reason}, ${summary.wallSec}s)` : ""}`);
	for (const r of roles) {
		console.log(`\n## ${r.role}: ${r.requests} requests, peak ${r.peak} tokens, prompt total ${r.promptTokens}, output total ${r.outputTokens}${r.compactionsInSession ? `, ${r.compactionsInSession} compaction(s) in session` : ""}`);
		let n = 0;
		for (const row of r.rows) {
			if (row.compaction) {
				console.log(`     -- compaction: summary ${row.summaryChars} chars${row.tokensBefore ? `, ${row.tokensBefore} tokens before` : ""}`);
				continue;
			}
			n++;
			console.log(`  ${String(n).padStart(3)} ctx ${String(row.context).padStart(6)}  out ${String(row.output).padStart(5)}  ${row.tools.join(",").slice(0, 60)}`);
		}
	}
	if (summary?.compactions?.length) console.log(`\n## compactions (supervisor)\n${summary.compactions.map((c) => `- ${c.id} at ${c.at}s: ${c.tokensBefore} → ${c.tokensAfter ?? "?"} tokens, ${c.boundary}, checkpoint ${c.checkpoint ? "yes" : "no"}, waited ${c.waitedSec}s`).join("\n")}`);
	if (summary?.handles) console.log(`\n## handles: ${summary.handles.archived} archived (${summary.handles.bytesArchived} bytes), ${summary.handles.recalled} recalled; by role ${JSON.stringify(summary.handles.byRole)}`);
	if (summary?.checkpoints?.length) console.log(`\n## checkpoints: ${summary.checkpoints.map((c) => `#${c.n} (${c.findings} findings, ${c.questions} questions, ${c.steps} steps)`).join(", ")}`);
}
