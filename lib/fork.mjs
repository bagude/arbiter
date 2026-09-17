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

/** A copy of the entries whose header carries the fork's own workspace path. */
export function rewriteSessionHeader(entries, { cwd }) {
	if (!entries.length || entries[0].type !== "session") throw new Error("session entries must start with a header");
	return [{ ...entries[0], cwd }, ...entries.slice(1)];
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
