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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const template = fs.readFileSync(path.join(here, "console.template.html"), "utf8");
	const data = fs.readFileSync(path.join(here, "runs-data.json"), "utf8");
	fs.writeFileSync(path.join(here, "console.html"), renderConsole(template, data));
	console.log("wrote tools/console.html");
}
