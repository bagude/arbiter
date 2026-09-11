/**
 * send_mail — the ONLY sanctioned channel between the two agents.
 *
 * Runs host-side inside the pi process (extensions always do). It appends to a
 * fixed bus file chosen by the supervisor; the agent never picks the path.
 * The supervisor tails the bus and relays messages — agents cannot read the
 * bus, only write to it through this tool.
 */
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ME = process.env.AGENT_NAME ?? "unknown";
const PEER = process.env.PEER ?? "";
const BUS = process.env.BUS_FILE ?? "";
const MAX_BODY = 8000;

// A small model reads this description at the exact moment it picks the "kind"
// enum value — what it says there matters more than what a prompt says
// elsewhere. "done" means something different for each role, so it's worded
// per-role rather than with one generic line that's only half-true for whoever
// reads it.
// Solo (N=1 ablation) runs have no counterpart at all: BUILDER's only recipient is
// the supervisor, and kind="done" goes straight to the hidden acceptance test.
const SOLO = PEER === "supervisor";
const DONE_HINT =
	ME === "critic"
		? 'kind="done" is your APPROVAL. It only goes through if you have probed the code as it currently stands and it is not mid-edit — the supervisor tells you exactly why if it does not, and the fix is always to probe again, never to resend the same approval.'
		: ME === "orchestrator"
			? 'kind="done" claims the shared workspace is complete and triggers the hidden acceptance test. It only goes through if you have probed the workspace as it currently stands and no worker is mid-edit — the supervisor tells you why if it does not, and the fix is always a fresh probe, never resending the same claim.'
			: SOLO
				? 'kind="done" tells the supervisor your implementation is complete and self-tested; it triggers the hidden acceptance test immediately. Other kinds are acknowledged but nobody answers them — there is no counterpart in this run.'
				: 'kind="done" is your own completion signal — send it once your tests pass. Your counterpart verifies independently; you do not need to keep re-justifying it after you send it.';

// Only CRITIC's and ORCHESTRATOR's probes are host-executed (the supervisor routes
// kind="probe" from the pattern's verifier role). A probe sent from BUILDER used to be silently
// relayed as an ordinary, unexecuted mail — confirmed live to cause a mutual
// stall where both agents waited on a "run" that was never going to happen.
// Dropping the kind entirely for BUILDER (rather than just warning about it)
// removes the option before a small model can reach for it.
const PROBE_KIND = ME === "critic" || ME === "orchestrator" ? [Type.Literal("probe")] : [];
const PROBE_HINT =
	ME === "critic" || ME === "orchestrator"
		? 'kind="probe" is special: the supervisor intercepts it (your counterpart never sees it), executes it ' +
			'host-side against the real current code, and replies to you directly with real values, echoing back the exact ' +
			'args it ran — check that echo against what you meant to send before concluding a result is wrong. Body must be a ' +
			'JSON array of {"id": "...", "args": [...]} — one entry per call to the target function, "args" being its ' +
			'positional arguments. Optionally add "expect" to a case (either a literal expected return value, or ' +
			'{"throws":"SyntaxError"}) and the supervisor will tell you match/mismatch directly instead of you having to ' +
			"compare by eye. Use probes instead of asking your counterpart to self-report test results. A case whose exact " +
			"args you already probed against this same, unchanged code is NOT re-executed — the supervisor blocks it and " +
			"returns the prior answer instead of running it again, because re-sending it cannot produce a different result."
		: "";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "send_mail",
		label: "Send mail",
		description:
			(ME === "orchestrator"
				? `Send a message to the supervisor (to="supervisor"). Workers are not reachable by mail; use the subagent tools for them. `
				: SOLO
					? `Send a message to the supervisor (to="supervisor"). There is no counterpart agent in this run. `
					: `Send a message to your counterpart "${PEER}". This is your ONLY channel to them. `) +
			`Body is capped at ${MAX_BODY} characters. ${DONE_HINT}${PROBE_HINT ? ` ${PROBE_HINT}` : ""}`,
		parameters: Type.Object({
			to: Type.String({ description: `Recipient. Must be "${PEER}".` }),
			kind: Type.Union(
				(ME === "orchestrator"
					? ["status", "done", "probe"]
					: ["question", "answer", "proposal", "status", "done", ...(PROBE_KIND.length ? ["probe"] : [])]
				).map((k) => Type.Literal(k)),
				{ description: "What this message is doing." },
			),
			body: Type.String({
				description:
					ME === "critic" || ME === "orchestrator"
						? "Message text, or for kind=probe, a JSON array of {id, args, expect?}."
						: "Message text.",
			}),
		}),
		async execute(_toolCallId, params) {
			if (!BUS) {
				return { content: [{ type: "text", text: "mail system not configured" }], details: {}, isError: true };
			}
			if (params.to !== PEER) {
				return {
					content: [{ type: "text", text: `unknown recipient "${params.to}"; only "${PEER}" exists` }],
					details: {},
					isError: true,
				};
			}
			let body = params.body ?? "";
			let truncated = false;
			if (body.length > MAX_BODY) {
				body = body.slice(0, MAX_BODY);
				truncated = true;
			}
			const msg = { ts: Date.now(), from: ME, to: params.to, kind: params.kind, body, truncated };
			fs.appendFileSync(BUS, `${JSON.stringify(msg)}\n`);
			return {
				content: [{ type: "text", text: truncated ? `delivered (truncated to ${MAX_BODY} chars)` : "delivered" }],
				details: {},
			};
		},
	});
}
