/**
 * report-ext — the worker's `report` tool: a schema-checked account of what the worker
 * did (status, changed files, findings by claim, probe-shaped verify cases, open
 * questions). Each call appends one entry to ARBITER_REPORT_FILE and emits
 * `worker:report` to the lifecycle file. The supervisor tallies it, the approval gate
 * refuses `done` while a completed worker has none, retention files the findings as
 * worker candidates, and with report.autoProbe the verify cases run as a probe at once.
 * Registers nothing when the file is unset. Only the worker definition's `tools:` line
 * names `report`, so the orchestrator never sees it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);

const FILE = process.env.ARBITER_REPORT_FILE ?? "";

export default function (pi: ExtensionAPI) {
	if (!FILE) return;
	pi.registerTool({
		name: "report",
		description:
			"Record your report before you finish: status, a short summary, the files you changed, findings labelled observed (you ran it and saw it), interpreted (your reading) or hypothesis (not tested), verify cases as [{ id, args, expect? }] the supervisor can execute against the real code, and open questions. Call it once at the end of your work; the run cannot complete until every worker has reported.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("blocked")]),
			summary: Type.String({ minLength: 1, maxLength: 600 }),
			changed: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 }),
			findings: Type.Array(
				Type.Object({
					claim: Type.Union([Type.Literal("observed"), Type.Literal("interpreted"), Type.Literal("hypothesis")]),
					text: Type.String({ minLength: 1, maxLength: 600 }),
					evidence_refs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12 })),
					// The ledger's rule (lib/claims.mjs NEEDS_CRITERION): an interpretation or a
					// hypothesis names what would settle it, or retention files it as unreviewed.
					settlement_criterion: Type.Optional(Type.String({ maxLength: 400 })),
				}),
				{ maxItems: 20 },
			),
			verify: Type.Array(
				Type.Object({
					id: Type.String({ minLength: 1, maxLength: 40 }),
					args: Type.Array(Type.Unknown(), { maxItems: 12 }),
					expect: Type.Optional(Type.Unknown()),
				}),
				{ maxItems: 12 },
			),
			open_questions: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const entry = { ts: Date.now(), role, ...params };
			fs.mkdirSync(path.dirname(FILE), { recursive: true });
			fs.appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
			kit.emit("worker:report", ctx, {
				status: params.status,
				findings: params.findings.length,
				verify: params.verify.length,
				changed: params.changed.length,
				chars: JSON.stringify(entry).length,
				verifyCases: params.verify,
			});
			return {
				content: [{ type: "text", text: `report recorded (${params.status}; ${params.findings.length} findings, ${params.verify.length} verify cases). Finish your turn with a short message; the orchestrator sees both.` }],
				details: {},
				isError: false,
			};
		},
	});
}
