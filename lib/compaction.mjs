// Supervisor-driven compaction, the pure part: when to compact the orchestrator's
// context and what instructions the summariser gets. The supervisor sees every phase
// boundary (a worker's report handed over, a done claim rejected, an oracle failed)
// and every assistant message's usage; at a boundary, once the orchestrator is idle
// with no live worker, it asks for a checkpoint and then issues pi's RPC `compact`.
// The instructions carry two labelled parts — the supervisor's ledger (ids and
// verdicts it can vouch for) and the orchestrator's checkpoint (its judgement) — so a
// summary cannot silently blend evidence with interpretation.

/** Context size as the model saw it: fresh input plus cache reads. */
export function contextTokensOf(usage) {
	if (!usage || typeof usage !== "object") return 0;
	return (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0);
}

export function decideCompaction({ contextTokens, threshold, compactions, maxCompactions, turnsSinceLast, minGapTurns, busy, workersLive }) {
	if (!threshold || threshold <= 0) return { compact: false, reason: "off" };
	if (compactions >= maxCompactions) return { compact: false, reason: "max_reached" };
	if (contextTokens < threshold) return { compact: false, reason: "below_threshold" };
	if (turnsSinceLast < minGapTurns) return { compact: false, reason: "too_soon" };
	if (busy) return { compact: false, reason: "busy" };
	if (workersLive) return { compact: false, reason: "worker_live" };
	return { compact: true, reason: "ok" };
}

/** The supervisor's side of the checkpoint: what it can vouch for, by id. */
export function ledgerLines({ probes = [], memoryIds = [], workers = [], handles = [], oracle = null, time = "", reports = null } = {}) {
	const out = [];
	out.push(probes.length ? `Probes run (host-side, results archived in the run): ${probes.map((p) => `#${p.n} ${p.head}`).join(" | ")}` : "Probes run: none yet.");
	out.push(memoryIds.length ? `Memory records fetched (memory_get again if needed): ${memoryIds.join(", ")}` : "Memory records fetched: none.");
	out.push(workers.length ? `Workers: ${workers.map((w) => `${w.id} (${w.status}${w.description ? `: ${w.description}` : ""})`).join("; ")}` : "Workers: none spawned yet.");
	out.push(handles.length ? `Archived result handles (recall_result pages them back): ${handles.join(", ")}` : "Archived result handles: none.");
	if (Array.isArray(reports)) out.push(reports.length ? `Worker reports (tool \`report\`, schema-checked): ${reports.map((r) => `${r.role} ${r.status} (${r.findings} findings, ${r.verify} verify cases)`).join("; ")}` : "Worker reports: none yet — a completed worker without one blocks done.");
	out.push(oracle ? `Last oracle result: ${oracle}` : "Oracle: not run yet.");
	if (time) out.push(time);
	return out;
}

function findingsByClaim(findings) {
	const groups = { observed: [], interpreted: [], hypothesis: [] };
	for (const f of Array.isArray(findings) ? findings : []) {
		const claim = groups[f?.claim] ? f.claim : "hypothesis";
		const refs = Array.isArray(f?.evidence_refs) && f.evidence_refs.length ? ` [${f.evidence_refs.join(", ")}]` : "";
		groups[claim].push(`- ${String(f?.text ?? "").trim()}${refs}`);
	}
	return groups;
}

export function composeInstructions({ ledger = [], checkpoint = null } = {}) {
	const lines = [
		"This summary continues an orchestrator mid-task. Keep evidence and interpretation labelled apart: what the supervisor's ledger states is verified host-side; what the checkpoint states is the orchestrator's own reading. Keep every id verbatim (probe numbers, memory ids m_…, worker ids, handle ids h_…). Do not invent results, numbers or ids that appear in neither part. Keep the remaining work and the next steps.",
		"",
		"## Run ledger (supervisor)",
		...ledger,
		"",
		"## Orchestrator checkpoint",
	];
	if (!checkpoint) {
		lines.push("(no checkpoint was written before this compaction; carry forward what the conversation shows, labelled as the orchestrator's own reading)");
	} else {
		const g = findingsByClaim(checkpoint.findings);
		lines.push(`Checkpoint #${checkpoint.n ?? "?"}.`);
		lines.push("Findings — observed (the results show it):", ...(g.observed.length ? g.observed : ["- none"]));
		lines.push("Findings — interpreted (the orchestrator's explanation):", ...(g.interpreted.length ? g.interpreted : ["- none"]));
		lines.push("Findings — hypothesis (conjecture):", ...(g.hypothesis.length ? g.hypothesis : ["- none"]));
		const q = Array.isArray(checkpoint.open_questions) ? checkpoint.open_questions : [];
		const s = Array.isArray(checkpoint.next_steps) ? checkpoint.next_steps : [];
		lines.push("Open questions:", ...(q.length ? q.map((x) => `- ${x}`) : ["- none"]));
		lines.push("Next steps:", ...(s.length ? s.map((x) => `- ${x}`) : ["- none"]));
	}
	return lines.join("\n");
}
