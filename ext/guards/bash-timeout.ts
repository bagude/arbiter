/**
 * bash-timeout guard — injects a timeout into every bash call that lacks one.
 *
 * pi's bash tool has no default timeout; the supervisor's watchdog aborts 90 s after
 * the fact and cannot reach a background worker. Rewriting the argument on the
 * tool_call edge makes pi enforce the limit itself, before anything hangs. Never
 * blocks; reports `guard:bash_timeout_rewritten` {from, to}.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// ext/guards/ → two levels up; a workspace copy relies on ARBITER_HOME.
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { decideBashTimeout } = await import(kit.homeUrl(home, "lib", "policies", "bash-timeout.mjs"));

// One number, one source: the supervisor sets ARBITER_BASH_TIMEOUT_SEC from
// caps.bashTimeoutSec. pi's own hard maximum is the clamp.
const DEFAULT_SEC = Number(process.env.ARBITER_BASH_TIMEOUT_SEC) > 0 ? Number(process.env.ARBITER_BASH_TIMEOUT_SEC) : 90;
const MAX_SEC = Number(process.env.ARBITER_BASH_TIMEOUT_MAX_SEC) > 0 ? Number(process.env.ARBITER_BASH_TIMEOUT_MAX_SEC) : 600;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const verdict = decideBashTimeout({ input: event.input, defaultSec: DEFAULT_SEC, maxSec: MAX_SEC });
		if (verdict.ok) return undefined;
		const from = (event.input as { timeout?: unknown }).timeout ?? null;
		Object.assign(event.input, verdict.rewrite); // pi reads the mutated input
		kit.report("bash_timeout", "rewritten", ctx, { from, to: verdict.rewrite.timeout });
		return undefined;
	});
}
