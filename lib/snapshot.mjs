// The data a claim was made against, as one identifier: name plus a hash of the
// relative paths, sizes and mtimes of every file under `dir`. Two runs on unchanged
// data share it; a re-fetched warehouse gets a new one. Cheap even for a 9 GB
// snapshot because it never reads file contents.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function walk(dir, base, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, base, out);
		else if (e.isFile()) {
			const st = fs.statSync(p);
			out.push(`${path.relative(base, p).replace(/\\/g, "/")}\t${st.size}\t${Math.round(st.mtimeMs)}`);
		}
	}
}

export function snapshotId({ name, dir }) {
	if (!dir || !fs.existsSync(dir)) return `${name}@none`;
	const lines = [];
	walk(dir, dir, lines);
	return `${name}@${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`;
}
