/**
 * result-handles guard — large tool results leave the projected context after two
 * turns and become handles; `recall_result` pages the original back.
 *
 * pi's `context` event fires before every provider request with the full message
 * list and accepts a replacement; the policy (lib/policies/result-handles.mjs)
 * decides, this adapter archives each handle once under ARBITER_RESULTS_DIR and
 * reports it. The session log is never edited, so the audit stays whole. Opt-in per
 * run: ARBITER_RESULT_HANDLES is "" (registers nothing), "1" (defaults) or a JSON
 * object of policy options. Fail-open: any archive error sends the original.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const policy = await import(kit.homeUrl(home, "lib", "policies", "result-handles.mjs"));

function optionsFromEnv(raw: string | undefined): Record<string, unknown> | null {
	const v = (raw ?? "").trim();
	if (!v || v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off") return null;
	if (v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on") return {};
	try {
		const parsed = JSON.parse(v);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

const OPTS = optionsFromEnv(process.env.ARBITER_RESULT_HANDLES);
const DIR = process.env.ARBITER_RESULTS_DIR ?? "";

export default function (pi: ExtensionAPI) {
	if (!OPTS || !DIR) return;
	const written = new Set<string>();
	const fileFor = (id: string) => path.join(DIR, `${id}.txt`);

	pi.on("context", async (event, ctx) => {
		try {
			const fresh: { id: string; bytes: number }[] = [];
			const archive = (id: string, text: string) => {
				if (written.has(id)) return;
				fs.mkdirSync(DIR, { recursive: true });
				const f = fileFor(id);
				if (!fs.existsSync(f)) fs.writeFileSync(f, text, { flag: "wx" });
				written.add(id);
				fresh.push({ id, bytes: Buffer.byteLength(text) });
			};
			const { messages, archived } = policy.handleMessages(event.messages, { ...OPTS, archive });
			for (const a of archived) if (fresh.some((f) => f.id === a.id)) kit.emit("handles:archived", ctx, { id: a.id, tool: a.tool, bytes: a.bytes, lines: a.lines });
			if (!archived.length) return undefined;
			return { messages };
		} catch (err) {
			console.error(`[result-handles] fail-open: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	});

	pi.registerTool({
		name: "recall_result",
		label: "Recall result",
		description: "Read an archived tool result by its handle id (h_…) from a byte offset. Returns at most 16 KB or 400 lines per call with next_offset and eof in the header.",
		parameters: Type.Object({
			id: Type.String({ description: "Handle id from a placeholder, like h_0123456789ab" }),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const reply = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, isError });
			if (!policy.isHandleId(params.id)) return reply(`unknown handle id: ${params.id}`, true);
			const f = fileFor(params.id);
			if (!fs.existsSync(f)) return reply(`no archived result for ${params.id}`, true);
			const offset = params.offset ?? 0;
			const s = policy.readSlice(f, offset);
			kit.emit("handles:recalled", ctx, { id: params.id, offset, bytes: s.bytes });
			return reply(`[recall_result id=${params.id} offset=${offset} next_offset=${s.nextOffset} eof=${s.eof}]\n[chunk_bytes=${s.bytes} chunk_lines=${s.lines}; use next_offset to continue]\n${s.text}`);
		},
	});
}
