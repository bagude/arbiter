// The two memory tools' behaviour, kept pure so it is unit-tested without pi:
// ext/memory-ext.ts is a thin adapter. Scope and budget are enforced here, on every
// call, from the environment the supervisor set.
import fs from "node:fs";
import path from "node:path";
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
		// Part of the budget only workers may spend: the orchestrator reads memory
		// first and, without a reserve, can leave its worker nothing to fetch with
		// (seen live: dw-water-bench run 1 needed four done attempts).
		workerReserve: Number(env.ARBITER_MEMORY_WORKER_RESERVE) || 0,
		ledger: env.ARBITER_MEMORY_LEDGER || "",
		snapshot: env.ARBITER_SNAPSHOT || null,
		rememberFile: env.ARBITER_REMEMBER_FILE || "",
	};
}

const isWorker = (role) => String(role ?? "").startsWith("worker");
const capFor = (cfg, role) => (isWorker(role) ? cfg.budget : Math.max(0, cfg.budget - (cfg.workerReserve ?? 0)));

function refusal(cfg, role, detail) {
	const s = spent(cfg.ledger);
	if (cfg.ledger) charge(cfg.ledger, { role, tool: "refused", chars: 0, detail });
	const reserve = !isWorker(role) && cfg.workerReserve ? ` (${cfg.workerReserve} of the ${cfg.budget} are reserved for workers)` : "";
	return { text: `memory budget: ${s.chars} of ${cfg.budget} characters used${reserve}; this call would exceed what ${isWorker(role) ? "the run" : "you"} may spend, so nothing was returned. Work from what you already retrieved.`, chars: 0, refused: true };
}

function deliver(cfg, role, tool, text, detail, extra = {}) {
	if (cfg.ledger && wouldExceed(cfg.ledger, capFor(cfg, role), text.length)) return refusal(cfg, role, detail);
	const total = cfg.ledger ? charge(cfg.ledger, { role, tool, chars: text.length, detail, ...extra }) : text.length;
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
		// Five rows by default: ten rows cost as much as three full records (about 2 000
		// characters), and the orchestrator's first search should not spend its share.
		limit: params?.limit ?? 5,
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
	return { ...deliver(cfg, role, "get", body, ids.join(","), { records: records.length }), records: records.length };
}

const REMEMBER_LIMIT = 5;

// A worker's candidate lesson, appended to a run-local file for a human to review;
// never read back by any agent. `state` is a per-process Map<role, count> the caller
// owns (module-level in ext/memory-ext.ts) so the limit holds across calls in one
// run without a file read on every call.
export function rememberTool(cfg, params, role, state) {
	if (!isWorker(role)) {
		return { refused: true, text: "remember is for workers; the orchestrator's findings go through its report" };
	}
	const text = String(params?.text ?? "").trim();
	if (text.length < 20 || text.length > 600) {
		return { refused: true, text: "remember needs 20–600 characters: say what you learned, where the evidence is, and when it applies" };
	}
	const count = state.get(role) ?? 0;
	if (count >= REMEMBER_LIMIT) {
		return { refused: true, text: "remember limit reached (5 per worker run); put further lessons in your report" };
	}
	const evidence_refs = Array.isArray(params?.evidence_refs) ? params.evidence_refs.map(String) : [];
	const entry = { ts: Date.now(), role, text, evidence_refs, chars: text.length };
	fs.mkdirSync(path.dirname(cfg.rememberFile), { recursive: true });
	fs.appendFileSync(cfg.rememberFile, `${JSON.stringify(entry)}\n`);
	// Accounting only: remember does not draw on the shared retrieval budget (its own
	// 5-calls x 600-chars caps above are the bound), but a ledger line still records it
	// so `spent().calls.remember` and the per-role breakdown stay accurate.
	if (cfg.ledger) charge(cfg.ledger, { role, tool: "remember", chars: 0, detail: text.slice(0, 80) });
	const next = count + 1;
	state.set(role, next);
	return { refused: false, text: `remembered as a candidate for review (${next} of ${REMEMBER_LIMIT} this run)`, chars: text.length };
}
