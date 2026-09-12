/**
 * context-diet guard — trims the message list before each LLM call.
 *
 * pi's `context` event fires before every provider request with the full message
 * list and accepts a replacement. The policy (lib/policies/context-diet.mjs) drops
 * prior turns' thinking blocks and ages large old tool results into stubs; this
 * adapter applies it and reports what changed. Opt-in per run: the supervisor sets
 * ARBITER_CONTEXT_DIET to "1" (defaults) or a JSON object of options; unset means the
 * guard registers nothing and the run's context is exactly what pi would send.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// ext/guards/ → two levels up; a workspace copy relies on ARBITER_HOME.
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { dietMessages } = await import(kit.homeUrl(home, "lib", "policies", "context-diet.mjs"));

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

const OPTS = optionsFromEnv(process.env.ARBITER_CONTEXT_DIET);

export default function (pi: ExtensionAPI) {
	if (!OPTS) return;
	pi.on("context", async (event, ctx) => {
		const { messages, stats } = dietMessages(event.messages, OPTS);
		if (stats.thinkingDropped === 0 && stats.resultsAged === 0) return undefined;
		kit.report("context_diet", "rewritten", ctx, stats);
		return { messages };
	});
}
