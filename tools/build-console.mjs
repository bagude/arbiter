import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, "console.template.html"), "utf8");
const data = fs.readFileSync(path.join(here, "runs-data.json"), "utf8").replace(/<\/script/gi, "<\\/script");
fs.writeFileSync(path.join(here, "console.html"), template.replace("__RUNS_DATA__", data));
console.log("wrote tools/console.html");
