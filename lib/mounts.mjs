// Read-only mounts: a task may declare, in tasks/<task>/mounts.json, directories
// that appear inside every run's workspace as junctions instead of copies —
// e.g. an 8 GB warehouse snapshot. Node's cpSync dereferences junctions, so the
// links are created AFTER the workspace copy and skipped when the workspace is
// archived. The path guard (ext/path-guard.ts) reads ARBITER_MOUNTS and lets
// read/ls/grep/find through a mount while refusing write/edit.
//
//   { "mounts": [ { "path": "data/real", "target": "runs/.mounts/data-warehousers" } ] }
//
// `target` is absolute or relative to the arbiter checkout.
import fs from "node:fs";
import path from "node:path";

export function readMounts(taskDir, home) {
	const file = path.join(taskDir, "mounts.json");
	if (!fs.existsSync(file)) return [];
	const spec = JSON.parse(fs.readFileSync(file, "utf8"));
	const list = Array.isArray(spec) ? spec : spec.mounts ?? [];
	return list.map((m) => {
		if (!m?.path || !m?.target) throw new Error(`mounts.json: each mount needs path and target (${JSON.stringify(m)})`);
		if (path.isAbsolute(m.path) || m.path.split(/[\\/]/).includes("..")) throw new Error(`mounts.json: path must be workspace-relative (${m.path})`);
		return { path: m.path.replace(/\\/g, "/"), target: path.resolve(home, m.target) };
	});
}

/** Create the junctions in a copied workspace; returns [{ path: abs link, target: abs }]. */
export function installMounts(workspace, mounts) {
	const out = [];
	for (const m of mounts) {
		if (!fs.existsSync(m.target)) throw new Error(`mount target missing: ${m.target}`);
		const link = path.join(workspace, m.path);
		fs.mkdirSync(path.dirname(link), { recursive: true });
		if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true });
		fs.symlinkSync(m.target, link, "junction");
		out.push({ path: link, target: fs.realpathSync.native(m.target) });
	}
	return out;
}

/** A cpSync filter that skips the mount links (and anything under them). */
export function archiveFilter(installed) {
	const links = installed.map((m) => path.resolve(m.path).toLowerCase());
	return (src) => {
		const s = path.resolve(src).toLowerCase();
		return !links.some((l) => s === l || s.startsWith(`${l}${path.sep}`));
	};
}

/** Remove the links before a workspace is deleted, so no rm can reach the targets. */
export function uninstallMounts(installed) {
	for (const m of installed) {
		try {
			if (fs.lstatSync(m.path).isSymbolicLink()) fs.unlinkSync(m.path);
		} catch {
			// already gone
		}
	}
}
