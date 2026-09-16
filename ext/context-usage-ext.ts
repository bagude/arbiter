/**
 * context_usage tool — a read-only estimate of how much of the current context
 * window has been used, from pi's own `context` event (the same char-count proxy
 * ext/guards/pre-spawn-compact.ts uses via estimateContextChars) against the role's
 * context window as set by the supervisor (ARBITER_CONTEXT_WINDOW, populated from
 * lib/config.mjs's model preflight — "" when the role's window is unknown).
 *
 * Registered unconditionally on every role (see the GUARDS list in supervisor.mjs);
 * it is a tool, not a guard, so there is no env opt-in. Workers spawned by
 * pi-subagents inherit the orchestrator's own env, so a worker's call reports
 * against the orchestrator's context window, not a separate one of its own.
 *
 * Adds nothing to the system prompt or the message list: the estimate reaches the
 * agent only as this tool's own result, when it chooses to call it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { estimateContextChars } = await import(kit.homeUrl(home, "lib", "policies", "pre-spawn-compact.mjs"));
const { describeContextUsage } = await import(kit.homeUrl(home, "lib", "policies", "context-usage.mjs"));

export default function (pi: ExtensionAPI) {
	let contextChars = 0;
	pi.on("context", (event: { messages: unknown[] }) => {
		contextChars = estimateContextChars(event.messages);
		return undefined;
	});

	pi.registerTool({
		name: "context_usage",
		label: "Context usage",
		description: "Report how much of your context window you have used, as an estimate from the current message list. Read-only.",
		parameters: Type.Object({}),
		async execute() {
			const contextWindow = Number(process.env.ARBITER_CONTEXT_WINDOW) || null;
			const { text } = describeContextUsage({ chars: contextChars, contextWindow });
			return { content: [{ type: "text" as const, text }], details: {}, isError: false };
		},
	});
}
