/**
 * pre-spawn-compact guard — denies a fresh, foreground `subagent` call while the
 * orchestrator's own context is already large, so the supervisor gets a chance to
 * checkpoint and compact BEFORE the worker's blocking child run starts, not only
 * after it reports (see lib/policies/pre-spawn-compact.mjs for the evidence and the
 * one-shot rule that keeps this from ever deadlocking a run).
 *
 * pi's `context` event fires before every provider request with the full message
 * list; this adapter caches its size (cheap char proxy, not a token count) so the
 * `tool_call` handler — which sees the `subagent` call before it runs — can decide
 * without a round trip to the supervisor. The deny's `reason` is what the model
 * reads: it names the tool it should call and to retry the spawn after.
 *
 * Opt-in per run: ARBITER_PRE_SPAWN_COMPACT is "" (registers nothing), "1"
 * (defaults) or a JSON object with `thresholdChars`. Orchestrator only in
 * practice — only that role ever calls `subagent` — but harmless to load
 * everywhere, like every other guard here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { decideSpawnDeny, estimateContextChars } = await import(kit.homeUrl(home, "lib", "policies", "pre-spawn-compact.mjs"));

function optionsFromEnv(raw: string | undefined): Record<string, unknown> | null {
	const v = (raw ?? "").trim();
	if (!v || v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off") return null;
	if (v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on") return {};
	try {
		const parsed = JSON.parse(v);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

const OPTS = optionsFromEnv(process.env.ARBITER_PRE_SPAWN_COMPACT);
const DEFAULT_THRESHOLD_CHARS = 100000; // ~30,000 tokens at ~3.3 chars/token, this policy's own default cap

export default function (pi: ExtensionAPI) {
	if (!OPTS) return;
	const thresholdChars = Number(OPTS.thresholdChars) || DEFAULT_THRESHOLD_CHARS;
	const state = { deniedPending: false };
	let contextChars = 0;
	pi.on("context", (event: { messages: unknown[] }) => {
		contextChars = estimateContextChars(event.messages);
		return undefined;
	});
	pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => {
		const input = event.input ?? {};
		const d = decideSpawnDeny(
			{ toolName: event.toolName, resume: input.resume, runInBackground: input.run_in_background, contextChars, thresholdChars },
			state,
		);
		if (!d.deny) return undefined;
		kit.report("pre_spawn_compact", "denied", ctx, { contextChars: d.contextChars, thresholdChars: d.thresholdChars });
		return kit.deny(
			`Your context is large (~${d.contextChars} chars) and a foreground spawn would hold this call open for the worker's whole run, past the point the supervisor could act. Call \`checkpoint\` now; the supervisor will compact and tell you when it's done. Then retry this exact spawn — it will go through.`,
		);
	});
}
