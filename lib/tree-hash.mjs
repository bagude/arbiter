// tree-hash — sha1 over (relative path, contents) of every regular file under a directory, in
// sorted order. Shared by ext/replay-capture.ts (the fork snapshot hash) and lib/manage/packet.mjs
// (checkpoint identity); kept byte-identical to the capture's original inline copy.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * sha1 over (relative path, contents) of every regular file under dir, in sorted order.
 *
 * `skip` is an optional predicate over the absolute path of each entry; a truthy answer leaves
 * that file or directory (and everything under it) out of the hash entirely. It exists so the
 * hash of a workspace can be compared with the hash of a COPY of that workspace taken with the
 * same exclusion — a checkpoint is the run's workspace minus `.pi`, and without this the
 * original could only be hashed by copying it again. Omitted, the walk and the digest are
 * exactly what they were before the parameter existed.
 */
export function treeHash(dir, skip = null) {
	const files = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = path.join(d, e.name);
			if (skip && skip(p)) continue;
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) files.push(p);
		}
	};
	walk(dir);
	const h = createHash("sha1");
	for (const f of files) {
		h.update(path.relative(dir, f).split(path.sep).join("/"));
		h.update("|");
		h.update(fs.readFileSync(f));
		h.update("|");
	}
	return h.digest("hex");
}
