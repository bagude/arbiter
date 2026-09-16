/**
 * memory-ext — the two memory tools, memory_search and memory_get, over the pinned
 * index the supervisor built for this run. Behaviour lives in lib/memory-tools.mjs
 * (scope and budget enforced there on every call); this file registers the tools
 * with pi and reports each call to the lifecycle file. Parents load it via `-e`;
 * pi-subagents workers load the copy under <workspace>/.pi/extensions/.
 *
 * With no ARBITER_MEMORY_INDEX in the environment (memory mode off or inject) it
 * registers nothing, so the tool names in the role allowlists resolve to nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const tools = await import(kit.homeUrl(home, "lib", "memory-tools.mjs"));

// Per-process call counts for `remember`, keyed by role (worker:<id> or orchestrator).
// Module-level so the 5-per-run limit holds across calls within one run without a
// file read on every call; a fresh process (a fresh run) starts a fresh Map.
const rememberState = new Map<string, number>();

export default function (pi: ExtensionAPI) {
	const cfg = tools.readToolEnv(process.env);
	if (!cfg) return;
	const reply = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {}, isError: false });

	pi.registerTool({
		name: "memory_search",
		label: "Search memory",
		description: `Search the run's memory (scopes ${cfg.scopes.join(", ")}). Returns 5 rows by default (limit up to 10): id · scope · kind · claim · verified/unverified · snapshot · compatibility · summary · evidence count · date. Each row costs about 200 characters of the budget. Rows are references, not evidence; fetch ids with memory_get. Records from other data snapshots are hidden unless all_snapshots is true. Every call draws on the run's shared character budget of ${cfg.budget}.`,
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query; terms are matched against summaries and full text and ranked." }),
			kinds: Type.Optional(Type.Array(Type.Union([Type.Literal("semantic"), Type.Literal("question"), Type.Literal("procedural"), Type.Literal("episodic")]))),
			claim: Type.Optional(Type.Union([Type.Literal("observed"), Type.Literal("interpreted"), Type.Literal("hypothesis"), Type.Literal("unreviewed")])),
			all_snapshots: Type.Optional(Type.Boolean({ description: "Include records made against other data snapshots (each row names its snapshot)." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const r = tools.searchTool(cfg, params, role);
			kit.emit(r.refused ? "memory:refused" : "memory:search", ctx, { chars: r.chars, detail: params.query });
			return reply(r.text);
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Get memory records",
		description: "Fetch up to 5 memory records by id: full text, claim, settlement criterion, verification (what the oracle reproduced, on which snapshot), evidence references. At most 4000 characters per call; ids outside this run's scopes answer 'not found'. Draws on the shared budget.",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const r = tools.getTool(cfg, params, role);
			kit.emit(r.refused ? "memory:refused" : "memory:get", ctx, { chars: r.chars, detail: params.ids.join(",") });
			return reply(r.text);
		},
	});

	if (!cfg.rememberFile) return;

	pi.registerTool({
		name: "remember",
		label: "Remember a lesson",
		description:
			"Save one lesson for future workers of your kind, as a candidate a human will review. Say what you learned, where the evidence is (file, test, command), and when it applies. Not for task-specific facts.",
		parameters: Type.Object({
			text: Type.String({ description: "20-600 characters: what you learned, where the evidence is, and when it applies." }),
			evidence_refs: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const r = tools.rememberTool(cfg, params, role, rememberState);
			kit.emit(r.refused ? "memory:refused" : "memory:remember", ctx, { chars: r.refused ? 0 : r.chars, detail: r.refused ? r.text : String(params.text).slice(0, 80) });
			return reply(r.text);
		},
	});
}
