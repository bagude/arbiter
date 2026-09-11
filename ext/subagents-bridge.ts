/**
 * subagents-bridge — forwards @gotgenes/pi-subagents lifecycle events to a file.
 *
 * The package emits its lifecycle on pi's extension-only event bus; rpc-mode does
 * not forward those to an external client. This runs host-side inside the
 * orchestrator's pi process and writes one JSON line per event so the supervisor
 * can tail them exactly like it tails the mail bus. Large payloads (a worker's
 * final result) are capped here — the full text lives in the child's transcript.
 */
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LIFECYCLE_EVENTS = [
	"subagents:created",
	"subagents:started",
	"subagents:update",
	"subagents:completed",
	"subagents:failed",
	"subagents:resuming",
	"subagents:resumed",
	"subagents:steered",
	"subagents:compacted",
];
const OUT = process.env.ARBITER_LIFECYCLE_FILE ?? "";
const CAP = 1500;

function cap(value: unknown): unknown {
	if (typeof value === "string" && value.length > CAP) return `${value.slice(0, CAP)}…[truncated, ${value.length} chars total]`;
	if (Array.isArray(value)) return value.map(cap);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cap(v)]));
	return value;
}

export default function (pi: ExtensionAPI) {
	if (!OUT) return;
	for (const ev of LIFECYCLE_EVENTS) {
		pi.events.on(ev, (data: unknown) => {
			fs.appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), ev, data: cap(data) })}\n`);
		});
	}
}
