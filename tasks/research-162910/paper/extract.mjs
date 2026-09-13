// Extract the paper's text, one file per page, through pypdf (uv-managed). Run once;
// the pages are committed so every round reads the same text. The PDF stays where it
// is (the user's data-warehousers checkout); only the extracted text lives here.
//
//   node tasks/research-162910/paper/extract.mjs "<path to pdf>"
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = process.argv[2];
if (!pdf || !fs.existsSync(pdf)) {
	console.error("usage: node extract.mjs <pdf>");
	process.exit(1);
}
const py = `
import json, sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
print(json.dumps([p.extract_text() or "" for p in r.pages]))
`;
const r = spawnSync("uv", ["run", "--no-project", "--python", "3.13", "--with", "pypdf", "python", "-c", py, pdf], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0) {
	console.error(r.stderr);
	process.exit(1);
}
const pages = JSON.parse(r.stdout.trim().split("\n").pop());
const dir = path.join(here, "pages");
fs.mkdirSync(dir, { recursive: true });
const index = ["# SPE 162910 — page index", "", `${pages.length} pages; one file per page under pages/. First non-empty line of each page:`, ""];
pages.forEach((t, i) => {
	const n = String(i + 1).padStart(2, "0");
	fs.writeFileSync(path.join(dir, `p${n}.txt`), t.replace(/\r\n/g, "\n"));
	const first = t.split("\n").map((l) => l.trim()).find((l) => l.length > 3) ?? "(no text)";
	index.push(`- p${n} (${t.length} chars): ${first.slice(0, 100)}`);
});
fs.writeFileSync(path.join(here, "index.md"), `${index.join("\n")}\n`);
console.log(`${pages.length} pages written to ${path.relative(process.cwd(), dir)}`);
