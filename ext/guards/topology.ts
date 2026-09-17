/**
 * topology guard — nudges the orchestrator when it spawns a specialist whose
 * declared workspace needs are unmet. In this slice the one checked need is
 * `tests`: a file under src/__tests__/ that the orchestrator has read since it was
 * written (lib/policies/topology-policy.mjs has the rule and the reasons).
 *
 * Opt-in per run: ARBITER_TOPOLOGY is "" (registers nothing) or JSON
 * { mode: "nudge" | "enforce", needs: { <specialist>: [artifacts] } } built by the
 * supervisor from the selected roster. Only the orchestrator calls `subagent`; the
 * guard is loaded everywhere like the others and does nothing elsewhere.
 *
 * Must precede pre-spawn-compact.ts in supervisor.mjs GUARDS: pi returns the first
 * blocking result, and this guard's reason is the one the model needs first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { initialState, noteToolCall, decideSpawn } = await import(kit.homeUrl(home, "lib", "policies", "topology-policy.mjs"));

function optionsFromEnv(raw: string | undefined): { mode: string; needs: Record<string, string[]> } | null {
	const v = (raw ?? "").trim();
	if (!v) return null;
	try {
		const parsed = JSON.parse(v);
		if (!parsed || typeof parsed !== "object" || !parsed.mode) return null;
		return { mode: String(parsed.mode), needs: parsed.needs ?? {} };
	} catch {
		return null;
	}
}

const OPTS = optionsFromEnv(process.env.ARBITER_TOPOLOGY);

function testsFiles(cwd: string): { mtimeMs: number }[] {
	const dir = path.join(cwd, "src", "__tests__");
	if (!fs.existsSync(dir)) return [];
	const out: { mtimeMs: number }[] = [];
	// A worker may be mid-edit (replacing the directory, or a file inside it) between
	// this existsSync check and the reads below. Any fs error here means "nothing
	// usable yet" — decideSpawn treats an empty list as tests:missing, never letting
	// the exception escape the tool_call handler.
	const walk = (d: string) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				try {
					out.push({ mtimeMs: fs.statSync(p).mtimeMs });
				} catch {
					// vanished between readdir and stat; skip it.
				}
			}
		}
	};
	walk(dir);
	return out;
}

export default function (pi: ExtensionAPI) {
	if (!OPTS) return;
	const state = initialState();
	pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => {
		const input = event.input ?? {};
		noteToolCall({ toolName: event.toolName, input }, state, Date.now());
		if (event.toolName !== "subagent") return undefined;
		const d = decideSpawn({ mode: OPTS.mode, needsFor: OPTS.needs, input, state, testsFiles: testsFiles(ctx.cwd) });
		const specialist = String(input.subagent_type ?? "");
		if (d.event === "skipped") kit.report("topology", "skipped", ctx, { specialist, reason: d.reason });
		else if (d.event === "waived") kit.report("topology", "waived", ctx, { specialist, failed: d.failed });
		else if (d.event === "denied") kit.report("topology", "denied", ctx, { specialist, failed: d.failed, mode: OPTS.mode });
		if (!d.ok) return kit.deny(d.reason);
		return undefined;
	});
}
