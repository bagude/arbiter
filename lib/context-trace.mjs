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

// Optional llama-server timings persisted on message.usage.serverTimings (absent on
// older sessions and non-llama.cpp providers). Missing numbers become null;
// draftAcceptance is draftAccepted/draftN, null when either is missing or draftN is 0.
function buildTimings(serverTimings) {
	if (!serverTimings) return null;
	const num = (v) => (typeof v === "number" ? v : null);
	const promptN = num(serverTimings.promptN);
	const promptMs = num(serverTimings.promptMs);
	const cacheN = num(serverTimings.cacheN);
	const predictedN = num(serverTimings.predictedN);
	const predictedMs = num(serverTimings.predictedMs);
	const draftN = num(serverTimings.draftN);
	const draftAccepted = num(serverTimings.draftAccepted);
	const draftAcceptance = draftN === null || draftAccepted === null || draftN === 0 ? null : draftAccepted / draftN;
	return { promptN, promptMs, cacheN, predictedN, predictedMs, draftN, draftAccepted, draftAcceptance };
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
			timings: buildTimings(usage.serverTimings),
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
	return { calls: 0, context: 0, cached: 0, fresh: 0, output: 0, reasoning: 0, peakContext: 0, hitRatio: 0, inferenceMs: 0, toolMs: 0, promptMs: 0, predictedMs: 0 };
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
		if (c.timings?.promptMs != null) t.promptMs += c.timings.promptMs;
		if (c.timings?.predictedMs != null) t.predictedMs += c.timings.predictedMs;
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
	const label = ev.replace(/^guard:/, "").replace(/_rewritten$|_denied$|_waived$|_skipped$/, "");
	const parts = Object.entries(data)
		.filter(([k]) => k !== "role")
		.map(([k, v]) => `${k}=${v}`);
	return parts.length ? `${label} ${parts.join(" ")}` : label;
}

function kvDetail(data, exclude = ["role", "ts"]) {
	const parts = Object.entries(data ?? {})
		.filter(([k, v]) => !exclude.includes(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
		.map(([k, v]) => `${k}=${v}`);
	return parts.join(" ");
}

// Resolve a lifecycle guard/report/handles/checkpoint data.role to an agent id:
// "orchestrator" | "builder" | "critic" -> that agent's id directly;
// "worker:<transcript basename>" -> the agent whose session FILE basename (without
// .jsonl) matches, mirroring lib/workers.mjs's workerIdForTranscriptName. The
// transcript basename is not the bare session id (e.g. it's
// "2026-09-15T04-22-16-260Z_01a0a34d-…", prefixed with the archive timestamp), so
// this is a suffix match on the agent's file path; fall back to a bare session-id
// match for callers that do pass the session id directly.
function agentIdForRole(agents, role) {
	if (!role) return null;
	if (role.startsWith("worker:")) {
		const base = role.slice("worker:".length);
		let match = agents.find((a) => a.file.replace(/\\/g, "/").endsWith(`/${base}.jsonl`));
		if (!match) match = agents.find((a) => a.sessionId === base || base.endsWith(a.sessionId));
		return match ? match.id : null;
	}
	const match = agents.find((a) => a.id === role);
	return match ? match.id : null;
}

// guard/report/handles/checkpoint markers all resolve their target agent by
// data.role (falling back to the orchestrator) and only differ in kind + detail
// formatting; table-driven so there is one attachment code path, not four.
const ROLE_MARKER_RULES = [
	{ match: (ev) => ev.startsWith("guard:"), kind: "guard", detail: (ev, data) => guardDetail(ev, data) },
	{ match: (ev) => ev === "worker:report", kind: "report", detail: (_ev, data) => kvDetail(data) },
	{ match: (ev) => ev === "handles:archived" || ev === "handles:recalled", kind: "handles", detail: (_ev, data) => kvDetail(data) },
	{ match: (ev) => ev === "checkpoint:written", kind: "checkpoint", detail: (_ev, data) => kvDetail(data) },
];

// All markers for one agent: its calls' attached markers, unioned with the run-level
// `trace.markers` entries naming that agent (spawn/return/resume markers on a worker
// live only in trace.markers — they attach to the PARENT's call, not the worker's own —
// so a caller that reads call.markers alone misses them), deduped on tMs+kind+ev and
// sorted by tMs. Mirrors tools/console.template.html's laneMarkers/orphanMarkers, which
// cannot import this module (the console is a single inlined HTML file) and so keeps
// its own copy — keep the two in sync by hand if this logic changes.
export function markersFor(trace, agentId) {
	const key = (m) => `${m.tMs}|${m.kind}|${m.ev}`;
	const agent = trace.agents.find((a) => a.id === agentId);
	const callMarkers = agent ? agent.calls.flatMap((c) => c.markers ?? []) : [];
	const runMarkers = (trace.markers ?? []).filter((m) => m.agent === agentId);
	const seen = new Set();
	const out = [];
	for (const m of [...callMarkers, ...runMarkers]) {
		const k = key(m);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(m);
	}
	out.sort((a, b) => a.tMs - b.tMs);
	return out;
}

export function traceRun(runDir) {
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

	// --- spawn/return/resume: join worker agents to subagents:created/started/resuming events ---
	// FIFO, mirroring lib/workers.mjs's bindTranscript: workers are processed in
	// startMs order (agents.filter already preserves that order — see the `workers.sort`
	// above), and each claims the EARLIEST still-unclaimed candidate in its window, not
	// the latest. Picking the latest inverts descriptions when two workers are spawned
	// close together: worker A (earlier startMs) would grab the later `created` event
	// meant for worker B, and vice versa.
	// A `created` and `started` event sharing the same lifecycle id are one spawn:
	// background spawns emit both (created then started, ~1ms apart); foreground
	// spawns emit only `started` (no `created` at all). Collapse each id's pair into
	// a single FIFO join candidate so a worker claims one spawn, not two, and so a
	// lone `started` (foreground) is still a valid join target. `resuming` events
	// stay separate candidates, unchanged from before.
	const spawnById = new Map(); // subId -> { created, started }
	const spawnOrder = [];
	for (const ev of lifecycle) {
		if (ev.ev !== "subagents:created" && ev.ev !== "subagents:started") continue;
		const id = ev.data?.id;
		if (!spawnById.has(id)) {
			spawnById.set(id, { created: null, started: null });
			spawnOrder.push(id);
		}
		const rec = spawnById.get(id);
		if (ev.ev === "subagents:created") rec.created = rec.created ?? ev;
		else rec.started = rec.started ?? ev;
	}
	const spawnCandidates = spawnOrder.map((id) => {
		const { created, started } = spawnById.get(id);
		const primary = created ?? started;
		return {
			ts: primary.ts,
			ev: created ? "subagents:created" : "subagents:started",
			data: { id, description: primary.data?.description ?? null, isBackground: created ? (created.data?.isBackground ?? null) : null },
			_createdEv: created,
			_startedEv: started,
		};
	});
	const resumeCandidates = lifecycle.filter((e) => e.ev === "subagents:resuming");
	const creationEvents = [...spawnCandidates, ...resumeCandidates]; // the parent-resolution pass below walks both
	const claimed = new Set();
	const joinByAgentId = new Map();
	const earliestUnclaimed = (events, worker) => {
		let best = null;
		for (const ev of events) {
			if (claimed.has(ev)) continue;
			if (ev.ts > worker.startMs) continue;
			if (worker.startMs - ev.ts > CREATION_JOIN_WINDOW_MS) continue;
			if (!best || ev.ts < best.ts) best = ev;
		}
		return best;
	};
	// A new session file is a spawn, so spawn candidates are tried first; a
	// `resuming` event is only a fallback for a worker no spawn explains. Mixing the
	// two in one FIFO let a fresh tester claim an earlier worker's resume (seen on
	// 2026-09-17T02-24-17: the tester lane wore the implementer's description and
	// type) because the resume was the earliest unclaimed event in its window.
	for (const worker of agents.filter((a) => a.role === "worker")) {
		const best = earliestUnclaimed(spawnCandidates, worker) ?? earliestUnclaimed(resumeCandidates, worker);
		if (best) {
			claimed.add(best);
			joinByAgentId.set(worker.id, best);
		}
	}

	for (const worker of agents.filter((a) => a.role === "worker")) {
		const claimedEv = joinByAgentId.get(worker.id);
		if (!claimedEv) {
			worker.spawn = null;
			continue;
		}
		const subId = claimedEv.data?.id;
		const started = claimedEv._startedEv ?? lifecycle.find((e) => e.ev === "subagents:started" && e.data?.id === subId);
		const completed = lifecycle.find((e) => e.ev === "subagents:completed" && e.data?.id === subId);
		// type comes from the created event, else the started event (spawnCandidates
		// don't copy `type` onto their own synthetic `data`); a resuming candidate
		// (no _createdEv/_startedEv wrapper) carries it directly on its own data.
		const type = claimedEv._createdEv?.data?.type ?? claimedEv._startedEv?.data?.type ?? claimedEv.data?.type ?? null;
		worker.spawn = {
			id: subId ?? null,
			description: claimedEv.data?.description ?? null,
			background: claimedEv.data?.isBackground ?? null,
			type,
			createdMs: claimedEv._createdEv ? claimedEv._createdEv.ts : claimedEv.ts,
			startedMs: started ? started.ts : null,
			completedMs: completed ? completed.ts : null,
		};
	}

	// spawn/resume markers: one per join candidate (from `created` when present, else
	// `started`, per the merge above), not one per raw lifecycle event.
	for (const cand of creationEvents) {
		const kind = cand.ev === "subagents:resuming" ? "resume" : "spawn";
		const worker = agents.find((a) => a.role === "worker" && joinByAgentId.get(a.id) === cand);
		const agentField = worker ? worker.id : orchestrator ? orchestrator.id : null;
		const parentAgent = worker ? agents.find((a) => a.id === worker.parent) : null;
		const attachAgent = parentAgent ?? orchestrator;
		addMarker({ tMs: cand.ts, agent: agentField, kind, ev: cand.ev, detail: cand.data?.description ?? "" }, attachAgent);
	}

	for (const ev of lifecycle) {
		if (ev.ev === "subagents:created" || ev.ev === "subagents:started" || ev.ev === "subagents:resuming") continue; // handled via creationEvents above
		if (ev.ev === "subagents:completed") {
			const subId = ev.data?.id;
			const worker = agents.find((a) => a.role === "worker" && joinByAgentId.get(a.id)?.data?.id === subId);
			const agentField = worker ? worker.id : orchestrator ? orchestrator.id : null;
			const parentAgent = worker ? agents.find((a) => a.id === worker.parent) : null;
			const attachAgent = parentAgent ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: agentField, kind: "return", ev: ev.ev, detail: ev.data?.description ?? "" }, attachAgent);
			continue;
		}
		const rule = ROLE_MARKER_RULES.find((r) => r.match(ev.ev ?? ""));
		if (rule) {
			const targetId = agentIdForRole(agents, ev.data?.role) ?? (orchestrator ? orchestrator.id : null);
			const targetAgent = agents.find((a) => a.id === targetId) ?? orchestrator;
			addMarker({ tMs: ev.ts, agent: targetId, kind: rule.kind, ev: ev.ev, detail: rule.detail(ev.ev, ev.data ?? {}) }, targetAgent);
			continue;
		}
		// subagents:resumed, subagents:steered, subagents:compacted, memory:*, and
		// anything else do not map to a marker kind in the schema (subagents:started
		// is consumed above, whether or not it paired with a subagents:created).
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

// Unweighted mean of call.retained (cacheRead / previous call's totalTokens) over every
// call of every agent in a traceRun() result. retained is null for a call with no
// preceding call in its own session or whose predecessor reported 0 total tokens — those
// are excluded, not treated as 0. Returns null when no call has a non-null retained.
export function meanRetained(trace) {
	const values = (trace?.agents ?? []).flatMap((a) => a.calls ?? []).map((c) => c.retained).filter((v) => v !== null && v !== undefined);
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}
