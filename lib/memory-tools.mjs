// The two memory tools' behaviour, kept pure so it is unit-tested without pi:
// ext/memory-ext.ts is a thin adapter. Scope and budget are enforced here, on every
// call, from the environment the supervisor set.
import { search, get, formatRows, formatRecords } from "./memory-index.mjs";
import { charge, spent, wouldExceed } from "./memory-budget.mjs";

export const RETRIEVAL_HINT =
	"Memory is searchable. memory_search(query) lists matching records (id, scope, kind, claim, verified or not, snapshot, one-line summary); rows are references, not evidence. memory_get(ids) returns the full text, claim, settlement criterion, verification and evidence of up to 5 records. Both draw on one per-run character budget shared by every agent in the run; the tools state what remains. A claim marked 'verified' had its query reproduced by the oracle on the named snapshot; 'unverified' means nobody checked. interpreted and hypothesis records are not facts: their settlement_criterion says what would settle them.";

export function readToolEnv(env) {
	if (!env.ARBITER_MEMORY_INDEX) return null;
	let scopes = [];
	try {
		scopes = JSON.parse(env.ARBITER_MEMORY_SCOPES || "[]");
	} catch {
		scopes = [];
	}
	return {
		indexFile: env.ARBITER_MEMORY_INDEX,
		scopes,
		budget: Number(env.ARBITER_MEMORY_BUDGET) || 0,
		ledger: env.ARBITER_MEMORY_LEDGER || "",
		snapshot: env.ARBITER_SNAPSHOT || null,
	};
}

function refusal(cfg, role, detail) {
	const s = spent(cfg.ledger);
	if (cfg.ledger) charge(cfg.ledger, { role, tool: "refused", chars: 0, detail });
	return { text: `memory budget: ${s.chars} of ${cfg.budget} characters used; this call would exceed it, so nothing was returned. Work from what you already retrieved.`, chars: 0, refused: true };
}

function deliver(cfg, role, tool, text, detail) {
	if (cfg.ledger && wouldExceed(cfg.ledger, cfg.budget, text.length)) return refusal(cfg, role, detail);
	const total = cfg.ledger ? charge(cfg.ledger, { role, tool, chars: text.length, detail }) : text.length;
	return { text: `${text}\n(memory budget: ${total} of ${cfg.budget} characters used)`, chars: text.length, refused: false };
}

export function searchTool(cfg, params, role) {
	const query = String(params?.query ?? "").trim();
	if (!query) return { text: "no query given", chars: 0, refused: false, rows: 0 };
	const rows = search(cfg.indexFile, {
		query,
		scopes: cfg.scopes,
		kinds: Array.isArray(params?.kinds) && params.kinds.length ? params.kinds : null,
		claim: params?.claim || null,
		snapshot: cfg.snapshot,
		allSnapshots: Boolean(params?.all_snapshots),
		limit: params?.limit ?? 10,
	});
	const body = rows.length ? formatRows(rows) : `no matching records for "${query}" in scopes ${cfg.scopes.join(", ")}`;
	return { ...deliver(cfg, role, "search", body, query), rows: rows.length };
}

export function getTool(cfg, params, role) {
	const ids = Array.isArray(params?.ids) ? params.ids.map(String).slice(0, 5) : [];
	if (!ids.length) return { text: "no ids given", chars: 0, refused: false, records: 0 };
	const records = get(cfg.indexFile, { ids, scopes: cfg.scopes });
	const found = new Set(records.map((r) => r.id));
	const missing = ids.filter((id) => !found.has(id));
	// 3 800 for the records so the budget footer keeps the whole reply under 4 000.
	let body = records.length ? formatRecords(records, { perRecord: 1500, total: 3800 }) : "";
	if (missing.length) body += `${body ? "\n\n" : ""}not found: ${missing.join(", ")}`;
	return { ...deliver(cfg, role, "get", body, ids.join(",")), records: records.length };
}
