// jev-memory — does Jev re-rank memory_search rows better than the FTS order?
//
//   node tools/jev-memory.mjs --queries <file.json> [--memory <dir>] [--limit 10] [--dry-run]
//
// The queries file is [{task, query, ids:[clicked record ids]}] — every orchestrator
// memory_search across the recorded runs with the ids it fetched (memory_get) right after,
// the click as the relevance label. For each query: the index's own top-N rows (bm25 over
// summary+text, all scopes, all snapshots), then one Jev call with one truth value per row
// ("this row is what the query is looking for"), and the rank of the first clicked id under
// the FTS order versus the Jev order. Reported: MRR and hits@1/@3 for both, per task and
// pooled, plus the per-query table. The label is biased toward what FTS showed (the
// orchestrator could only click a row it saw), so the comparison is within the FTS top-N.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLedger, buildIndex, search } from "../lib/memory-index.mjs";
import { askJev } from "../lib/jev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function readKey() {
	const env = (process.env.TYPESAFE_API_KEY ?? "").trim();
	if (env) return env;
	for (const dir of [ROOT, path.resolve(ROOT, "..", ".."), path.resolve(ROOT, "..")]) {
		const f = path.join(dir, ".env");
		if (fs.existsSync(f)) { const m = fs.readFileSync(f, "utf8").match(/^TYPESAFE_API_KEY=(\S+)/m); if (m) return m[1]; }
	}
	return "";
}

export function rankOf(order, clicked) {
	const set = new Set(clicked);
	const k = order.findIndex((id) => set.has(id));
	return k < 0 ? null : k + 1;
}

export function questionsFor(query, rows) {
	const state = `QUERY (what an orchestrator typed into memory_search while working on a task):\n${query}\n\nCANDIDATE ROWS:\n` + rows.map((r, k) => `[${k + 1}] id=${r.id} scope=${r.scope} kind=${r.kind} claim=${r.claim}${r.verified ? " verified" : ""}\n    ${r.summary}`).join("\n");
	const questions = {};
	rows.forEach((r, k) => { questions[`row${k + 1}`] = { type: "noul", instructions: `Row [${k + 1}] is a record the person who typed the QUERY is looking for: it answers the query or holds the fact the query is after, not merely shares words with it.` }; });
	return { state, questions };
}

async function main() {
	const argv = process.argv.slice(2);
	const spec = { queriesFile: null, memoryDir: path.join(ROOT, "memory"), limit: 10, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--queries") spec.queriesFile = path.resolve(argv[++i]);
		else if (a === "--memory") spec.memoryDir = path.resolve(argv[++i]);
		else if (a === "--limit") spec.limit = Number(argv[++i]);
		else if (a === "--dry-run") spec.dryRun = true;
	}
	if (!spec.queriesFile) { console.error("usage: node tools/jev-memory.mjs --queries <file.json> [--memory <dir>] [--limit N] [--dry-run]"); process.exit(2); }
	const queries = JSON.parse(fs.readFileSync(spec.queriesFile, "utf8")).filter((q) => Array.isArray(q.ids) && q.ids.length);
	const key = spec.dryRun ? "" : readKey();
	if (!spec.dryRun && !key) { console.error("no TYPESAFE_API_KEY"); process.exit(2); }
	const ledger = resolveLedger(path.join(spec.memoryDir, "records.jsonl"));
	const indexFile = buildIndex(spec.memoryDir, ledger);
	const scopes = [...new Set([...ledger.records.values()].map((r) => r.scope).filter(Boolean))];
	console.log(`${queries.length} labelled queries · ${ledger.records.size} records · ${scopes.length} scopes · index ${path.basename(indexFile)}`);

	const rows = [];
	for (const q of queries) {
		const hits = search(indexFile, { query: q.query, scopes, allSnapshots: true, limit: spec.limit });
		const ftsOrder = hits.map((h) => h.id);
		const ftsRank = rankOf(ftsOrder, q.ids);
		if (spec.dryRun || !hits.length) { console.log(`${q.task.padEnd(18)} fts rank ${ftsRank ?? "—"}/${hits.length}  ${q.query.slice(0, 70)}`); rows.push({ task: q.task, query: q.query, n: hits.length, ftsRank, jevRank: null }); continue; }
		const { state, questions } = questionsFor(q.query, hits);
		const r = await askJev({ state, questions, key });
		if (!r.ok) { console.log(`ERR ${r.status} ${r.errorType}  ${q.query}`); continue; }
		const scored = hits.map((h, k) => ({ id: h.id, p: r.answers[`row${k + 1}`]?.noul ?? 0, fts: k + 1 }));
		const jevOrder = [...scored].sort((a, b) => b.p - a.p || a.fts - b.fts).map((s) => s.id);
		const jevRank = rankOf(jevOrder, q.ids);
		rows.push({ task: q.task, query: q.query, n: hits.length, ftsRank, jevRank, ms: r.ms, top: scored.slice(0, spec.limit) });
		console.log(`${q.task.padEnd(18)} fts ${String(ftsRank ?? "—").padStart(2)} → jev ${String(jevRank ?? "—").padStart(2)} of ${hits.length}  ${r.ms} ms  ${q.query.slice(0, 60)}`);
	}
	const scoredRows = rows.filter((r) => r.ftsRank !== null);
	const mrr = (key) => scoredRows.reduce((s, r) => s + (r[key] ? 1 / r[key] : 0), 0) / Math.max(scoredRows.length, 1);
	const hits = (key, k) => scoredRows.filter((r) => r[key] && r[key] <= k).length;
	console.log(`\n${rows.length} queries, ${scoredRows.length} with the clicked record inside the FTS top-${spec.limit} (${rows.length - scoredRows.length} outside: the label cannot judge those)`);
	if (!spec.dryRun) {
		console.log(`MRR  fts ${mrr("ftsRank").toFixed(3)}  jev ${mrr("jevRank").toFixed(3)} · hits@1 fts ${hits("ftsRank", 1)} jev ${hits("jevRank", 1)} · hits@3 fts ${hits("ftsRank", 3)} jev ${hits("jevRank", 3)} · jev better ${scoredRows.filter((r) => r.jevRank && r.jevRank < r.ftsRank).length}, worse ${scoredRows.filter((r) => r.jevRank && r.jevRank > r.ftsRank).length}, same ${scoredRows.filter((r) => r.jevRank === r.ftsRank).length}`);
		const byTask = {};
		for (const r of scoredRows) { const b = (byTask[r.task] ??= { n: 0, fts: 0, jev: 0 }); b.n++; b.fts += r.ftsRank ? 1 / r.ftsRank : 0; b.jev += r.jevRank ? 1 / r.jevRank : 0; }
		for (const [t, b] of Object.entries(byTask)) console.log(`  ${t.padEnd(18)} n=${b.n} MRR fts ${(b.fts / b.n).toFixed(2)} jev ${(b.jev / b.n).toFixed(2)}`);
		fs.writeFileSync(path.join(ROOT, "runs", "jev-memory.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1); });
