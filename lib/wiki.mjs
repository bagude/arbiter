// The memory wiki: Markdown pages COMPILED from the evidence log and the run
// summaries (docs/superpowers/specs/2026-09-12-memory-wiki-design.md). Pure: no
// fs here — lib/memory.mjs reads and writes. The links are the graph; recall is
// reading pages in scope order; lint reports what a person should rule on.
//
// Pages: INDEX.md, SCHEMA.md, scopes/<scope>.md, runs/<id>.md, guards/<name>.md.
// Agents never write pages; they propose candidate records (kind="memory" mail).

const KIND_ORDER = ["semantic", "procedural"];

export function scopeFile(scope) {
	return `scopes/${scope.replace(":", "-")}`;
}

function link(p) {
	return `[[${p}]]`;
}

function evidenceLinks(evidence) {
	return (evidence ?? []).map((e) => (String(e).startsWith("run:") ? link(`runs/${String(e).slice(4)}`) : String(e))).join(" ");
}

const DIGEST_RE = /\s*(\w+ digest): (.+)$/s;

function recordLine(r, { kind = true, source = false, stripDigest = false } = {}) {
	const tags = [kind ? r.kind : null, source ? r.source : null].filter(Boolean);
	const head = tags.length ? `[${tags.join(", ")}] ` : "";
	const ev = r.evidence?.length ? `, evidence: ${evidenceLinks(r.evidence)}` : "";
	const text = stripDigest ? r.text.replace(DIGEST_RE, "") : r.text;
	return `- ${head}${text} (${r.id}, conf ${r.confidence}${ev})`;
}

// A run's digest (recon's KPI line, explore's titles + open questions) gets its own
// section so recall carries every run's digest once, newest first, and the History
// lines stay short.
function digestLine(r) {
	const m = DIGEST_RE.exec(r.text);
	if (!m) return null;
	const runId = (r.evidence ?? []).map(String).find((e) => e.startsWith("run:"))?.slice(4);
	return `- ${runId ? `${link(`runs/${runId}`)} ` : ""}${m[1]}: ${m[2].trim()} (${r.id})`;
}

function taskOf(r) {
	return /^(\S+) via /.exec(r.text)?.[1] ?? "?";
}

// Digests, newest first — but the newest digest of EVERY task comes before any
// older one, so a chatty task (the explorer) cannot starve another task's latest
// digest (the reconciler's KPI line) out of a recall budget.
function orderDigests(history) {
	const withDigest = history.filter((r) => DIGEST_RE.test(r.text));
	const seenTask = new Set();
	const first = [];
	const rest = [];
	for (const r of withDigest) {
		const t = taskOf(r);
		if (seenTask.has(t)) rest.push(r);
		else {
			seenTask.add(t);
			first.push(r);
		}
	}
	return [...first, ...rest];
}

// Every observation title any exploration in this scope has produced, newest first,
// deduplicated — one short line each, so recall carries coverage even when the full
// digests no longer fit.
function explorationLines(history) {
	const out = [];
	const seen = new Set();
	for (const r of history) {
		const m = /Findings digest: (.+)$/s.exec(r.text);
		if (!m) continue;
		const runId = (r.evidence ?? []).map(String).find((e) => e.startsWith("run:"))?.slice(4);
		for (const part of m[1].split("||")[0].split(" | ")) {
			const title = part.replace(/^O\d+\s+/, "").trim();
			const key = title.toLowerCase();
			if (!title || seen.has(key)) continue;
			seen.add(key);
			out.push(`- ${title}${runId ? ` (${link(`runs/${runId}`)})` : ""}`);
		}
	}
	return out;
}

function oracleScore(records, runId) {
	for (const r of records) {
		if (r.kind !== "episodic" || !r.evidence?.includes(`run:${runId}`)) continue;
		const m = /Oracle: ([^.]+)\./.exec(r.text);
		if (m) return m[1];
	}
	return null;
}

function runsOf(records) {
	const ids = new Set();
	for (const r of records) for (const e of r.evidence ?? []) if (String(e).startsWith("run:")) ids.add(String(e).slice(4));
	return ids;
}

function lastRun(scopeRecords, runSummaries) {
	const eps = scopeRecords.filter((r) => r.kind === "episodic" && r.status === "promoted").sort((a, b) => b.ts - a.ts);
	for (const r of eps) {
		const id = (r.evidence ?? []).map(String).find((e) => e.startsWith("run:"))?.slice(4);
		if (!id) continue;
		const s = runSummaries.get(id);
		const outcome = s?.reason ?? (/SUCCESS/.test(r.text) ? "SUCCESS" : "?");
		return `${id} ${String(outcome).split(":")[0]}`;
	}
	return null;
}

const SCHEMA = `# SCHEMA — how this wiki is organised

This wiki is compiled from \`memory/records.jsonl\` (the evidence log) and \`runs/<id>/summary.json\`.
Nobody edits these pages; edit the log through \`tools/memory.mjs\` (promote, tombstone, retain, consolidate) and re-render.

- \`scopes/<scope>.md\` — one page per memory scope: \`global\`, \`task-<name>\` (one task's runs), \`repo-<name>\` (every task on one external repository — the memory of the agent for that repo). Sections: **Facts** (promoted semantic and procedural records), **History** (promoted episodic records, newest first, with the run's digest), **Candidates** (unpromoted records: an agent's proposals or unverified retention).
- \`runs/<id>.md\` — one page per run referenced by any record: outcome, shape, oracle score, guard counts, what memory it was given.
- \`guards/<name>.md\` — one page per guard seen in run summaries: where it fired, how often.
- \`LINT.md\` — the last lint report: what a person should rule on.

Trust: a record is **promoted** only with oracle evidence (\`oracle:<run>#n\`) or by a human; agents' records stay **candidates** until a verdict (\`tools/verdict.mjs\`) or a confirming run. Tombstoned records never appear here. Recall gives an agent the scope pages it is running under (repo, task, global), Facts first, within a character budget.
`;

/**
 * Compile every page. `records`: Map<id, record> (folded) or array. `runSummaries`:
 * Map<runId, summary.json contents>. Returns Map<relative path, markdown>.
 */
export function buildPages({ records, runSummaries = new Map(), now = Date.now() }) {
	const all = (records instanceof Map ? [...records.values()] : records).filter((r) => r.status !== "tombstoned");
	const pages = new Map();
	const scopes = [...new Set(all.map((r) => r.scope))].sort();
	const byScope = new Map(scopes.map((s) => [s, all.filter((r) => r.scope === s)]));

	// scope pages
	for (const scope of scopes) {
		const rs = byScope.get(scope);
		const facts = rs.filter((r) => r.status === "promoted" && r.kind !== "episodic").sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.ts - a.ts);
		const history = rs.filter((r) => r.status === "promoted" && r.kind === "episodic").sort((a, b) => b.ts - a.ts);
		const digests = orderDigests(history).map(digestLine).filter(Boolean);
		const explorations = explorationLines(history);
		const candidates = rs.filter((r) => r.status === "candidate").sort((a, b) => b.ts - a.ts);
		const runs = [...runsOf(rs)].sort();
		const md = [
			`# ${scope}`,
			"",
			`${facts.length} fact(s), ${history.length} run(s) in history, ${candidates.length} candidate(s).${runs.length ? ` Runs: ${runs.map((id) => link(`runs/${id}`)).join(", ")}.` : ""}`,
			"",
			"## Facts",
			"",
			...(facts.length ? facts.map((r) => recordLine(r)) : ["(none promoted yet)"]),
			"",
			...(digests.length ? ["## Digests", "", ...digests, ""] : []),
			...(explorations.length ? ["## Explorations", "", `${explorations.length} distinct observation title(s) across every exploration of this scope, newest first.`, "", ...explorations, ""] : []),
			"## History",
			"",
			...(history.length ? history.map((r) => recordLine(r, { kind: false, stripDigest: true })) : ["(no runs retained)"]),
			"",
			"## Candidates",
			"",
			...(candidates.length ? candidates.map((r) => recordLine(r, { source: true })) : ["(none)"]),
			"",
		].join("\n");
		pages.set(`${scopeFile(scope)}.md`, md);
	}

	// run pages
	const runIds = new Set([...runsOf(all), ...runSummaries.keys()]);
	const guardTotals = new Map(); // guard -> [{runId, kind, count}]
	for (const id of [...runIds].sort()) {
		const s = runSummaries.get(id);
		const refs = all.filter((r) => r.evidence?.includes(`run:${id}`));
		const scopesHere = [...new Set(refs.map((r) => r.scope))];
		const score = oracleScore(all, id);
		const lines = [`# run ${id}`, ""];
		if (!s) {
			lines.push("(no summary on disk — the run directory is gone or was never archived; what is known comes from the records below)", "");
		} else {
			const roles = Object.entries(s.config?.roles ?? {}).map(([n, r]) => `${n}=${r.provider}/${r.model}`).join(", ");
			const taskScope = s.config?.repo ? `repo:${s.config.repo}` : `task:${s.task}`;
			lines.push(
				`- task: ${link(scopeFile(taskScope))} (${s.task}), pattern ${s.config?.pattern ?? "?"}${roles ? `, ${roles}` : ""}`,
				`- outcome: ${s.reason} in ${s.wallSec}s; ${s.workers ?? 0} workers, ${s.doneAttempts ?? 0} done attempt(s), ${s.toolCalls ?? "?"} tool calls, $${Number(s.costUsd ?? 0).toFixed(3)}`,
				...(score ? [`- Oracle: ${score}`] : []),
				...(s.memory?.injected?.length ? [`- memory injected: ${s.memory.injected.join(", ")}`] : ["- memory injected: none"]),
			);
			for (const [guard, kinds] of Object.entries(s.guards ?? {})) {
				for (const [kind, byRole] of Object.entries(kinds ?? {})) {
					const total = Object.values(byRole ?? {}).reduce((a, b) => a + Number(b || 0), 0);
					if (!total) continue;
					lines.push(`- ${link(`guards/${guard}`)}: ${kind} ${total} (${Object.entries(byRole).map(([role, n]) => `${role.split(":")[0]} ${n}`).join(", ")})`);
					if (!guardTotals.has(guard)) guardTotals.set(guard, []);
					guardTotals.get(guard).push({ runId: id, kind, count: total });
				}
			}
		}
		lines.push("", "## Records", "", ...(refs.length ? refs.sort((a, b) => a.ts - b.ts).map((r) => `- ${r.status} ${recordLine(r, { source: true }).slice(2)} — ${link(scopeFile(r.scope))}`) : ["(none)"]), "");
		if (scopesHere.length && !s) lines.splice(2, 0, `- scopes: ${scopesHere.map((x) => link(scopeFile(x))).join(", ")}`, "");
		pages.set(`runs/${id}.md`, lines.join("\n"));
	}

	// guard pages
	for (const [guard, hits] of [...guardTotals.entries()].sort()) {
		const byKind = {};
		for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + h.count;
		const md = [
			`# guard ${guard}`,
			"",
			`Totals across ${new Set(hits.map((h) => h.runId)).size} run(s): ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ")}.`,
			"",
			"## By run",
			"",
			...hits.sort((a, b) => a.runId.localeCompare(b.runId)).map((h) => `- ${link(`runs/${h.runId}`)} — ${h.kind} ${h.count}`),
			"",
		].join("\n");
		pages.set(`guards/${guard}.md`, md);
	}

	// index
	const indexLine = (scope) => {
		const rs = byScope.get(scope);
		const facts = rs.filter((r) => r.status === "promoted" && r.kind !== "episodic").length;
		const cands = rs.filter((r) => r.status === "candidate").length;
		const last = lastRun(rs, runSummaries);
		return `- ${link(scopeFile(scope))} — ${facts} fact${facts === 1 ? "" : "s"}, ${cands} candidate${cands === 1 ? "" : "s"}${last ? `, last run: ${last}` : ""}`;
	};
	const section = (title, items) => [`## ${title}`, "", ...(items.length ? items : ["(none)"]), ""];
	const index = [
		"# Arbiter memory wiki",
		"",
		`Compiled ${new Date(now).toISOString()} from ${all.length} live record(s) across ${scopes.length} scope(s), ${runIds.size} run(s). Start at ${link("SCHEMA")}; open a scope page for its Facts, History and Candidates; ${link("LINT")} lists what needs a ruling.`,
		"",
		...section("Repos", scopes.filter((s) => s.startsWith("repo:")).map(indexLine)),
		...section("Tasks", scopes.filter((s) => s.startsWith("task:")).map(indexLine)),
		...section("Global", scopes.filter((s) => s === "global").map(indexLine)),
		...section("Guards", [...guardTotals.keys()].sort().map((g) => `- ${link(`guards/${g}`)}`)),
		...section("Runs", [...runIds].sort().reverse().map((id) => `- ${link(`runs/${id}`)}${runSummaries.get(id) ? ` — ${String(runSummaries.get(id).reason).split(":")[0]}, ${runSummaries.get(id).task}` : " — (no summary on disk)"}`)),
	].join("\n");
	pages.set("INDEX.md", index);
	pages.set("SCHEMA.md", SCHEMA);
	return pages;
}

const ID_RE = /\((m_[0-9a-f]+)[,)]/;

function sectionLines(md, title) {
	const m = new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?=\\n## |\\n*$)`).exec(md);
	if (!m) return [];
	return m[1].split("\n").filter((l) => l.startsWith("- "));
}

/**
 * What an agent is given: the scope pages it runs under, in the order repo, task,
 * global; Facts, then Digests (newest per task first), then Explorations (every
 * observation title, deduplicated), then History; whole lines only, until the
 * budget is spent. Returns the record ids included so summary.json can say
 * exactly what was told (a digest line counts as its record).
 */
export function recall({ pages, scopes, budgetChars = 2000 }) {
	const order = [...scopes.filter((s) => s.startsWith("repo:")), ...scopes.filter((s) => s.startsWith("task:")), ...scopes.filter((s) => s === "global")];
	const lines = [];
	const ids = [];
	let used = 0;
	for (const scope of order) {
		const md = pages.get(`${scopeFile(scope)}.md`);
		if (!md) continue;
		const body = [...sectionLines(md, "Facts"), ...sectionLines(md, "Digests"), ...sectionLines(md, "Explorations"), ...sectionLines(md, "History")];
		if (!body.length) continue;
		let opened = false;
		for (const line of body) {
			const header = opened ? 0 : `## ${scope}\n`.length;
			if (used + header + line.length + 1 > budgetChars) continue;
			if (!opened) {
				lines.push(`## ${scope}`);
				opened = true;
				used += header;
			}
			lines.push(line);
			used += line.length + 1;
			const id = ID_RE.exec(line)?.[1];
			if (id && !ids.includes(id)) ids.push(id);
		}
	}
	if (!lines.length) return { text: "", ids: [] };
	return { text: `# MEMORY (wiki excerpt; scopes: ${order.join(", ")})\n${lines.join("\n")}`, ids };
}

const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be"]);
function tokens(s) {
	return new Set(String(s).toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length > 1 && !STOP.has(t)));
}
function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** What a person should rule on. Reports only; never edits the log. */
export function lint({ records, runSummaries = new Map(), now = Date.now(), staleDays = 14, threshold = 0.75 }) {
	const all = (records instanceof Map ? [...records.values()] : records).filter((r) => r.status !== "tombstoned");
	const out = [];
	for (const r of all) {
		const backed = r.source === "human" || (r.evidence ?? []).some((e) => String(e).startsWith("oracle:"));
		if (r.status === "promoted" && !backed) out.push({ level: "warn", rule: "unbacked-promotion", id: r.id, scope: r.scope, detail: `promoted ${r.source} record without oracle evidence: ${r.text.slice(0, 100)}` });
		for (const e of r.evidence ?? []) {
			const id = String(e).startsWith("run:") ? String(e).slice(4) : null;
			if (id && !runSummaries.has(id)) out.push({ level: "info", rule: "missing-run", id: r.id, scope: r.scope, detail: `evidence run:${id} has no summary on disk` });
		}
		if (r.status === "candidate" && now - r.ts > staleDays * 86_400_000) out.push({ level: "warn", rule: "stale-candidate", id: r.id, scope: r.scope, detail: `candidate for ${Math.floor((now - r.ts) / 86_400_000)} days without a verdict (${r.source}): ${r.text.slice(0, 100)}` });
	}
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const a = all[i];
			const b = all[j];
			// Episodic records are templated per run ("X via orchestrator: SUCCESS in Ns…")
			// and look alike across tasks by construction; only claims can duplicate.
			if (a.scope === b.scope || a.kind === "episodic" || b.kind === "episodic") continue;
			if (jaccard(tokens(a.text), tokens(b.text)) >= threshold) out.push({ level: "info", rule: "cross-scope-duplicate", id: a.id, scope: a.scope, detail: `${a.id} (${a.scope}) and ${b.id} (${b.scope}) say the same thing — mis-scoped, or a contradiction to check` });
		}
	}
	for (const scope of new Set(all.map((r) => r.scope))) {
		if (!all.some((r) => r.scope === scope && r.kind === "episodic")) out.push({ level: "info", rule: "scope-without-runs", scope, detail: "no episodic record: nothing here has been tried in a run" });
	}
	return out;
}

export function renderLint(findings, now = Date.now()) {
	const lines = [`# LINT — ${new Date(now).toISOString()}`, "", `${findings.length} finding(s): ${findings.filter((f) => f.level === "warn").length} to rule on, ${findings.filter((f) => f.level === "info").length} informational.`, ""];
	for (const level of ["warn", "info"]) {
		const fs = findings.filter((f) => f.level === level);
		if (!fs.length) continue;
		lines.push(`## ${level === "warn" ? "Rule on these" : "For information"}`, "");
		for (const f of fs) lines.push(`- **${f.rule}** ${f.id ? `${f.id} ` : ""}${f.scope ? `(${link(scopeFile(f.scope))}) ` : ""}— ${f.detail}`);
		lines.push("");
	}
	if (!findings.length) lines.push("Nothing to rule on.", "");
	return lines.join("\n");
}
