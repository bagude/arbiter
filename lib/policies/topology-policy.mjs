// Topology policy: may the orchestrator spawn this specialist now?
//
// A specialist's `needs` (lib/roster.mjs) name artifacts. Only `tests` has a
// workspace check in this slice: at least one file under src/__tests__/, and the
// orchestrator has read that directory since the newest file was written — the
// review step where a missing case gets caught before any code exists
// (docs/batch/roster-pathnorm-pair-2.md: both misses were a case the tester never
// derived and the orchestrator never looked for).
//
// Modes: "enforce" denies every violating spawn; "nudge" denies the first violating
// spawn per specialist per failed check and lets the next through (waived), so the
// orchestrator is told once and the record shows what it chose. Either mode accepts a brief whose
// first line is `topology: skip — <reason>` and reports the reason.
export const CHECKED_ARTIFACTS = ["tests"];

const TESTS_DIR_RE = /(^|[\\/])src[\\/]__tests__([\\/]|$)/;
const SKIP_RE = /^\s*topology:\s*skip\s*[—–-]+\s*(.*)$/;

export function initialState() {
	return { lastTestsRead: 0, denied: new Set() };
}

/** Record reads of src/__tests__ so decideSpawn can tell "written" from "reviewed". */
export function noteToolCall({ toolName, input }, state, nowMs) {
	const p = String(input?.path ?? "");
	const cmd = String(input?.command ?? "");
	const reads = ((toolName === "read" || toolName === "ls") && TESTS_DIR_RE.test(p)) || (toolName === "bash" && cmd.includes("src/__tests__"));
	if (reads) state.lastTestsRead = Math.max(state.lastTestsRead, nowMs);
}

function testsReason(specialist, failed, changed = "") {
	const retry = `then read src/__tests__/*.test.mjs against the specification, resume the tester for anything missing, and retry this spawn. To proceed without tests, make the first line of the prompt "topology: skip — <reason>".`;
	if (failed === "tests:missing") return `topology: ${specialist} needs tests, and src/__tests__/ has none. Spawn the tester first with the API (exports and signatures) from the specification, ${retry}`;
	return `topology: ${specialist} needs tests; tests exist but you have not read them since they were written${changed}. Read src/__tests__/ against the specification, then retry this spawn. To proceed anyway, make the first line of the prompt "topology: skip — <reason>".`;
}

// How much moved since the read, so the denial is not a flat "read it again" after a
// three-line tester resume: one such re-read of a 280-line file cost about 3.7k tokens in
// run 2026-09-17T16-47-16. testsFiles carries mtimes only (ext/guards/topology.ts), so
// bytes are not available; the measure is how many files were written and how long after
// the read the newest one landed. lastTestsRead of 0 means never read, not the epoch.
function changedSince(files, lastTestsRead, newest) {
	if (!lastTestsRead) return " — in fact you have not read them at all";
	const newer = files.filter((f) => (Number(f.mtimeMs) || 0) > lastTestsRead).length;
	const sec = Math.max(0, Math.round((newest - lastTestsRead) / 1000));
	return ` (${newer} of ${files.length} file${files.length === 1 ? "" : "s"} written since that read, the newest ${sec}s after it)`;
}

export function decideSpawn({ mode, needsFor, input, state, testsFiles }) {
	const specialist = String(input?.subagent_type ?? "");
	const checked = (needsFor?.[specialist] ?? []).filter((a) => CHECKED_ARTIFACTS.includes(a));
	if (!checked.length || input?.resume) return { ok: true, event: null };
	const firstLine = String(input?.prompt ?? "").split(/\r?\n/)[0];
	const skip = SKIP_RE.exec(firstLine);
	if (skip) return { ok: true, event: "skipped", reason: skip[1].trim().slice(0, 200) };
	let failed = null;
	let changed = "";
	if (checked.includes("tests")) {
		const files = Array.isArray(testsFiles) ? testsFiles : [];
		const newest = files.length ? Math.max(...files.map((f) => Number(f.mtimeMs) || 0)) : 0;
		if (!files.length) failed = "tests:missing";
		else if (state.lastTestsRead < newest) {
			failed = "tests:unread";
			changed = changedSince(files, state.lastTestsRead, newest);
		}
	}
	if (!failed) return { ok: true, event: null };
	const key = `${specialist}:${failed}`;
	if (mode === "nudge" && state.denied.has(key)) return { ok: true, event: "waived", failed };
	state.denied.add(key);
	return { ok: false, event: "denied", reason: testsReason(specialist, failed, changed), failed };
}
