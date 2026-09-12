// Worker lifecycle reducer and transcript binding for the orchestrator pattern.
//
// A worker is a pi-subagents child of the orchestrator's pi process. The supervisor
// never launches it and cannot talk to it; it observes it through two host-side
// files: the lifecycle file (written by ext/subagents-bridge.ts, and by the guards)
// says when a worker starts, reports and ends; the child's own session transcript
// says what it actually did. This module is the pure half of that: it takes one
// lifecycle line at a time, mutates the plain `state` (agents by id) and `timeline`
// (the transcript's message list) exactly as the supervisor used to inline, and
// RETURNS the audit lines and the decision marker instead of logging — so the whole
// thing replays against a recorded lifecycle file in a unit test (test/workers.test.mjs
// replays the two real runs that found the bugs this code carries the fixes for).
import { createAgentState } from "./agents.mjs";

// pi-subagents' terminal error statuses (lifecycle/subagent-state.ts's
// isTerminalErrorStatus). Needed because subagents:resumed is one channel for both
// outcomes — see the terminal case below.
const TERMINAL_ERROR_STATUS = new Set(["error", "aborted", "stopped"]);

/**
 * The tracker holds what is neither agent state nor timeline: the identity join
 * between the two views of a worker, and the guard counts.
 *
 * The two views of a worker do not share an identifier, and nothing in either one
 * joins them: a lifecycle id is randomUUID().slice(0, 17) (subagent-manager.ts's
 * create()), while the child's transcript is named <timestamp>_<pi session id> — two
 * unrelated UUIDs, confirmed live (lifecycle "c3f607ae-1b74-400" alongside transcript
 * "2026-09-11T18-39-03-340Z_01a091c4-…"). Keyed separately they would be two agents
 * for one worker: the count in summary.json doubles, and — the real damage — the
 * transcript-derived half never receives a terminal lifecycle event, so it sits at
 * status "running" forever and liveWorkers() blocks the quiescence oracle for the
 * whole run. Spawns are sequential, so the ids are matched in arrival order instead.
 */
export function createTracker() {
	return {
		unbound: [], // lifecycle worker ids awaiting their transcript file
		bound: new Map(), // transcript path -> worker id
		guards: {}, // guard name -> kind (denied|rewritten) -> role -> count
	};
}

export function ensureWorker(state, wid) {
	if (!state[wid]) {
		const s = createAgentState({ id: wid, role: "worker" });
		s.name = wid; // read by the summary's per-agent maps and every log line
		// There is no RPC handshake for a child, so nothing would ever set ready — and
		// checkIdle() refuses to act until every agent is ready. A worker is live from
		// the moment it first appears.
		s.ready = true;
		s.status = "running";
		state[wid] = s;
	}
	return state[wid];
}

// A spawn is seen twice — once as the orchestrator's `subagent` tool call, which is the
// only place the full brief appears, and once as subagents:started, which is the only
// place the worker's id appears. One node in the tree, not two: the tool call pushes the
// entry with the brief and a placeholder `to`, and this claims it when the id arrives.
// Exact at maxConcurrent 1, where a spawn is always the most recent unclaimed one.
export function claimSpawnEntry(timeline, wid, label, now) {
	for (let i = timeline.length - 1; i >= 0; i--) {
		const entry = timeline[i];
		if (entry.kind === "spawn" && entry.to === "worker") {
			entry.to = wid;
			return;
		}
	}
	// No pending tool call to claim (the orchestrator spawned through some path that did
	// not surface as a `subagent` call). The description is all there is to record.
	timeline.push({ ts: now, from: "orchestrator", to: wid, kind: "spawn", body: label });
}

// A `subagent` call that returned without producing a run. Its timeline entry — a spawn
// still holding the "worker" placeholder, or a resume no subagents:resuming confirmed —
// can only be identified by the call that pushed it, so it carries its toolCallId; the
// supervisor's tool_execution_end branch explains why newest-unclaimed is wrong here.
export function dropUnclaimedSubagentEntry(timeline, toolCallId) {
	for (let i = timeline.length - 1; i >= 0; i--) {
		const entry = timeline[i];
		if (entry.toolCallId !== toolCallId) continue;
		const unclaimed = (entry.kind === "spawn" && entry.to === "worker") || (entry.kind === "resume" && entry.claimed === false);
		if (unclaimed) timeline.splice(i, 1);
		return;
	}
}

// A resume's timeline entry is pushed by the orchestrator's own `subagent` call, which
// already names the worker — unlike a spawn there is no id to backfill. This just marks
// that entry as accounted for when subagents:resuming confirms the resume actually
// happened, and writes one from the lifecycle data if the resume came from some other
// path (the tool call is the only known one, so that fallback is a safety net).
export function claimResumeEntry(timeline, wid, label, now) {
	for (let i = timeline.length - 1; i >= 0; i--) {
		const entry = timeline[i];
		if (entry.kind === "resume" && entry.to === wid && entry.claimed === false) {
			entry.claimed = true;
			return;
		}
	}
	timeline.push({ ts: now, from: "orchestrator", to: wid, kind: "resume", body: label, claimed: true });
}

// Announce a worker the first time it appears, whichever event created it. Announcing
// only in `started` meant a background spawn — where `created` creates the state and
// `started` then sees it already exists — produced no spawn audit event, no claimed
// timeline entry and an orphan "worker" node in the delegation tree. Confirmed live:
// 2026-09-11T20-14-14 wrote created→started 1 ms apart at 197.8s and its audit.jsonl had
// no spawn event at all.
function announceWorker(tracker, state, timeline, wid, data, now) {
	// Drop ids that already terminated without their transcript ever arriving (a child
	// that died before persisting a session file). Left at the head of the queue, the
	// next worker's transcript binds to the dead id and a live worker's tool calls,
	// edits and cost are attributed to a worker that is already finished.
	for (let i = tracker.unbound.length - 1; i >= 0; i--) {
		const st = state[tracker.unbound[i]]?.status;
		if (st === "completed" || st === "failed") tracker.unbound.splice(i, 1);
	}
	tracker.unbound.push(wid);
	const label = String(data.description ?? data.prompt ?? data.brief ?? "").replace(/\s+/g, " ").slice(0, 300);
	claimSpawnEntry(timeline, wid, label, now);
	return { agent: "orchestrator", type: "spawn", isBackground: data.isBackground === true, msg: `spawn ${wid}: ${label}` };
}

function workerIdForTranscriptName(tracker, role) {
	if (!role.startsWith("worker:")) return role;
	const base = role.slice("worker:".length);
	for (const [file, wid] of tracker.bound) {
		if (file.replace(/\\/g, "/").endsWith(`/${base}.jsonl`)) return wid;
	}
	return role;
}

/**
 * Apply one lifecycle line. Mutates `state` and `timeline`; returns
 * `{ audit: [...log entries], decision: wid | null }` where `decision` names a worker
 * whose run just ended (the orchestrator's next tool call is its decision).
 */
export function applyLifecycleEvent(tracker, state, timeline, { ev, data, now }) {
	const audit = [];
	// A guard report is a signature to count, not a rule to act on: the model already
	// received the redirect (or the rewritten call ran). No cap, no nudge. Events are
	// `guard:<name>_<kind>` from ext/guard-kit.ts; the last `_` splits name from kind.
	const guardMatch = /^guard:(.+)_(denied|rewritten)$/.exec(ev);
	if (guardMatch) {
		const [, name, kind] = guardMatch;
		const { role: reported = "unknown", ...rest } = data ?? {};
		// A guard inside a worker only knows the worker by its transcript basename
		// (ext/guard-kit.ts roleFor); the supervisor knows it by its lifecycle id. Once the
		// transcript is bound, report under the id everything else uses, so
		// summary.guards and summary.toolCalls name the same worker the same way.
		const role = workerIdForTranscriptName(tracker, String(reported));
		((tracker.guards[name] ??= {})[kind] ??= {})[role] = (tracker.guards[name][kind][role] ?? 0) + 1;
		audit.push({ agent: String(role), type: "guard", msg: `${name} ${kind}: ${JSON.stringify(rest).slice(0, 200)}` });
		return { audit, decision: null };
	}
	const wid = data?.id ? `worker:${data.id}` : null;
	if (!wid) return { audit, decision: null };
	let decision = null;
	switch (ev) {
		// pi-subagents emits onSubagentCreated only for background (queued) spawns, and
		// onSubagentStarted for every spawn — so a foreground worker's first event is
		// `started` and a background worker's is `created`. Both route here so whichever
		// arrives first creates the state, and the other is a no-op. Which of the two that
		// is cannot be fixed host-side: roles.worker.background only sets the definition's
		// run_in_background default, and the orchestrator's own tool call overrides it per
		// spawn (observed live in 2026-09-11T20-14-14). Every run must handle both flows.
		case "subagents:created": {
			const fresh = !state[wid];
			ensureWorker(state, wid);
			if (fresh) audit.push(announceWorker(tracker, state, timeline, wid, data, now));
			break;
		}
		case "subagents:started": {
			const fresh = !state[wid];
			ensureWorker(state, wid).status = "running";
			// Announce only once. A started that follows a created (background queueing)
			// is the same worker reaching the front of the queue, not a new one — all
			// this event adds is that it is now actually running.
			if (fresh) audit.push(announceWorker(tracker, state, timeline, wid, data, now));
			break;
		}
		// The start of a resumed run. onSubagentResuming carries {id, type, description}
		// and nothing else — the prompt that caused it is only in the orchestrator's own
		// `subagent` call, which has already recorded it.
		case "subagents:resuming":
			ensureWorker(state, wid).status = "running";
			audit.push({ agent: "orchestrator", type: "resume", msg: `resuming ${wid}` });
			claimResumeEntry(timeline, wid, String(data.description ?? ""), now);
			break;
		// A message to a worker that is already running, not a state change: steer-tool.ts
		// rejects a steer of anything not running, so the status here is already correct
		// and setting it would be the only thing that could get it wrong.
		case "subagents:steered": {
			ensureWorker(state, wid);
			const message = String(data.message ?? "");
			audit.push({ agent: "orchestrator", type: "resume", msg: `steered ${wid}: ${message.replace(/\s+/g, " ").slice(0, 300)}` });
			timeline.push({ ts: now, from: "orchestrator", to: wid, kind: "resume", body: message });
			break;
		}
		case "subagents:update":
			audit.push({ agent: wid, type: "report", msg: `update: ${String(data.message ?? data.text ?? JSON.stringify(data)).replace(/\s+/g, " ").slice(0, 300)}` });
			timeline.push({ ts: now, from: wid, to: "orchestrator", kind: "report", body: String(data.message ?? data.text ?? "") });
			break;
		// Every way a worker's run can end. subagents:resumed belongs here, not with
		// resuming: it fires from onSubagentResumed, carries the full buildEventData
		// payload (result, error, status, tokens…), and is the ONLY terminal event a
		// resumed run produces — the observer deliberately does not re-emit
		// completed/failed for one, so that existing subscribers keep their once-per-run
		// semantics. Read as a start instead, a resumed worker stays "running" forever:
		// liveWorkers() then blocks the quiescence oracle for the rest of the run and the
		// resumed run's report never reaches the audit, the tree or the decision marker —
		// exactly the behaviour an orchestrator experiment is trying to measure.
		// Only `status` distinguishes the two outcomes on that channel.
		case "subagents:completed": case "subagents:failed": case "subagents:resumed": {
			const failed = ev === "subagents:failed" || TERMINAL_ERROR_STATUS.has(data.status);
			ensureWorker(state, wid).status = failed ? "failed" : "completed";
			if (failed) {
				audit.push({ agent: wid, type: "worker_failed", msg: `failed: ${String(data.error ?? data.reason ?? JSON.stringify(data)).slice(0, 300)}` });
				// A failed worker still needs a node in the tree, or its spawn entry is a
				// branch that simply stops — indistinguishable from one still running.
				timeline.push({ ts: now, from: wid, to: "orchestrator", kind: "report", body: `FAILED: ${String(data.error ?? data.result ?? JSON.stringify(data))}` });
			} else {
				audit.push({ agent: wid, type: "report", msg: `completed: ${String(data.result ?? "").replace(/\s+/g, " ").slice(0, 300)}` });
				timeline.push({ ts: now, from: wid, to: "orchestrator", kind: "report", body: String(data.result ?? "") });
			}
			decision = wid;
			break;
		}
	}
	return { audit, decision };
}

/**
 * Bind a child transcript file to a worker id: the oldest lifecycle worker still
 * waiting for a transcript, or null if there is none yet — in which case the caller
 * leaves the file alone until there is. Inventing an id from the transcript's own
 * basename was worse than waiting: the real lifecycle id then creates a SECOND state
 * entry for the same worker, the invented half never receives a terminal event, so it
 * sits at "running" forever, doubles summary.workers and blocks the quiescence oracle.
 */
export function bindTranscript(tracker, state, transcriptPath) {
	if (tracker.bound.has(transcriptPath)) return tracker.bound.get(transcriptPath);
	if (tracker.unbound.length === 0) return null;
	const wid = tracker.unbound.shift();
	tracker.bound.set(transcriptPath, wid);
	ensureWorker(state, wid);
	return wid;
}
