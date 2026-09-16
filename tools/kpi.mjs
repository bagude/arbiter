import fs from "node:fs";
import path from "node:path";
import { discoverRuns } from "./extract-runs.mjs";
import { tokenTotals, hitRatio } from "../lib/usage.mjs";

const RUNS = discoverRuns().map((r) => ({ dir: r.dir, label: r.label }));

console.log(
	"label".padEnd(58),
	"success".padEnd(8),
	"turns".padEnd(6),
	"freshTok".padEnd(9),
	"inTok".padEnd(8),
	"outTok".padEnd(8),
	"cacheRd".padEnd(8),
	"hitRatio".padEnd(9),
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
		String(totalExclCache).padEnd(9),
		String(input).padEnd(8),
		String(output).padEnd(8),
		String(cacheRead).padEnd(8),
		hitRatio({ input, cacheRead }).toFixed(3).padEnd(9),
		(eExcl === null ? "—" : eExcl.toFixed(3)).padEnd(11),
		(eIncl === null ? "—" : eIncl.toFixed(3)).padEnd(11),
		JSON.stringify(byRole),
	);
}
console.log("\nhitRatio = cache reads / (fresh input + cache reads): the share of prompt tokens the server did not have to prefill.");
console.log("E_excl(1k) = successes per 1k tokens, counting only fresh input + generated output (excludes cache reads) — closer to what a hosted API bills.");
console.log("E_incl(1k) = successes per 1k tokens, counting all context touched including cache reads — closer to total compute the local box actually did.");
console.log("A run that failed/timed out scores 0 on both, regardless of tokens spent — that's the point of the metric: it punishes expensive failures, not just cheap ones.");
