/**
 * call-args guard — elides the file contents inside old write/edit tool calls from
 * the projected context (the file is on disk; the model can read it). The policy is
 * lib/policies/call-args.mjs; this adapter applies it on pi's `context` event and
 * reports what it changed. Opt-in per run: ARBITER_CALL_ARGS is "" (registers
 * nothing), "1" (defaults) or a JSON object of policy options.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { elideCallArgs } = await import(kit.homeUrl(home, "lib", "policies", "call-args.mjs"));

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

const OPTS = optionsFromEnv(process.env.ARBITER_CALL_ARGS);

export default function (pi: ExtensionAPI) {
	if (!OPTS) return;
	pi.on("context", async (event, ctx) => {
		try {
			const { messages, stats } = elideCallArgs(event.messages, OPTS);
			if (stats.callsElided === 0) return undefined;
			kit.report("call_args", "rewritten", ctx, stats);
			return { messages };
		} catch (err) {
			console.error(`[call-args] fail-open: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	});
}
