/**
 * path-guard — in-band guard on pi's tool_call edge.
 *
 * Runs host-side inside the agent's pi process, BEFORE a tool executes: the
 * supervisor only ever sees a tool call after it ran, which is too late for a
 * `read` of the oracle file (the contents are already in the model's context).
 * The rule itself is lib/path-policy.mjs (pure, unit-tested); this file is the
 * adapter: resolve the workspace root, ask the policy, block with a redirect,
 * and report the deny through the guard kit.
 *
 * Reaches every role: parents load it via `-e`; pi-subagents workers load it from
 * <workspace>/.pi/extensions/ (their loader does not inherit the parent's `-e`
 * paths but does resolve project-local extensions).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// ext/ → one level up; a workspace copy relies on ARBITER_HOME.
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { decidePath } = await import(kit.homeUrl(home, "lib", "path-policy.mjs"));

// The pure policy sees strings; a link inside the workspace whose target is outside
// looks inside to it (review-guard R8). The adapter has the filesystem: when a
// file-tool path exists, judge its real path too, so a junction to the oracle or
// to another run cannot be read through.
function realTarget(root: string, p: unknown): string | null {
	if (typeof p !== "string" || !p) return null;
	try {
		const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
		if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
		// A path that does not exist yet (a write) is judged by where its nearest
		// existing ancestor really is — a new file under a mount is still under the mount.
		let dir = path.dirname(abs);
		const tail: string[] = [path.basename(abs)];
		while (!fs.existsSync(dir)) {
			if (path.dirname(dir) === dir) return null;
			tail.unshift(path.basename(dir));
			dir = path.dirname(dir);
		}
		return path.join(fs.realpathSync.native(dir), ...tail);
	} catch {
		return null;
	}
}

// Read-only mounts declared by the task (lib/mounts.mjs): a junction inside the
// workspace whose real path is a snapshot outside it. Reads through it are the
// point; writes are refused — the snapshot is shared by every run.
const MOUNTS: { path: string; target: string }[] = (() => {
	try {
		return JSON.parse(process.env.ARBITER_MOUNTS || "[]");
	} catch {
		return [];
	}
})();
function insideMount(real: string): boolean {
	const r = real.toLowerCase();
	return MOUNTS.some((m) => {
		const t = m.target.toLowerCase();
		return r === t || r.startsWith(`${t}${path.sep}`);
	});
}
const WRITE_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		let verdict = decidePath({ root: ctx.cwd, tool: event.toolName, input: event.input });
		if (verdict.ok && event.toolName !== "bash" && event.toolName !== "powershell") {
			const real = realTarget(ctx.cwd, (event.input as { path?: unknown }).path);
			if (real && insideMount(real)) {
				if (WRITE_TOOLS.has(event.toolName)) verdict = { ok: false, reason: "That path is a read-only mount (a shared data snapshot). Read it freely; write your deliverable under src/.", fragment: String((event.input as { path?: unknown }).path) };
			} else if (real) {
				verdict = decidePath({ root: ctx.cwd, tool: event.toolName, input: { ...(event.input as object), path: real } });
			}
		}
		if (verdict.ok) return undefined;
		kit.report("path", "denied", ctx, { tool: event.toolName, fragment: verdict.fragment });
		return kit.deny(verdict.reason);
	});
}
