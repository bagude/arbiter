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
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// ext/ → one level up; a workspace copy relies on ARBITER_HOME.
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { decidePath } = await import(kit.homeUrl(home, "lib", "path-policy.mjs"));

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const verdict = decidePath({ root: ctx.cwd, tool: event.toolName, input: event.input });
		if (verdict.ok) return undefined;
		kit.report("path", "denied", ctx, { tool: event.toolName, fragment: verdict.fragment });
		return kit.deny(verdict.reason);
	});
}
