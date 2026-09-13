// Searchable memory: the append-only ledger resolved into current records and
// indexed in SQLite FTS5, one file per ledger revision. A run pins one revision so
// search results cannot shift mid-investigation; the file is built by the supervisor
// before agents start or by the CLI — never inside an agent turn (DatabaseSync is
// synchronous). Readers: the extension (ext/memory-ext.ts), the supervisor's seeded
// brief, and tools/memory.mjs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { foldLog, readLog, claimOf } from "./memory.mjs";

export function resolveLedger(logFile) {
	if (!fs.existsSync(logFile)) return { revision: "empty", records: new Map() };
	const bytes = fs.readFileSync(logFile);
	if (!bytes.length) return { revision: "empty", records: new Map() };
	const revision = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	return { revision, records: foldLog(readLog(logFile)) };
}

export function indexPath(memoryDir, revision) {
	return path.join(memoryDir, "index", `${revision}.sqlite`);
}

const SCHEMA = `
CREATE TABLE records (
  id TEXT PRIMARY KEY, scope TEXT, kind TEXT, claim TEXT, status TEXT, snapshot TEXT,
  summary TEXT, text TEXT, ts INTEGER, evidence TEXT, verification TEXT,
  settlement_criterion TEXT, superseded_by TEXT, source TEXT, confidence REAL, extra TEXT
);
CREATE VIRTUAL TABLE fts USING fts5(summary, text, id UNINDEXED);
`;

export function buildIndex(memoryDir, { revision, records }) {
	const file = indexPath(memoryDir, revision);
	if (fs.existsSync(file)) return file;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const db = new DatabaseSync(tmp);
	db.exec(SCHEMA);
	const ins = db.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
	const fts = db.prepare("INSERT INTO fts (summary, text, id) VALUES (?,?,?)");
	db.exec("BEGIN");
	for (const r of records.values()) {
		const { id, scope, kind, status, snapshot, summary, text, ts, evidence, verification, settlement_criterion, superseded_by, source, confidence, ...extra } = r;
		delete extra.claim;
		ins.run(id, scope, kind, claimOf(r), status ?? "candidate", snapshot ?? null, summary ?? "", text ?? "", ts ?? 0, JSON.stringify(evidence ?? []), verification ? JSON.stringify(verification) : null, settlement_criterion ?? null, superseded_by ?? null, source ?? "", confidence ?? 0, JSON.stringify(extra));
		fts.run(summary ?? "", text ?? "", id);
	}
	db.exec("COMMIT");
	db.close();
	fs.renameSync(tmp, file);
	return file;
}

export function ftsQuery(text) {
	const terms = String(text ?? "").toLowerCase().match(/[a-z0-9_%.]+/g) ?? [];
	return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function rowToRecord(row) {
	const extra = row.extra ? JSON.parse(row.extra) : {};
	return {
		...extra,
		id: row.id,
		scope: row.scope,
		kind: row.kind,
		claim: row.claim,
		status: row.status,
		...(row.snapshot ? { snapshot: row.snapshot } : {}),
		summary: row.summary,
		text: row.text,
		ts: row.ts,
		evidence: JSON.parse(row.evidence || "[]"),
		...(row.verification ? { verification: JSON.parse(row.verification) } : {}),
		...(row.settlement_criterion ? { settlement_criterion: row.settlement_criterion } : {}),
		...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
		source: row.source,
		confidence: row.confidence,
	};
}

function compatibility(recordSnapshot, snapshot) {
	if (!recordSnapshot || !snapshot) return "unknown";
	return recordSnapshot === snapshot ? "yes" : "no";
}

export function search(indexFile, { query, scopes, kinds = null, claim = null, snapshot = null, allSnapshots = false, limit = 10 }) {
	const match = ftsQuery(query);
	if (!match || !Array.isArray(scopes) || !scopes.length) return [];
	const db = new DatabaseSync(indexFile, { readOnly: true });
	const where = ["fts MATCH ?", `r.scope IN (${scopes.map(() => "?").join(",")})`, "r.status != 'tombstoned'", "r.superseded_by IS NULL"];
	const args = [match, ...scopes];
	if (Array.isArray(kinds) && kinds.length) {
		where.push(`r.kind IN (${kinds.map(() => "?").join(",")})`);
		args.push(...kinds);
	}
	if (claim) {
		where.push("r.claim = ?");
		args.push(claim);
	}
	const sql = `SELECT r.*, bm25(fts) AS score FROM fts JOIN records r ON r.id = fts.id WHERE ${where.join(" AND ")} ORDER BY score, r.ts DESC LIMIT ?`;
	const n = Math.max(1, Math.min(10, Number(limit) || 10));
	// Over-fetch so a snapshot filter applied in JS still fills the page.
	const rows = db.prepare(sql).all(...args, allSnapshots ? n : n * 4);
	db.close();
	const out = [];
	for (const row of rows) {
		const compatible = compatibility(row.snapshot, snapshot);
		if (!allSnapshots && compatible === "no") continue;
		out.push({
			id: row.id,
			scope: row.scope,
			kind: row.kind,
			claim: row.claim,
			verified: Boolean(row.verification && JSON.parse(row.verification).reproduced),
			snapshot: row.snapshot ?? null,
			compatible,
			summary: row.summary,
			evidenceCount: JSON.parse(row.evidence || "[]").length,
			ts: row.ts,
			score: row.score,
		});
		if (out.length >= n) break;
	}
	return out;
}

export function get(indexFile, { ids, scopes }) {
	if (!Array.isArray(ids) || !ids.length || !Array.isArray(scopes) || !scopes.length) return [];
	const db = new DatabaseSync(indexFile, { readOnly: true });
	const stmt = db.prepare(`SELECT * FROM records WHERE id = ? AND scope IN (${scopes.map(() => "?").join(",")})`);
	const out = [];
	for (const id of ids.slice(0, 5)) {
		const row = stmt.get(String(id), ...scopes);
		if (row) out.push(rowToRecord(row));
	}
	db.close();
	return out;
}

export function formatRows(rows) {
	return rows
		.map((r) => {
			const date = r.ts ? new Date(r.ts).toISOString().slice(0, 10) : "?";
			const compat = r.compatible === "yes" ? "compatible" : r.compatible === "no" ? "OTHER SNAPSHOT" : "snapshot unknown";
			const head = `${r.id} · ${r.scope} · ${r.kind} · ${r.claim} · ${r.verified ? "verified" : "unverified"} · ${r.snapshot ?? "-"} · ${compat} · `;
			const tail = ` · ${r.evidenceCount} ev · ${date}`;
			return `${head}${r.summary.slice(0, Math.max(0, 200 - head.length - tail.length))}${tail}`.slice(0, 200);
		})
		.join("\n");
}

export function formatRecords(records, { perRecord = 1500, total = 4000 } = {}) {
	const parts = [];
	let used = 0;
	for (const r of records) {
		const body = r.text.length > perRecord ? `${r.text.slice(0, perRecord)} (truncated; ${r.text.length - perRecord} more chars)` : r.text;
		const block = [
			`### ${r.id} · ${r.scope} · ${r.kind} · claim: ${r.claim}${r.snapshot ? ` · snapshot: ${r.snapshot}` : ""}`,
			r.verification ? `verification: ${JSON.stringify(r.verification)}` : "verification: none",
			r.settlement_criterion ? `settlement_criterion: ${r.settlement_criterion}` : "",
			`evidence: ${r.evidence.join(", ") || "none"}`,
			body,
		]
			.filter(Boolean)
			.join("\n");
		if (used + block.length + 2 > total) {
			parts.push(`(budget for this call reached; ${records.length - parts.length} record(s) not shown)`);
			break;
		}
		parts.push(block);
		used += block.length + 2;
	}
	return parts.join("\n\n").slice(0, total);
}
