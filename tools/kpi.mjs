import fs from "node:fs";
import path from "node:path";
import { discoverRuns } from "./extract-runs.mjs";

const RUNS = discoverRuns().map((r) => ({ dir: r.dir, label: r.label }));

function readJsonl(p) {
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function tokenTotals(dir) {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		turns = 0;
	const byRole = {};
	const rawFiles = fs.readdirSync(dir).filter((f) => /^raw-.*\.jsonl$/.test(f));
	for (const f of rawFiles) {
		const role = f.slice(4).split(/[_.]/)[0];
		for (const ev of readJsonl(path.join(dir, f))) {
			if (ev.type !== "message_end") continue;
			const m = ev.message;
			if (!m || m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input || 0;
			output += m.usage.output || 0;
			cacheRead += m.usage.cacheRead || 0;
			cacheWrite += m.usage.cacheWrite || 0;
			turns++;
			byRole[role] = (byRole[role] || 0) + (m.usage.input || 0) + (m.usage.output || 0);
		}
	}
	return { input, output, cacheRead, cacheWrite, turns, byRole };
}

console.log(
	"label".padEnd(58),
	"success".padEnd(8),
	"turns".padEnd(6),
	"freshTok".padEnd(9),
	"outTok".padEnd(8),
	"cacheRd".padEnd(8),
	"E_excl(1k)".padEnd(11),
	"E_incl(1k)".padEnd(11),
	"byRole",
);
for (const run of RUNS) {
	const dir = run.dir;
	const summaryPath = path.join(dir, "summary.json");
	const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : null;
	const success = summary ? summary.reason.startsWith("SUCCESS") : null; // null = still running
	const { input, output, cacheRead, turns, byRole } = tokenTotals(dir);
	const totalExclCache = input + output; // "work done": fresh tokens processed + generated
	const totalInclCache = input + output + cacheRead; // total context touched, cached or not
	const eExcl = success === null ? null : success ? 1000 / (totalExclCache / 1000) : 0;
	const eIncl = success === null ? null : success ? 1000 / (totalInclCache / 1000) : 0;
	console.log(
		run.label.padEnd(58),
		String(success === null ? "running" : success).padEnd(8),
		String(turns).padEnd(6),
		String(input).padEnd(9),
		String(output).padEnd(8),
		String(cacheRead).padEnd(8),
		(eExcl === null ? "—" : eExcl.toFixed(3)).padEnd(11),
		(eIncl === null ? "—" : eIncl.toFixed(3)).padEnd(11),
		JSON.stringify(byRole),
	);
}
console.log("\nE_excl(1k) = successes per 1k tokens, counting only fresh input + generated output (excludes cache reads) — closer to what a hosted API bills.");
console.log("E_incl(1k) = successes per 1k tokens, counting all context touched including cache reads — closer to total compute the local box actually did.");
console.log("A run that failed/timed out scores 0 on both, regardless of tokens spent — that's the point of the metric: it punishes expensive failures, not just cheap ones.");
