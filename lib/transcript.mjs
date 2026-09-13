// The run's two written records, built from plain data so fixtures can pin them:
// summary.json (what tools/kpi.mjs and the console read) and transcript.md (the
// delegation tree plus the interleaved timeline). The supervisor's finish() supplies
// the inputs and writes the files; nothing here touches the filesystem.

/** summary.json — the same fields, in the same order, finish() has always written. */
export function buildSummary({ runId, reason, pattern, roles, config, totals, state, timeline, mailCount, doneAttempts, nudges, probeCountAtFirstOracle, guards, caps, task, verifier, compactions = [], handles = null, checkpoints = [] }) {
	const byKind = {};
	for (const m of timeline) if (m.from !== "supervisor") byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
	// Console/KPI tools read builderModel/criticModel for every run, old and new —
	// "builder" falls back to "worker" and "critic" falls back to "orchestrator" so
	// those tools keep working across patterns.
	const builderRole = roles.builder ?? roles.worker;
	const criticRole = roles.critic ?? roles.orchestrator;
	const agents = Object.values(state);
	return {
		runId,
		reason,
		model: Object.values(roles).map((r) => r.model).join(" + "),
		builderModel: builderRole ? `${builderRole.provider}/${builderRole.model}` : "none",
		criticModel: criticRole ? `${criticRole.provider}/${criticRole.model}` : "none (solo ablation)",
		config,
		wallSec: Number(totals.wallSec.toFixed(1)),
		costUsd: Number(totals.cost.toFixed(4)),
		toolCalls: Object.fromEntries(agents.map((a) => [a.name, a.toolCalls])),
		costByAgent: Object.fromEntries(agents.map((a) => [a.name, Number(a.cost.toFixed(4))])),
		mail: mailCount,
		mailByKind: byKind,
		doneAttempts,
		nudges,
		// How many pi-subagents children the run produced, and — the question the
		// pattern exists to answer — whether the orchestrator had verified the workspace
		// host-side at least once before the first oracle, or just relayed a claim.
		workers: agents.filter((s) => s.role === "worker").length,
		// null, not false, when no oracle ever ran: a run that hit the wall cap before any
		// done never reached the question, and tabulating that as "did not probe" is a
		// wrong answer rather than a missing one, for the only hand-scored boolean here.
		// A quiescence-triggered oracle counts as the first oracle, deliberately — it is
		// still the moment the workspace was first graded.
		...(pattern === "orchestrator" ? { orchestratorProbedBeforeDone: probeCountAtFirstOracle === null ? null : probeCountAtFirstOracle > 0 } : {}),
		guards,
		caps,
		task,
		// Working context (slice 2): supervisor-driven compactions, archived result
		// handles, and the orchestrator's checkpoints.
		compactions,
		handles,
		checkpoints,
		contextPeak: Object.fromEntries(Object.values(state).map((a) => [a.name, a.contextTokens ?? null])),
		oracleGate: verifier ? `${verifier} approval (hash+quiescence)` : "solo: builder done or quiescence",
		sandbox: "none (Gondolin requires QEMU; not installed). Controls: hardened flags, tool asymmetry, host-side oracle, budgets.",
	};
}

/** transcript.md — the delegation tree (orchestrator pattern) and the interleaved timeline. */
export function renderTranscript({ runId, reason, startedAt, timeline, pattern }) {
	const t = (ts) => ((ts - startedAt) / 1000).toFixed(0);
	const oneLine = (s, n) => s.replace(/\s+/g, " ").slice(0, n);
	const md = [`# arbiter transcript — ${runId}`, "", `**Outcome:** ${reason}`, ""];
	// Delegation tree: one entry per worker the orchestrator spawned, each followed by
	// its resumes and its final report, in the order the worker experienced them — the
	// interleaved timeline below already has this, but not as a single readable branch.
	if (pattern === "orchestrator") {
		md.push("## Delegation", "");
		const byWorker = new Map();
		for (const m of timeline) {
			// A spawn still carrying the "worker" placeholder is a `subagent` call that
			// never produced a worker; the supervisor drops those as they are seen, and
			// this is the belt to that pair of braces — an unclaimed entry must never render
			// as a worker literally called "worker".
			if (m.kind === "spawn" && m.to === "worker") continue;
			if (m.kind === "spawn") byWorker.set(m.to, [`- **${m.to}** spawned at ${t(m.ts)}s — brief: ${oneLine(m.body, 200)}`]);
			if ((m.kind === "resume" || m.kind === "report") && byWorker.has(m.kind === "resume" ? m.to : m.from)) {
				byWorker.get(m.kind === "resume" ? m.to : m.from).push(`  - ${m.kind} at ${t(m.ts)}s: ${oneLine(m.body, 160)}`);
			}
		}
		for (const lines of byWorker.values()) md.push(...lines);
		md.push("");
	}
	for (const m of timeline) {
		md.push(`### [${t(m.ts)}s] ${m.n ? `#${m.n} ` : ""}${m.from} → ${m.to} (${m.kind})`, "", m.body, "");
	}
	return md.join("\n");
}
