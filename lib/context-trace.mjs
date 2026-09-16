// Context trace: turns a run's archived session jsonl (plus lifecycle.jsonl) into
// a per-agent, per-LLM-call trace with cached vs fresh prefill tokens, timing,
// and lifecycle markers (spawn/return/resume, guard, compaction, report, handles,
// checkpoint). Pure function of the run directory; see the schema in
// .superpowers/sdd/2026-09-15-context-trace/contract.md.
import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

const CREATION_JOIN_WINDOW_MS = 120_000;

export function readSessionFile(file) {
	return readJsonl(file);
}

export function walkSessions(sessionsDir) {
	const out = [];
	function walk(dir) {
		if (!fs.existsSync(dir)) return;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	}
	walk(sessionsDir);
	return out.sort((a, b) => a.localeCompare(b));
}

function roleOf(relPath) {
	return /\/tasks\//.test(relPath) ? "worker" : relPath.split("/")[0];
}

function buildCallsFromEntries(entries) {
	const raw = entries.filter((e) => e?.type === "message" && e.message?.role === "assistant" && e.message?.usage);
	const calls = raw.map((entry) => {
		const endMs = Date.parse(entry.timestamp);
		const startMs = typeof entry.message.timestamp === "number" ? entry.message.timestamp : endMs;
		const usage = entry.message.usage;
		const fresh = usage.input ?? 0;
		const cached = usage.cacheRead ?? 0;
		const tools = (entry.message.content ?? []).filter((c) => c?.type === "toolCall").map((c) => c.name);
		return {
			startMs,
			endMs,
			context: fresh + cached,
			cached,
			fresh,
			output: usage.output ?? 0,
			reasoning: usage.reasoning ?? 0,
			totalTokens: usage.totalTokens ?? fresh + cached + (usage.output ?? 0),
			tools,
			stopReason: entry.message.stopReason ?? null,
		};
	});
	calls.sort((a, b) => a.startMs - b.startMs);
	calls.forEach((c, idx) => {
		const i = idx + 1;
		const prev = idx > 0 ? calls[idx - 1] : null;
		const next = idx < calls.length - 1 ? calls[idx + 1] : null;
		c.i = i;
		c.inferenceMs = c.endMs - c.startMs;
		c.toolMs = next ? next.startMs - c.endMs : null;
		c.hitRatio = c.context === 0 ? 0 : c.cached / c.context;
		c.retained = prev === null ? null : prev.totalTokens === 0 ? null : c.cached / prev.totalTokens;
		c.markers = [];
	});
	return calls;
}

function emptyTotals() {
	return { calls: 0, context: 0, cached: 0, fresh: 0, output: 0, reasoning: 0, peakContext: 0, hitRatio: 0, inferenceMs: 0, toolMs: 0 };
}

function totalsFor(calls) {
	const t = emptyTotals();
	t.calls = calls.length;
	for (const c of calls) {
		t.context += c.context;
		t.cached += c.cached;
		t.fresh += c.fresh;
		t.output += c.output;
		t.reasoning += c.reasoning;
		t.peakContext = Math.max(t.peakContext, c.context);
		t.inferenceMs += c.inferenceMs;
		t.toolMs += c.toolMs ?? 0;
	}
	t.hitRatio = t.cached + t.fresh === 0 ? 0 : t.cached / (t.cached + t.fresh);
	return t;
}

// Marker window: for call i, tMs in (prev.endMs, this.endMs]; for i = 1, (-Infinity, this.endMs].
// Returns the call the marker attaches to, or null if tMs is after the last call's endMs.
function findAttachCall(calls, tMs) {
	for (let idx = 0; idx < calls.length; idx++) {
		const prevEnd = idx === 0 ? -Infinity : calls[idx - 1].endMs;
		if (tMs > prevEnd && tMs <= calls[idx].endMs) return calls[idx];
	}
	return null;
}

function guardDetail(ev, data) {
	const label = ev.replace(/^guard:/, "").replace(/_rewritten$|_denied$/, "");
	if (ev === "guard:context_diet_rewritten") return `${label} thinkingDropped=${data.thinkingDropped} resultsAged=${data.resultsAged}`;
	const parts = Object.entries(data)
		.filter(([k]) => k !== "role")
		.map(([k, v]) => `${k}=${v}`);
	return parts.length ? `${label} ${parts.join(" ")}` : label;
}

function kvDetail(data, exclude = ["role", "ts"]) {
	const parts = Object.entries(data ?? {})
		.filter(([k]) => !exclude.includes(k))
		.map(([k, v]) => `${k}=${v}`);
	return parts.join(" ");
}

// Resolve a lifecycle guard/report/handles/checkpoint data.role to an agent id:
// "orchestrator" | "builder" | "critic" -> that agent's id directly;
// "worker:<childSessionId>" -> the agent whose sessionId matches.
function agentIdForRole(agents, role) {
	if (!role) return null;
	if (role.startsWith("worker:")) {
		const sid = role.slice("worker:".length);
		const match = agents.find((a) => a.sessionId === sid);
		return match ? match.id : null;
	}
	const match = agents.find((a) => a.id === role);
	return match ? match.id : null;
}

export function traceRun(runDir, opts = {}) {
	const sessionsDir = path.join(runDir, "sessions");
	if (!fs.existsSync(sessionsDir)) throw new Error(`traceRun: no sessions/ directory under ${runDir}`);

	const files = walkSessions(sessionsDir);

	let t0 = null;
	const parsedFiles = [];
	for (const file of files) {
		const entries = readSessionFile(file);
		const rel = path.relative(sessionsDir, file).replace(/\\/g, "/");
		const role = roleOf(rel);
		const sessionEntry = entries.find((e) => e?.type === "session") ?? null;
		if (sessionEntry) {
			const ts = Date.parse(sessionEntry.timestamp);
			if (!Number.isNaN(ts) && (t0 === null || ts < t0)) t0 = ts;
		}
		const calls = buildCallsFromEntries(entries);
		const compactionEntries = entries.filter((e) => e?.type === "compaction");
		parsedFiles.push({ file, rel, role, sessionEntry, calls, compactionEntries });
	}

	// Same rule as context-report: a session file with no assistant calls is skipped.
	const withCalls = parsedFiles.filter((f) => f.calls.length > 0);

	if (t0 === null) {
		const starts = withCalls.flatMap((f) => f.calls.map((c) => c.startMs));
		t0 = starts.length ? Math.min(...starts) : null;
	}

	// Build primary (non-worker) agents first, ordered by session start, then
	// worker agents ordered by first-call startMs.
	const primaries = withCalls.filter((f) => f.role !== "worker");
	const workers = withCalls.filter((f) => f.role === "worker");
	primaries.sort((a, b) => (a.sessionEntry ? Date.parse(a.sessionEntry.timestamp) : 0) - (b.sessionEntry ? Date.parse(b.sessionEntry.timestamp) : 0));
	workers.sort((a, b) => a.calls[0].startMs - b.calls[0].startMs);

	const idCounts = new Map();
	function assignId(baseId) {
		const n = (idCounts.get(baseId) ?? 0) + 1;
		idCounts.set(baseId, n);
		return n === 1 ? baseId : `${baseId}-${n}`;
	}

	const agents = [];
	for (const f of [...primaries, ...workers]) {
		const sessionId = f.sessionEntry?.id ?? path.basename(f.file, ".jsonl");
		const baseId = f.role === "worker" ? `worker:${sessionId.slice(-8)}` : f.role;
		const id = assignId(baseId);
		agents.push({
			id,
			role: f.role,
			sessionId,
			file: f.rel,
			parent: null, // resolved below, once every agent's sessionId is known
			spawn: null,
			startMs: f.calls[0].startMs,
			endMs: f.calls[f.calls.length - 1].endMs,
			calls: f.calls,
			totals: totalsFor(f.calls),
			_parentSession: f.sessionEntry?.parentSession ?? null,
			_compactionEntries: f.compactionEntries,
		});
	}

	const bySessionId = new Map(agents.map((a) => [a.sessionId, a]));
	for (const a of agents) {
		a.parent = a._parentSession && bySessionId.has(a._parentSession) ? bySessionId.get(a._parentSession).id : null;
		delete a._parentSession;
	}

	const orchestrator = agents.find((a) => a.role === "orchestrator") ?? null;

	const lifecyclePath = path.join(runDir, "lifecycle.jsonl");
	const lifecycle = readJsonl(lifecyclePath);

	const markers = [];

	function addMarker(marker, attachAgent) {
		markers.push(marker);
		if (!attachAgent) return;
		const call = findAttachCall(attachAgent.calls, marker.tMs);
		if (call) call.markers.push(marker);
	}

	// --- spawn/return/resume: join worker agents to subagents:created/resuming events ---
	const creationEvents = lifecycle.filter((e) => e.ev === "subagents:created" || e.ev === "subagents:resuming");
	const claimed = new Set();
	const joinByAgentId = new Map();
	for (const worker of agents.filter((a) => a.role === "worker")) {
		let best = null;
		for (const ev of creationEvents) {
			if (claimed.has(ev)) continue;
			if (ev.ts > worker.startMs) continue;
			if (worker.startMs - ev.ts > CREATION_JOIN_WINDOW_MS) continue;
			if (!best || ev.ts > best.ts) best = ev;
		}
		if (best) {
			claimed.add(best);
			joinByAgentId.set(worker.id, best);
		}
	}

	for (const worker of agents.filter((a) => a.role === "worker")) {
		const created = joinByAgentId.get(worker.id);
		if (!created) {
			worker.spawn = null;
			continue;
		}
		const subId = created.data?.id;
		const started = lifecycle.find((e) => e.ev === "subagents:started" && e.data?.id === subId);
		const completed = lifecycle.find((e) => e.ev === "subagents:completed" && e.data?.id === subId);
		worker.spawn = {
			id: subId ?? null,
			description: created.data?.description ?? null,
			background: created.data?.isBackground ?? null,
			createdMs: created.ts,
			startedMs: started ? started.ts : null,
			completedMs: completed ? completed.ts : null,
		};
	}

	for (const ev of lifecycle) {
		if (ev.ev === "subagents:created" || ev.ev === "subagents:resuming") {
			const kind = ev.ev === "subagents:created" ? "spawn" : "resume";
			const worker = agents.find((a) => a.role === "worker" && joinByAgentId.get(a.id) === ev);
			const agentField = worker ? worker.id : orchestrator ? orchestrator.id : null;
			const parentAgent = worker ? agents.find((a) => a.id === worker.parent) : null;
			const attachAgent = parentAgent ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: agentField, kind, ev: ev.ev, detail: ev.data?.description ?? "" }, attachAgent);
			continue;
		}
		if (ev.ev === "subagents:completed") {
			const subId = ev.data?.id;
			const worker = agents.find((a) => a.role === "worker" && joinByAgentId.get(a.id)?.data?.id === subId);
			const agentField = worker ? worker.id : orchestrator ? orchestrator.id : null;
			const parentAgent = worker ? agents.find((a) => a.id === worker.parent) : null;
			const attachAgent = parentAgent ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: agentField, kind: "return", ev: ev.ev, detail: ev.data?.description ?? "" }, attachAgent);
			continue;
		}
		if (ev.ev?.startsWith("guard:")) {
			const targetId = agentIdForRole(agents, ev.data?.role) ?? (orchestrator ? orchestrator.id : null);
			const targetAgent = agents.find((a) => a.id === targetId) ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: targetId, kind: "guard", ev: ev.ev, detail: guardDetail(ev.ev, ev.data ?? {}) }, targetAgent);
			continue;
		}
		if (ev.ev === "worker:report") {
			const targetId = agentIdForRole(agents, ev.data?.role) ?? (orchestrator ? orchestrator.id : null);
			const targetAgent = agents.find((a) => a.id === targetId) ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: targetId, kind: "report", ev: ev.ev, detail: kvDetail(ev.data) }, targetAgent);
			continue;
		}
		if (ev.ev === "handles:archived" || ev.ev === "handles:recalled") {
			const targetId = agentIdForRole(agents, ev.data?.role) ?? (orchestrator ? orchestrator.id : null);
			const targetAgent = agents.find((a) => a.id === targetId) ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: targetId, kind: "handles", ev: ev.ev, detail: kvDetail(ev.data) }, targetAgent);
			continue;
		}
		if (ev.ev === "checkpoint:written") {
			const targetId = agentIdForRole(agents, ev.data?.role) ?? (orchestrator ? orchestrator.id : null);
			const targetAgent = agents.find((a) => a.id === targetId) ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: targetId, kind: "checkpoint", ev: ev.ev, detail: kvDetail(ev.data) }, targetAgent);
			continue;
		}
		// subagents:started, subagents:resumed, subagents:steered, subagents:compacted,
		// memory:*, and anything else do not map to a marker kind in the schema.
	}

	// --- compaction markers: from each session file's own compaction entries ---
	for (const f of withCalls) {
		const agent = agents.find((a) => a.file === f.rel);
		for (const entry of f.compactionEntries) {
			const tMs = Date.parse(entry.timestamp);
			addMarker({ tMs, agent: agent.id, kind: "compaction", ev: "compaction", detail: `tokensBefore=${entry.tokensBefore}` }, agent);
		}
	}

	markers.sort((a, b) => a.tMs - b.tMs);
	for (const a of agents) a.calls.forEach((c) => c.markers.sort((m1, m2) => m1.tMs - m2.tMs));

	const allCalls = agents.flatMap((a) => a.calls);
	const totals = totalsFor(allCalls);

	return {
		run: path.basename(runDir),
		t0,
		agents: agents.map(({ _compactionEntries, ...a }) => a),
		markers,
		totals,
	};
}
