// Token accounting from a run's raw-*.jsonl streams (one per agent process, one per
// child transcript): fresh input + output per assistant message_end, plus cache reads,
// split by role. Shared by tools/kpi.mjs (E_excl) and tools/campaign.mjs (the budget),
// so both count the same thing.
import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

export function tokenTotals(dir) {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		turns = 0;
	const byRole = {};
	const rawFiles = fs.readdirSync(dir).filter((f) => /^raw-.*\.jsonl$/.test(f));
	for (const f of rawFiles) {
		const role = f.slice(4).split(/[_.]/)[0];
		for (const ev of readJsonl(path.join(dir, f))) {
			if (ev.type !== "message_end") continue;
			const m = ev.message;
			if (!m || m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input || 0;
			output += m.usage.output || 0;
			cacheRead += m.usage.cacheRead || 0;
			cacheWrite += m.usage.cacheWrite || 0;
			turns++;
			byRole[role] = (byRole[role] || 0) + (m.usage.input || 0) + (m.usage.output || 0);
		}
	}
	return { input, output, cacheRead, cacheWrite, turns, byRole };
}

/** What a hosted API would bill for the run: fresh input + generated output, no cache reads. */
export function freshTokens(dir) {
	const t = tokenTotals(dir);
	return t.input + t.output;
}

/** Share of prompt tokens the server did not have to prefill: cacheRead / (input + cacheRead), 0 when both are 0. */
export function hitRatio({ input, cacheRead }) {
	return input + cacheRead === 0 ? 0 : cacheRead / (input + cacheRead);
}

/** The roster a run used, from its summary.json: the configured specialist list, "worker"
 * for the legacy single-role config, or "—" when neither is present. */
export function rosterLabel(summary) {
	const use = summary?.config?.workers?.use;
	if (Array.isArray(use) && use.length) return use.join(",");
	if (summary?.config?.roles?.worker) return "worker";
	return "—";
}
