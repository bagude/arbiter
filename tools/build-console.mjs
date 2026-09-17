import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

// Substitute the run data into the template — the whole transformation, so one pure
// function covers both hazards, and both are ordinary transcript text. A literal
// "</script" in the data would end the page's script element early. And the
// replacement is a FUNCTION because `$&`, "$`" and `$'` in a string replacement are
// substitution patterns, which would splice copies of the template into the data.
export function renderConsole(template, data) {
	return template.replace("__RUNS_DATA__", () => data.replace(/<\/script/gi, "<\\/script"));
}

/** Keep only the newest `n` runs (ids sort chronologically); the artifact host caps a page at 16 MB. */
export function newestRuns(runs, n) {
	if (!Number.isFinite(n) || n <= 0) return runs;
	const keep = new Set(Object.keys(runs).sort().slice(-n));
	return Object.fromEntries(Object.entries(runs).filter(([id]) => keep.has(id)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const template = fs.readFileSync(path.join(here, "console.template.html"), "utf8");
	const lastArg = process.argv.indexOf("--last");
	const last = lastArg >= 0 ? Number(process.argv[lastArg + 1]) : 0;
	let data = fs.readFileSync(path.join(here, "runs-data.json"), "utf8");
	if (last > 0) data = JSON.stringify(newestRuns(JSON.parse(data), last));
	const out = renderConsole(template, data);
	fs.writeFileSync(path.join(here, "console.html"), out);
	console.log(`wrote tools/console.html (${(out.length / 1048576).toFixed(1)} MB${last > 0 ? `, newest ${last} runs` : ""})`);
}
