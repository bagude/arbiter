/**
 * guard-kit — the shared shape of an in-band guard.
 *
 * A guard is a pi extension on the tool_call (or tool_result) edge: a pure policy
 * in lib/policies decides, the extension applies — block with a redirect, or rewrite
 * the tool's input in place — and reports what it did to the lifecycle file the
 * supervisor tails. This file holds the three things every guard needs so the
 * second guard is fifteen lines, not fifty: where the arbiter checkout is (guards
 * run from ext/ for parents and from a workspace copy under .pi/extensions for
 * workers), which role is calling, and how to report.
 *
 * Guards import this file and their policy by file URL through arbiterHome(), never
 * relatively: the workspace copy has no siblings.
 */
import fs from "node:fs";
import path from "node:path";

/** The arbiter checkout: ARBITER_HOME when the supervisor set it, else `depth` levels above `here`. */
export function arbiterHome(here: string, depth: number): string {
	if (process.env.ARBITER_HOME) return process.env.ARBITER_HOME;
	return path.resolve(here, ...Array.from({ length: depth }, () => ".."));
}

/** file:// URL for a path under the arbiter checkout, for dynamic import. */
export function homeUrl(home: string, ...rel: string[]): string {
	return new URL(`file:///${path.join(home, ...rel).replace(/\\/g, "/")}`).href;
}

// Workers run inside the orchestrator's process, so AGENT_NAME says "orchestrator"
// for them too. Their session file lives under <parent session>/tasks/<id>.jsonl,
// and <id> is the name the supervisor already gives the worker (lib/child-transcripts.mjs
// workerIdFromTranscript) — derive the role from the same place.
export function roleFor(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string {
	const file = ctx.sessionManager?.getSessionFile?.();
	if (file && /[\\/]tasks[\\/][^\\/]+\.jsonl$/.test(file)) return `worker:${path.basename(file, ".jsonl")}`;
	return process.env.AGENT_NAME ?? "unknown";
}

const OUT = process.env.ARBITER_LIFECYCLE_FILE ?? "";

/** Append `guard:<name>_<kind>` with `{ role, ...data }` to the lifecycle file (no-op when unset). */
export function report(name: string, kind: string, ctx: Parameters<typeof roleFor>[0], data: Record<string, unknown>): void {
	if (!OUT) return;
	fs.appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), ev: `guard:${name}_${kind}`, data: { role: roleFor(ctx), ...data } })}\n`);
}

/** The tool_call result that blocks execution; `reason` is what the model reads. */
export function deny(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}
