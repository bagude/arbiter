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

function testsReason(specialist, failed) {
	const retry = `then read src/__tests__/*.test.mjs against the specification, resume the tester for anything missing, and retry this spawn. To proceed without tests, make the first line of the prompt "topology: skip — <reason>".`;
	if (failed === "tests:missing") return `topology: ${specialist} needs tests, and src/__tests__/ has none. Spawn the tester first with the API (exports and signatures) from the specification, ${retry}`;
	return `topology: ${specialist} needs tests; tests exist but you have not read them since they were written. Read src/__tests__/ against the specification, then retry this spawn. To proceed anyway, make the first line of the prompt "topology: skip — <reason>".`;
}

export function decideSpawn({ mode, needsFor, input, state, testsFiles }) {
	const specialist = String(input?.subagent_type ?? "");
	const checked = (needsFor?.[specialist] ?? []).filter((a) => CHECKED_ARTIFACTS.includes(a));
	if (!checked.length || input?.resume) return { ok: true, event: null };
	const firstLine = String(input?.prompt ?? "").split(/\r?\n/)[0];
	const skip = SKIP_RE.exec(firstLine);
	if (skip) return { ok: true, event: "skipped", reason: skip[1].trim().slice(0, 200) };
	let failed = null;
	if (checked.includes("tests")) {
		const files = Array.isArray(testsFiles) ? testsFiles : [];
		if (!files.length) failed = "tests:missing";
		else if (state.lastTestsRead < Math.max(...files.map((f) => Number(f.mtimeMs) || 0))) failed = "tests:unread";
	}
	if (!failed) return { ok: true, event: null };
	const key = `${specialist}:${failed}`;
	if (mode === "nudge" && state.denied.has(key)) return { ok: true, event: "waived", failed };
	state.denied.add(key);
	return { ok: false, event: "denied", reason: testsReason(specialist, failed), failed };
}
