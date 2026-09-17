/**
 * replay-capture — writes every provider request the orchestrator sends (the exact
 * system prompt, message list and tool schemas the model saw at that inference) to
 * <ARBITER_REQUESTS_DIR>/<n>.json, so tools/decision-replay.mjs can put the same
 * state in front of a cheap decision head and compare its answer with what the
 * generative orchestrator chose (docs: decision points, lib/causal-links.mjs).
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
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);

const DIR = (process.env.ARBITER_REQUESTS_DIR ?? "").trim();

export default function (pi: ExtensionAPI) {
	if (!DIR) return;
	let seq = 0;
	pi.on("before_provider_request", (event: { payload: unknown }, ctx: unknown) => {
		if (kit.roleFor(ctx) !== "orchestrator") return undefined;
		seq += 1;
		try {
			fs.mkdirSync(DIR, { recursive: true });
			fs.writeFileSync(path.join(DIR, `${String(seq).padStart(4, "0")}.json`), JSON.stringify({ seq, ts: Date.now(), payload: event.payload }));
		} catch {
			// capture is observability, never a reason to fail a run
		}
		return undefined;
	});
}
