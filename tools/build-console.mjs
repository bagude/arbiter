import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));

// Substitute the run data into the template. The replacement is a FUNCTION on purpose:
// run transcripts contain shell text with `$&`, "$`" and `$'`, which String.replace
// expands as substitution patterns when the replacement is a string — splicing copies
// of the template into the data and tearing the page's <script> apart.
export function renderConsole(template, data) {
	return template.replace("__RUNS_DATA__", () => data);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const template = fs.readFileSync(path.join(here, "console.template.html"), "utf8");
	const data = fs.readFileSync(path.join(here, "runs-data.json"), "utf8").replace(/<\/script/gi, "<\\/script");
	fs.writeFileSync(path.join(here, "console.html"), renderConsole(template, data));
	console.log("wrote tools/console.html");
}
