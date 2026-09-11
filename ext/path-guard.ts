/**
 * path-guard — in-band guard on pi's tool_call edge.
 *
 * Runs host-side inside the agent's pi process, BEFORE a tool executes: the
 * supervisor only ever sees a tool call after it ran, which is too late for a
 * `read` of the oracle file (the contents are already in the model's context).
 * The rule itself is lib/path-policy.mjs (pure, unit-tested); this file is the
 * adapter: resolve the workspace root, ask the policy, block with a redirect,
 * and append a deny line to the lifecycle file the supervisor already tails.
 *
 * Reaches every role: parents load it via `-e`; pi-subagents workers load it from
 * <workspace>/.pi/extensions/ (their loader does not inherit the parent's `-e`
 * paths but does resolve project-local extensions).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Import by file URL so the same source works from ext/ (parents, via -e) and from
// a workspace copy under .pi/extensions/ (workers): both resolve lib/ relative to
// the arbiter checkout, found from this file's location or, for the copy, from
// ARBITER_HOME set by the supervisor.
const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const { decidePath } = await import(new URL(`file:///${path.join(home, "lib", "path-policy.mjs").replace(/\\/g, "/")}`).href);

const ROLE = process.env.AGENT_NAME ?? "unknown";
const OUT = process.env.ARBITER_LIFECYCLE_FILE ?? "";

// Workers run inside the orchestrator's process, so AGENT_NAME says "orchestrator"
// for them too. Their session file lives under <parent session>/tasks/<id>.jsonl,
// and <id> is the name the supervisor already gives the worker (lib/child-transcripts.mjs
// workerIdFromTranscript) — derive the role from the same place.
function roleFor(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string {
	const file = ctx.sessionManager?.getSessionFile?.();
	if (file && /[\\/]tasks[\\/][^\\/]+\.jsonl$/.test(file)) return `worker:${path.basename(file, ".jsonl")}`;
	return ROLE;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const verdict = decidePath({ root: ctx.cwd, tool: event.toolName, input: event.input });
		if (verdict.ok) return undefined;
		if (OUT) {
			fs.appendFileSync(
				OUT,
				`${JSON.stringify({ ts: Date.now(), ev: "guard:path_denied", data: { role: roleFor(ctx), tool: event.toolName, fragment: verdict.fragment } })}\n`,
			);
		}
		return { block: true, reason: verdict.reason };
	});
}
