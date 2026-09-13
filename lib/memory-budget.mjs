// The run's memory delivery budget: one append-only JSONL file in the run directory.
// The supervisor charges the startup seed; every memory tool call appends what it
// delivered. Because the file is per run, the orchestrator, every worker and every
// resumed worker share one allowance, whichever process they run in. Characters are a
// delivery budget, not a context measurement.
import fs from "node:fs";

export function charge(ledgerFile, { role, tool, chars, detail = "", records }) {
	fs.appendFileSync(ledgerFile, `${JSON.stringify({ ts: Date.now(), role: String(role ?? "unknown"), tool, chars: Number(chars) || 0, detail: String(detail).slice(0, 200), ...(typeof records === "number" ? { records } : {}) })}\n`);
	return spent(ledgerFile).chars;
}

export function spent(ledgerFile) {
	const out = { chars: 0, calls: {}, refused: 0, byRole: {} };
	if (!ledgerFile || !fs.existsSync(ledgerFile)) return out;
	for (const line of fs.readFileSync(ledgerFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.tool === "refused") {
			out.refused++;
			continue;
		}
		out.chars += e.chars;
		out.calls[e.tool] = (out.calls[e.tool] ?? 0) + 1;
		out.byRole[e.role] = (out.byRole[e.role] ?? 0) + e.chars;
	}
	return out;
}

export function wouldExceed(ledgerFile, budget, chars) {
	return spent(ledgerFile).chars + chars > budget;
}
