// The search-mode startup block: a seeded search at the pinned revision, formatted
// like a memory_search reply, within a small budget, followed by the retrieval hint.
// Run by the supervisor through the same search() the tools use, so it is
// deterministic per ledger revision.
import { search, formatRows } from "./memory-index.mjs";
import { RETRIEVAL_HINT } from "./memory-tools.mjs";

export function seededBrief({ indexFile, scopes, snapshot, query, budgetChars = 2000, revision, status = null }) {
	const rows = search(indexFile, { query, scopes, snapshot, limit: 10, status });
	const hint = `\n\n${RETRIEVAL_HINT}`;
	const shown = [];
	const ids = [];
	const header = (n) => `## MEMORY (searchable; index ${revision}; ${n} of ${rows.length} matches shown)\n\n`;
	for (const row of rows) {
		const line = formatRows([row]);
		const candidate = header(shown.length + 1) + [...shown, line].join("\n") + hint;
		if (candidate.length > budgetChars) break;
		shown.push(line);
		ids.push(row.id);
	}
	const text = (header(shown.length) + (shown.length ? shown.join("\n") : "(no matches; search for what you need)") + hint).slice(0, budgetChars);
	return { text, ids, chars: text.length, matched: rows.length };
}
