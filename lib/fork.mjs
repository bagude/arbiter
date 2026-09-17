// Fork helpers: everything a forked run needs that can be computed without a
// running supervisor, so it is unit-tested (supervisor.mjs cannot be imported by
// tests). Spec: docs/superpowers/specs/2026-09-17-fork-runner-design.md.
export const BRANCHES = ["G", "A-natural", "A-oracle"];

/** Keep the header and every entry before the call-th (1-based) assistant message entry. */
export function truncateSessionEntries(entries, call) {
	let seen = 0;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant") {
			seen++;
			if (seen === call) return { entries: entries.slice(0, i), cut: i };
		}
	}
	throw new Error(`cannot fork at call ${call}: the session has only ${seen} assistant entries`);
}

/** Epoch ms for a session entry: pi writes an ISO `timestamp` on every entry type. */
function entryTs(e) {
	if (typeof e?.timestamp === "number") return e.timestamp;
	return Date.parse(e?.timestamp ?? "");
}

/**
 * A worker transcript as it stood at instant `tsMs` (epoch ms): the header, then every entry
 * up to the first one recorded after that instant. Used on the transcripts a fork inherits —
 * the source run kept writing to them, and a resumed worker continues from the file as it is,
 * so an untruncated one would carry the source run's FINAL state into the fork instead of its
 * state at the fork instant.
 *
 * The scan stops at the first entry past `tsMs` rather than sieving the whole file, so an entry
 * carrying no usable timestamp is kept exactly when every earlier kept entry was at or before
 * the instant. A transcript is append-only and chronological, so the two readings agree.
 *
 * The time cut alone can land anywhere, including between an assistant message and the tool
 * results answering its calls. A resume re-prompts the session (pi-subagents resumeTurnLoop →
 * session.prompt), which appends a user message, so an assistant leaf that is a plain final
 * answer is a valid state and is kept; an assistant leaf that still holds a toolCall block has
 * its results missing (they would follow it), and nothing on load repairs a dangling call. So
 * the tail retreats past every such leaf until the last kept message entry is a user,
 * tool-result or answer-only assistant message. The header is never dropped.
 */
const hasToolCall = (e) => Array.isArray(e?.message?.content) && e.message.content.some((c) => c?.type === "toolCall");

export function truncateEntriesAt(entries, tsMs) {
	if (!entries.length) return [];
	const out = [entries[0]]; // the header, which predates every entry below it
	for (let i = 1; i < entries.length; i++) {
		const t = entryTs(entries[i]);
		if (Number.isFinite(t) && t > tsMs) break;
		out.push(entries[i]);
	}
	let end = out.length;
	while (end > 1) {
		let m = end - 1;
		while (m >= 1 && out[m]?.type !== "message") m--; // the last kept message entry
		if (m < 1 || out[m].message?.role !== "assistant" || !hasToolCall(out[m])) break;
		end = m; // drop that dangling assistant message and anything trailing it, then look again
	}
	return out.slice(0, end);
}

/** A copy of the entries whose header carries the fork's own workspace path. */
export function rewriteSessionHeader(entries, { cwd }) {
	if (!entries.length || entries[0].type !== "session") throw new Error("session entries must start with a header");
	return [{ ...entries[0], cwd }, ...entries.slice(1)];
}

/**
 * The source run's starts and reports at or before the fork instant, as ONE list in the
 * order a fork must replay them — because the done gate reads their relative order, not
 * their contents.
 *
 * `unreportedWorkers` (lib/workers.mjs) calls a completed worker unreported when no report
 * of its has `seq > lastStartedSeq`, and only the `started`/`resuming` lifecycle cases set
 * `lastStartedSeq`. A fork that replayed only the reports gave each one a seq above a
 * `lastStartedSeq` that was never set at all, so every restored worker counted as reported
 * whatever the record said — and the fork's `done` was allowed where the source run's was
 * refused with "approval without worker report". Replaying both streams in one `ts` order,
 * assigning one seq per item, puts each worker's last start above or below its reports
 * exactly where the record had it.
 *
 * `manifestRecords` is lib/worker-manifest.mjs's raw records (not the join — the join keeps
 * one row per worker and the point here is the sequence); `reportRows` is reports.jsonl.
 * Both are filtered on `tsMax` here, so the caller has one instant to pass and one rule.
 *
 * Ties go to the REPORT. `tracker.seq` exists precisely because clocks tie: pumpLifecycle
 * resamples the clock per event in a tight poll loop, so two strictly ordered events can
 * share a millisecond, and merging two files by `ts` brings that ambiguity back. A report
 * sharing an instant with a start was filed by the run that PRECEDED that start, and the
 * report-first reading is also the conservative one — it leaves the worker unreported, which
 * is the direction the done gate was already refusing in.
 */
export function forkReplayOrder(manifestRecords, reportRows, tsMax) {
	const items = [];
	// Pushed first, so the index tiebreak below puts a report ahead of a start it ties with.
	for (const r of reportRows ?? []) {
		if (!Number.isFinite(r?.ts) || r.ts > tsMax) continue;
		items.push({ kind: "report", ts: r.ts, row: r });
	}
	for (const r of manifestRecords ?? []) {
		if (!Number.isFinite(r?.ts) || r.ts > tsMax) continue;
		if (!r.wid || (r.ev !== "started" && r.ev !== "resuming")) continue;
		items.push({ kind: "start", ts: r.ts, wid: r.wid, ev: r.ev });
	}
	return items
		.map((item, i) => [item, i])
		.sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
		.map(([item]) => item);
}

const MAIL_CLASSES = new Set(["probe", "done", "memory"]);

/** Harness counters at the moment of the call-th inference, from decisions.jsonl. */
export function forkCounters(points, call) {
	const p = points.find((x) => x.i === call - 1);
	if (!p) throw new Error(`no decision point for call ${call}`);
	const mailCount = points.filter((x) => x.i < call - 1 && MAIL_CLASSES.has(x.action.cls)).length;
	return { probeCount: p.state.probes, doneAttempts: p.state.doneAttempts, pendingProbe: Boolean(p.state.pendingProbe), mailCount };
}

/** Is the fork's first captured request the recorded one? Messages deep-equal, same tool names. */
export function payloadEquals(a, b) {
	const am = a?.messages ?? [], bm = b?.messages ?? [];
	for (let i = 0; i < Math.max(am.length, bm.length); i++) {
		if (!am[i] || !bm[i]) return { equal: false, firstDiff: { index: i, field: "missing" } };
		for (const field of new Set([...Object.keys(am[i]), ...Object.keys(bm[i])])) {
			if (JSON.stringify(am[i][field]) !== JSON.stringify(bm[i][field])) return { equal: false, firstDiff: { index: i, field } };
		}
	}
	const names = (p) => (p?.tools ?? []).map((t) => t.function?.name ?? t.name).sort().join(",");
	if (names(a) !== names(b)) return { equal: false, firstDiff: "tools" };
	return { equal: true, firstDiff: null };
}

/** Parse and validate ARBITER_FORK; null when unset. */
export function forkSpec(env) {
	const raw = (env.ARBITER_FORK ?? "").trim();
	if (!raw) return null;
	let f;
	try { f = JSON.parse(raw); } catch (err) { throw new Error(`ARBITER_FORK is not JSON: ${err.message}`); }
	if (!f.run || typeof f.run !== "string") throw new Error("ARBITER_FORK.run must name a recorded run");
	if (!Number.isInteger(f.call) || f.call < 1) throw new Error("ARBITER_FORK.call must be a 1-based inference number");
	if (!BRANCHES.includes(f.branch)) throw new Error(`ARBITER_FORK.branch must be one of ${BRANCHES.join(", ")}`);
	if (f.branch !== "G" && !f.action) throw new Error("ARBITER_FORK.action (an action class) is required for A branches");
	if (f.branch === "A-oracle" && !f.tool) throw new Error("ARBITER_FORK.tool (and args) are required for A-oracle");
	return { run: f.run, call: f.call, branch: f.branch, action: f.action ?? null, tool: f.tool ?? null, args: f.args ?? null, replicate: Number.isInteger(f.replicate) ? f.replicate : 1 };
}
