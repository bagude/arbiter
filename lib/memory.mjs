// Arbiter's memory: what should remain useful across runs, as distinct from what
// happened (runs/* is the raw ledger and is never fed back to an agent).
//
// Store: memory/records.jsonl — append-only; a line is either a record or an op
// ({op: "promote"|"tombstone", id}). foldLog() replays it into the current state.
// Tombstones are ops, never deletions, so forgotten knowledge cannot silently
// reappear. memory/wiki/ is a Markdown wiki COMPILED from the log and the run
// summaries (lib/wiki.mjs) — regenerated, never the source, never hand-edited.
//
// Governance: a record's writer never promotes it. Supervisor/oracle-sourced records
// auto-promote only when their evidence includes an oracle outcome — facts the host
// can vouch for. Agent-sourced records stay candidates until a human (or, later, a
// paired run) promotes them. Recall reads the wiki's scope pages (promoted only).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildPages, lint, renderLint } from "./wiki.mjs";

/** Where the store lives relative to the arbiter checkout: memory/records.jsonl + memory/wiki/. */
export function memoryPaths(home) {
	const dir = path.join(home, "memory");
	return { dir, log: path.join(dir, "records.jsonl"), wiki: path.join(dir, "wiki"), runs: path.join(home, "runs") };
}

/** Every runs/<id>/summary.json on disk, as Map<runId, summary>. */
export function loadRunSummaries(home) {
	const { runs } = memoryPaths(home);
	const out = new Map();
	if (!fs.existsSync(runs)) return out;
	for (const d of fs.readdirSync(runs)) {
		if (d.startsWith(".")) continue;
		const p = path.join(runs, d, "summary.json");
		if (!fs.existsSync(p)) continue;
		try {
			const s = JSON.parse(fs.readFileSync(p, "utf8"));
			out.set(s.runId ?? d, s);
		} catch {
			// an unreadable summary is a missing run to the wiki
		}
	}
	return out;
}

/**
 * Compile the wiki from the log and the run summaries into memory/wiki/, replacing
 * what was there (and the legacy memory/<scope>.md projections). Returns the pages.
 */
export function renderAll(home, { now = Date.now() } = {}) {
	const { dir, log, wiki } = memoryPaths(home);
	const records = foldLog(readLog(log));
	const runSummaries = loadRunSummaries(home);
	const pages = buildPages({ records, runSummaries, now });
	pages.set("LINT.md", renderLint(lint({ records, runSummaries, now }), now));
	fs.rmSync(wiki, { recursive: true, force: true });
	for (const [rel, md] of pages) {
		const p = path.join(wiki, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, md);
	}
	if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) fs.rmSync(path.join(dir, f));
	return pages;
}

export const KINDS = ["episodic", "semantic", "procedural"];
export const SOURCES = ["supervisor", "oracle", "agent", "human"];

// Scopes: "global", "task:<name>" (one task's runs), "repo:<name>" (every task that
// works on one external repository — the memory of "the agent for that repo").
function validScope(scope) {
	return scope === "global" || /^(task|repo):[\w.-]+$/.test(scope);
}

export function makeRecord({ id, scope, kind, text, evidence = [], confidence = 0.5, source, status, ts = Date.now() }) {
	if (!KINDS.includes(kind)) throw new Error(`memory record kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
	if (!validScope(scope)) throw new Error(`memory record scope must be "global", "task:<name>" or "repo:<name>", got ${JSON.stringify(scope)}`);
	if (!SOURCES.includes(source)) throw new Error(`memory record source must be one of ${SOURCES.join(", ")}, got ${JSON.stringify(source)}`);
	const hostVouched = (source === "supervisor" || source === "oracle") && evidence.some((e) => String(e).startsWith("oracle:"));
	return {
		id: id ?? `m_${randomBytes(6).toString("hex")}`,
		ts,
		scope,
		kind,
		text: String(text).trim(),
		evidence: [...evidence],
		confidence,
		source,
		status: status ?? (hostVouched ? "promoted" : "candidate"),
	};
}

/** Replay the append-only log into Map<id, record> with the latest status applied. */
export function foldLog(log) {
	const out = new Map();
	for (const entry of log) {
		if (!entry) continue;
		if (entry.op) {
			const r = out.get(entry.id);
			if (!r) continue;
			// A promote op is a ruling: only humans (tools/memory.mjs, tools/verdict.mjs)
			// write them — agents cannot, and host records promote by evidence at creation.
			if (entry.op === "promote") out.set(entry.id, { ...r, status: "promoted", promotedBy: entry.by ?? "human" });
			else if (entry.op === "tombstone") out.set(entry.id, { ...r, status: "tombstoned", tombstoneReason: entry.reason ?? "" });
			else if (entry.op === "update") {
				out.set(entry.id, {
					...r,
					...(Array.isArray(entry.evidence) ? { evidence: [...entry.evidence] } : {}),
					...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
					...(typeof entry.text === "string" ? { text: entry.text } : {}),
				});
			}
			continue;
		}
		if (entry.id) out.set(entry.id, { ...entry });
	}
	return out;
}

export function readLog(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

export function appendLog(file, entries) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be"]);
function tokens(s) {
	return new Set(
		String(s)
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/)
			.filter((t) => t.length > 1 && !STOP.has(t)),
	);
}

export { recall } from "./wiki.mjs";

function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * Fold near-duplicate records into the older one: evidence union, confidence raised
 * as by independent confirmation (1 − Π(1 − cᵢ), capped at 0.99), the newer record
 * tombstoned with "merged into <id>". Only records that say the same thing merge —
 * same scope, same kind, token-set similarity ≥ threshold (measured on the real
 * store: duplicates 0.82–0.93, different outcomes 0.41–0.43). Disagreements are never
 * resolved here; that is a judgment for a human or a paired run. Returns log ops;
 * applying them and consolidating again yields nothing.
 */
export function consolidate(records, { threshold = 0.75, ts = Date.now() } = {}) {
	const live = (records instanceof Map ? [...records.values()] : records).filter((r) => r.status !== "tombstoned").sort((a, b) => a.ts - b.ts);
	const ops = [];
	const merged = new Set();
	for (let i = 0; i < live.length; i++) {
		const older = live[i];
		if (merged.has(older.id)) continue;
		const evidence = [...older.evidence];
		let confidence = older.confidence;
		const tombstones = [];
		for (let j = i + 1; j < live.length; j++) {
			const newer = live[j];
			if (merged.has(newer.id) || newer.scope !== older.scope || newer.kind !== older.kind) continue;
			if (jaccard(tokens(older.text), tokens(newer.text)) < threshold) continue;
			merged.add(newer.id);
			for (const e of newer.evidence) if (!evidence.includes(e)) evidence.push(e);
			confidence = Math.min(0.99, Math.round((1 - (1 - confidence) * (1 - newer.confidence)) * 100) / 100);
			tombstones.push({ op: "tombstone", id: newer.id, ts, reason: `merged into ${older.id}` });
		}
		if (tombstones.length) ops.push({ op: "update", id: older.id, ts, evidence, confidence }, ...tombstones);
	}
	return ops;
}

function firstSentence(body, max = 120) {
	const line = String(body).split("\n")[0].trim();
	const m = /^(.*?\.)(\s|$)/.exec(line);
	return (m ? m[1] : line).slice(0, max);
}

/**
 * Derive evidence-backed records from a finished run: one episodic record per run
 * (outcome, shape, oracle scores) and, when the run passed, one procedural record
 * naming the delegation that passed. Only facts the supervisor can vouch for.
 */
export function retainFromRun({ summary, timeline, ts = Date.now() }) {
	const runId = summary.runId;
	const task = summary.task;
	// A run that works on an external repo learns for that repo, not for the task name:
	// the record text still names the task, and recall for the repo sees every task's runs.
	const scope = summary.config?.repo ? `repo:${summary.config.repo}` : `task:${task}`;
	const pattern = summary.config?.pattern ?? "?";
	const roles = Object.entries(summary.config?.roles ?? {})
		.map(([name, r]) => `${name}=${r.provider}/${r.model}`)
		.join(", ");
	const verdicts = timeline
		.filter((m) => m.kind === "oracle" && m.from === "supervisor")
		.map((m) => /Oracle run #(\d+): (\d+\/\d+)/.exec(m.body))
		.filter(Boolean)
		.map((m) => ({ n: Number(m[1]), score: m[2] }));
	// A validator may end its summary with "<Name> digest: …" (dw-recon's KPI digest,
	// dw-explore's findings digest): the one line of the run's measured facts worth
	// remembering across runs. Kept on the episodic record so later recall carries it.
	const digests = timeline
		.filter((m) => m.kind === "oracle" && m.from === "supervisor")
		.map((m) => /(\w+ digest): (.+)$/s.exec(m.body))
		.filter(Boolean)
		.map((m) => `${m[1]}: ${m[2].trim().slice(0, 1500)}`);
	const digest = digests.length ? ` ${digests[digests.length - 1]}` : "";
	const evidence = [`run:${runId}`, ...verdicts.map((v) => `oracle:${runId}#${v.n}`)];
	const probes = summary.mailByKind?.probe ?? 0;
	const attempts = summary.doneAttempts ?? 0;
	const parts = [
		`${task} via ${pattern} (${roles}): ${summary.reason} in ${summary.wallSec}s;`,
		summary.workers ? ` ${summary.workers} workers,` : "",
		` ${probes} probes, ${attempts} done attempt${attempts === 1 ? "" : "s"}.`,
		verdicts.length ? ` Oracle: ${verdicts.map((v) => v.score).join(", ")}.` : "",
		digest,
	];
	const out = [makeRecord({ scope, kind: "episodic", text: parts.join(""), evidence, confidence: 0.9, source: "supervisor", ts })];
	const spawns = timeline.filter((m) => m.kind === "spawn" && m.to !== "worker");
	if (String(summary.reason).startsWith("SUCCESS") && spawns.length) {
		const briefs = spawns.map((m, i) => `worker ${i + 1}: ${firstSentence(m.body)}`).join(" | ");
		out.push(makeRecord({ scope, kind: "procedural", text: `${task}: delegation that passed the oracle — ${briefs}`, evidence, confidence: 0.7, source: "supervisor", ts }));
	}
	return out;
}
