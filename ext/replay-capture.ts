/**
 * replay-capture — writes every provider request the orchestrator sends (the exact
 * system prompt, message list and tool schemas the model saw at that inference) to
 * <ARBITER_REQUESTS_DIR>/<n>.json, with the whole workspace (minus .pi/) copied to
 * <n>-ws at that instant, so tools/decision-replay.mjs can put the same state in front
 * of a cheap decision head, and a fork can restart the run from exactly that point
 * (docs: decision points, lib/causal-links.mjs).
 *
 * Opt-in per run: ARBITER_REQUESTS_DIR unset → registers nothing. Orchestrator only:
 * workers share the orchestrator's env, so the role check keeps their requests out
 * (a worker session file lives under tasks/, see guard-kit roleFor).
 *
 * pi fires `before_provider_request` with { payload } before each provider call;
 * the payload is written verbatim (stream flags and all) — the replay tool
 * normalises it. Sequence numbers start at 1 and match the traced call index + 1.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);

const DIR = (process.env.ARBITER_REQUESTS_DIR ?? "").trim();

/** sha1 over (relative path, contents) of every regular file under dir, in sorted order. */
function treeHash(dir: string): string {
	const files: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = path.join(d, e.name);
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

export default function (pi: ExtensionAPI) {
	if (!DIR) return;
	let seq = 0;
	pi.on("before_provider_request", (event: { payload: unknown }, ctx: unknown) => {
		if (kit.roleFor(ctx) !== "orchestrator") return undefined;
		seq += 1;
		try {
			fs.mkdirSync(DIR, { recursive: true });
			const stem = String(seq).padStart(4, "0");
			// The workspace as the model sees it at this inference: everything under cwd
			// except .pi/ (harness-installed, and the path guard denies reads of it) copied
			// beside the request, so a fork can restore every file a decision could have
			// been made against — tests, scratch files, generated output, not only src/.
			// A content hash of the tree lets later tooling tell identical snapshots apart
			// cheaply. Workspaces here are KBs to a few hundred KB; skipped, not failed,
			// when cwd is unknown.
			const cwd = String((ctx as { cwd?: string })?.cwd ?? "");
			let snapshot: string | null = null;
			let hash: string | null = null;
			if (cwd && fs.existsSync(cwd)) {
				snapshot = path.join(DIR, `${stem}-ws`);
				fs.cpSync(cwd, snapshot, { recursive: true, filter: (p) => path.basename(p) !== ".pi" });
				hash = treeHash(snapshot);
			}
			fs.writeFileSync(path.join(DIR, `${stem}.json`), JSON.stringify({ seq, ts: Date.now(), cwd, snapshot: snapshot ? path.relative(DIR, snapshot) : null, hash, payload: event.payload }));
		} catch {
			// capture is observability, never a reason to fail a run
		}
		return undefined;
	});
}
