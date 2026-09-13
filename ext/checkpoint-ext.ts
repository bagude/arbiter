/**
 * checkpoint-ext — the orchestrator's `checkpoint` tool: the judgement half of
 * what survives a compaction (findings by claim, open questions, next steps). Each
 * call appends one entry to ARBITER_CHECKPOINT_FILE and reports it to the lifecycle
 * file; the supervisor folds the latest entry into the compaction instructions
 * next to its own deterministic ledger. Registers nothing when the file is unset.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);

const FILE = process.env.ARBITER_CHECKPOINT_FILE ?? "";

export default function (pi: ExtensionAPI) {
	if (!FILE) return;
	let n = 0;
	try {
		if (fs.existsSync(FILE)) n = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).length;
	} catch {
		n = 0;
	}
	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Record what you know right now so it survives a context compaction: findings (each with a claim: observed = the rows/results show it, interpreted = your explanation, hypothesis = a conjecture), open questions, and next steps. Keep every id (probe ids, memory ids m_…, worker ids, handle ids h_…) verbatim. The supervisor asks for one before it compacts; you may also call it after finishing a phase.",
		parameters: Type.Object({
			findings: Type.Array(
				Type.Object({
					claim: Type.Union([Type.Literal("observed"), Type.Literal("interpreted"), Type.Literal("hypothesis")]),
					text: Type.String({ minLength: 1, maxLength: 600 }),
					evidence_refs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12 })),
				}),
				{ maxItems: 24 },
			),
			open_questions: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 }),
			next_steps: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			n++;
			const entry = { ts: Date.now(), n, findings: params.findings, open_questions: params.open_questions, next_steps: params.next_steps };
			fs.mkdirSync(path.dirname(FILE), { recursive: true });
			fs.appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
			kit.emit("checkpoint:written", ctx, { n, findings: params.findings.length, questions: params.open_questions.length, steps: params.next_steps.length, chars: JSON.stringify(entry).length });
			return { content: [{ type: "text", text: `checkpoint #${n} recorded (${params.findings.length} findings, ${params.open_questions.length} questions, ${params.next_steps.length} steps)` }], details: { n }, isError: false };
		},
	});
}
