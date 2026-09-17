/**
 * fork-force guard — in an A branch of a fork, forces the orchestrator's first tool
 * call to be of a recorded action class (A-natural), or the recorded tool with the
 * recorded arguments (A-oracle). Every call of the wrong class is denied with the
 * class named until one of the right class passes (or is rewritten); the policy is
 * then spent for the rest of the run (lib/policies/fork-force.mjs has the mapping
 * and the one-shot rule).
 *
 * Opt-in per run: ARBITER_FORK_FORCE is "" (registers nothing), a JSON object
 * `{ cls, tool?, args? }` set by the fork runner in the supervisor's own env, or
 * "@<absolute path>" naming a file holding that same JSON — the fork runner
 * (tools/fork.mjs) uses the file form for A-oracle, whose recorded `args` can be
 * arbitrary JSON (a probe body, say) large enough to blow past Windows' ~32 KB
 * process-environment-block limit if carried inline. The supervisor passes either
 * form through unchanged. A named force file that cannot be read or parsed THROWS at
 * module scope rather than disarming (see optionsFromEnv). Orchestrator only — the same
 * nudge would make no sense for a worker mid-task — but harmless to load everywhere,
 * like every other guard here.
 *
 * Must precede topology.ts in supervisor.mjs GUARDS: pi returns the first blocking
 * tool_call result, and the fork's forcing must be seen before the topology nudge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { decideForce } = await import(kit.homeUrl(home, "lib", "policies", "fork-force.mjs"));

// A fork that cannot arm itself must not start. An "@<path>" force file that cannot be read
// or parsed used to leave the guard silently unregistered, and A-oracle ALWAYS uses the file
// form — so a bad path produced a run labelled A-oracle that behaved exactly like the null
// branch G, with nothing in its report saying so. Throwing here takes the agent process down
// instead, which the runner shows as a crashed replicate and excludes from the gate. Absent
// or empty still registers nothing: that is an ordinary run, not a fork that lost its orders.
function optionsFromEnv(raw: string | undefined): { cls: string; tool?: string | null; args?: Record<string, unknown> | null } | null {
	const v = (raw ?? "").trim();
	if (!v) return null;
	if (v.startsWith("@")) {
		const file = v.slice(1);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err) {
			throw new Error(`ARBITER_FORK_FORCE names a force file that cannot be read: ${file} (${(err as Error)?.message ?? String(err)})`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new Error(`ARBITER_FORK_FORCE force file ${file} is not JSON: ${(err as Error)?.message ?? String(err)}`);
		}
		if (!parsed || typeof parsed !== "object" || !(parsed as { cls?: unknown }).cls) throw new Error(`ARBITER_FORK_FORCE force file ${file} has no "cls"`);
		return parsed as { cls: string; tool?: string | null; args?: Record<string, unknown> | null };
	}
	try {
		const parsed = JSON.parse(v);
		return parsed && typeof parsed === "object" && parsed.cls ? parsed : null;
	} catch {
		return null;
	}
}

const FORCE = optionsFromEnv(process.env.ARBITER_FORK_FORCE);

export default function (pi: ExtensionAPI) {
	if (!FORCE) return;
	const state = { done: false };
	pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => {
		if (kit.roleFor(ctx) !== "orchestrator") return undefined;
		const input = event.input ?? {};
		const d = decideForce({ toolName: event.toolName, input }, FORCE, state);
		if (d.act === "deny") { kit.report("fork_force", "denied", ctx, { tool: event.toolName, wanted: FORCE.cls }); return kit.deny(d.reason); }
		if (d.act === "rewrite") { for (const k of Object.keys(input)) delete input[k]; Object.assign(input, d.input); kit.report("fork_force", "rewritten", ctx, { tool: event.toolName }); }
		return undefined;
	});
}
