/**
 * jev-shadow — asks TypeSafe.ai's Jev the four decision questions at every orchestrator
 * inference, in parallel with the model's own decode, and writes the answers beside the
 * captured request (<ARBITER_JEV_DIR>/<n>.json, same sequence numbers as
 * ARBITER_REQUESTS_DIR). Observability only: nothing is blocked, nothing is delivered to the
 * model, and no failure of the call can fail the run.
 *
 * Opt-in per run: ARBITER_JEV_DIR unset or no TYPESAFE_API_KEY → registers nothing. Orchestrator
 * only (workers share the process; roleFor tells them apart by session path).
 *
 * The state Jev sees is lib/jev.mjs renderState over the same payload the provider gets, so
 * the shadow's row and tools/jev-replay.mjs's row for the same request are the same question
 * to the same state. The scoring happens later, offline, once the decision the model actually
 * took is known (tools/jev-replay.mjs --join).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const fileUrl = (p: string) => new URL(`file:///${p.replace(/\\/g, "/")}`).href;

const DIR = (process.env.ARBITER_JEV_DIR ?? "").trim();
const KEY = (process.env.TYPESAFE_API_KEY ?? "").trim();
// The key is read once and removed from the process environment: the orchestrator has a bash
// tool, workers run in this process, and `env` would otherwise print it into the transcript.
delete process.env.TYPESAFE_API_KEY;
// The Jev import chain (lib/jev.mjs → tools/decision-points.mjs → …) loads only when the shadow
// is on, so an import-time fault there can never touch a run that does not use it.
const kit = DIR && KEY ? await import(fileUrl(path.join(home, "ext", "guard-kit.ts"))) : null;
const jev = DIR && KEY ? await import(fileUrl(path.join(home, "lib", "jev.mjs"))) : null;
const MAX_CHARS = Number(process.env.ARBITER_JEV_MAX_CHARS) || undefined;
const REDACT = process.env.ARBITER_JEV_REDACT === "1";

export default function (pi: ExtensionAPI) {
	if (!DIR || !KEY || !kit || !jev) return;
	let seq = 0;
	pi.on("before_provider_request", (event: { payload: unknown }, ctx: unknown) => {
		if (kit.roleFor(ctx) !== "orchestrator") return undefined;
		seq += 1;
		const mySeq = seq;
		const payload = event.payload;
		// Fire and forget: the provider call proceeds immediately; the answer lands on disk
		// whenever it lands. A rejected promise is swallowed — shadowing never fails a run.
		(async () => {
			try {
				fs.mkdirSync(DIR, { recursive: true });
				const ts = Date.now();
				const r = await jev.askWithRetry({ payload, key: KEY, maxChars: MAX_CHARS, redactSecrets: REDACT });
				fs.writeFileSync(path.join(DIR, `${String(mySeq).padStart(4, "0")}.json`), JSON.stringify({ seq: mySeq, ts, ...r }));
			} catch {
				// observability only
			}
		})();
		return undefined;
	});
}
