import { test } from "node:test";
import assert from "node:assert/strict";
import { messages } from "../lib/messages.mjs";

// Every string below is the exact literal supervisor.mjs delivered before the
// extraction. Dyad and solo runs must stay byte-identical; the orchestrator's texts
// must not describe roles the run does not have.
const dyad = messages("dyad");
const solo = messages("solo");
const orch = messages("orchestrator");

test("who(): the three words that vary by pattern", () => {
	assert.deepEqual(dyad.who, { builder: "BUILDER", writer: "BUILDER", counterpart: "your counterpart" });
	assert.deepEqual(solo.who, { builder: "BUILDER", writer: "BUILDER", counterpart: "your counterpart" });
	assert.deepEqual(orch.who, { builder: "the workspace", writer: "a worker", counterpart: "a worker" });
});

test("silent turn", () => {
	assert.equal(solo.silentTurn(), '[SUPERVISOR] Your last turn produced text but called no tool, so nothing happened. If your implementation is complete and self-tested, send kind="done" via send_mail; otherwise keep working.');
	assert.equal(orch.silentTurn(), '[SUPERVISOR] Your last turn produced text but called no tool, so nothing happened — no worker was briefed, no probe was run and no mail was sent. If the workspace already satisfies the specification, send kind="done"; otherwise probe it or brief a worker.');
	assert.equal(dyad.silentTurn(), "[SUPERVISOR] Your last turn produced text but never called send_mail — nothing was sent to your counterpart, and they never saw it. You can only communicate via the send_mail tool. If you meant to say something, send it now.");
});

test("mail routing texts", () => {
	assert.equal(dyad.memoryAck(), "[SUPERVISOR] Recorded as a memory candidate for future runs of this task. Nothing else happens with it now; carry on.");
	assert.equal(dyad.probeBounced(), '[SUPERVISOR] Your kind="probe" was not run — only the verifying role\'s probes are host-executed. Describe what you found as kind="status" instead.');
	assert.equal(orch.ack(), '[SUPERVISOR] Acknowledged, but nobody will answer this — the supervisor is a program and there is no other agent to reply. When the workspace satisfies the specification and you have probed it, send kind="done".');
	assert.equal(solo.ack(), '[SUPERVISOR] Acknowledged, but nobody will answer this — there is no counterpart in this run. When your implementation is complete and self-tested, send kind="done".');
});

test("probe texts", () => {
	assert.equal(dyad.probe.unsupported("glob"), '[SUPERVISOR] This task has no probe runner — kind="probe" isn\'t supported for "glob".');
	assert.equal(dyad.probe.noSrc(), "[SUPERVISOR] Probe failed: BUILDER's src/ does not exist yet.");
	assert.equal(orch.probe.noSrc(), "[SUPERVISOR] Probe failed: the workspace's src/ does not exist yet.");
	assert.equal(
		dyad.probe.unparseable(3, "Unexpected token", "[{"),
		'[SUPERVISOR] Probe #3 rejected: your probe body is not valid JSON (Unexpected token). Exact bytes received: "[{"\nCheck for a stray/misplaced bracket or brace before re-sending — a single mistyped character here reads as a real result, not a JSON error, once it hits probe.mjs.',
	);
	assert.equal(
		dyad.probe.allRepeats(4, ["a: (1) — BLOCKED"]),
		"[SUPERVISOR] Probe #4 was not run — every case in it is an exact repeat of a prior probe against this same, unchanged code:\na: (1) — BLOCKED\n\nIf you're satisfied, send done. If not, send a genuinely different case, or a question to BUILDER — this exact probe is now a dead end.",
	);
	assert.match(orch.probe.allRepeats(4, ["x"]), /a question to a worker — this exact probe is now a dead end\.$/);
	assert.equal(dyad.probe.noResult(2, ""), "[SUPERVISOR] Probe run #2 produced no parseable result.");
	assert.equal(dyad.probe.noResult(2, "boom"), "[SUPERVISOR] Probe run #2 produced no parseable result. stderr: boom");
	assert.equal(
		dyad.probe.results(5, ["1/1 matched your stated expectations."]),
		"[SUPERVISOR] Probe run #5 — executed directly against BUILDER's current src/, not self-reported. BUILDER did not see this; no reply to BUILDER is needed.\n1/1 matched your stated expectations.",
	);
	assert.equal(
		orch.probe.results(5, ["a", "b"]),
		"[SUPERVISOR] Probe run #5 — executed directly against the workspace's current src/, not self-reported. No worker saw this; there is nobody to reply to.\na\n\nb",
	);
	assert.equal(dyad.probe.crashed(6, "kaput"), "[SUPERVISOR] Probe run #6 crashed: kaput");
});

test("approval gate reasons", () => {
	assert.equal(dyad.gate.no_probe(), '[SUPERVISOR] Approval not accepted: you have not run a single kind="probe" yet, so nothing confirms this matches BUILDER\'s real code. Probe first, then approve.');
	assert.equal(dyad.gate.no_src(), "[SUPERVISOR] Approval not accepted: BUILDER's src/ no longer exists.");
	assert.equal(dyad.gate.stale(), '[SUPERVISOR] Approval not accepted: BUILDER\'s src/ has changed since your last probe — the code you verified is not the code that would be tested. Send a fresh kind="probe" against the current code, then approve.');
	assert.equal(dyad.gate.too_soon(2500), "[SUPERVISOR] Approval not accepted yet: BUILDER edited code 2.5s ago, too recent to be sure it's settled. Wait a few seconds and send done again — no need to re-probe unless BUILDER tells you something changed.");
	assert.equal(orch.gate.too_soon(2500), "[SUPERVISOR] Approval not accepted yet: a worker edited code 2.5s ago, too recent to be sure it's settled. Wait a few seconds and send done again — no need to re-probe unless a worker tells you something changed.");
});

test("oracle texts", () => {
	assert.equal(dyad.oracle.missingSrc(2), "Oracle run #2: 0/0 — BUILDER's src/ is missing.");
	assert.equal(orch.oracle.missingSrc(2), "Oracle run #2: 0/0 — the workspace's src/ is missing.");
	assert.equal(dyad.oracle.missingSrcBuilder("V"), "[SUPERVISOR] V Nothing was found to check.");
	assert.equal(dyad.oracle.missingSrcVerifier("V"), "[SUPERVISOR] V");
	assert.equal(solo.oracle.failedSolo("V", 3), "[SUPERVISOR] V Not done. Re-read the SPECIFICATION in your prompt — every error rule, every edge case it names — find what you missed, fix it, then send done again. (3 attempts left)");
	assert.equal(dyad.oracle.failedBuilder("V", 3), "[SUPERVISOR] CRITIC approved your work. V Not done. Work with CRITIC to find what you missed, then claim done again. (3 approvals left)");
	assert.equal(dyad.oracle.failedVerifier("V", 3), "[SUPERVISOR] You approved BUILDER's work. V Your approval was wrong. Find what you both missed; interrogate on inputs you have not yet asked about. (3 approvals left)");
	assert.equal(orch.oracle.failedVerifier("V", 3), "[SUPERVISOR] Your done claim was wrong. V Find what was missed with probes and brief a worker on the fix. (3 claims left)");
});

test("idle nudge", () => {
	assert.equal(orch.nudge.idle(120), '[SUPERVISOR] You have been idle for 120s with no worker running. Either start or steer a worker, probe the workspace, or send kind="done" if it is complete.');
	assert.equal(solo.nudge.idle(120), '[SUPERVISOR] You have been idle for 120s. Either keep working, or send kind="done" if your implementation is complete.');
	assert.equal(dyad.nudge.idle(120), '[SUPERVISOR] Both agents have been idle for 120s. Either continue working, ask CRITIC something, or send kind="done".');
});

test("bash timeout texts", () => {
	assert.equal(
		dyad.bash.timeoutSelf(95, 90, "find /"),
		'[SUPERVISOR] Your bash command was force-aborted after running 95s (limit 90s): `find /`. Always pass an explicit "timeout" (seconds) to bash, and avoid unbounded searches like "find /" — scope searches to the workspace.',
	);
	assert.equal(
		orch.bash.timeoutWorker("worker:abc", 95, 90, "find /"),
		'[SUPERVISOR] Worker worker:abc has had a bash command running for 95s (limit 90s): `find /`. Your current turn was aborted. If you started the worker in the foreground, its bash was aborted with it and it has settled — continue it with subagent using resume: "abc". If you started it in the background, it is still running: use steer_subagent to tell it to stop that command, scope its searches, and pass an explicit bash "timeout".',
	);
});

test("kickoff texts", () => {
	assert.equal(dyad.kickoff.critic(), "[SUPERVISOR] Session start. BUILDER is waiting. Open the conversation: tell BUILDER what they are building, at the level of a one-paragraph brief. Let them ask for details.");
	assert.equal(dyad.kickoff.builder(), "[SUPERVISOR] Session start. Read README.md. CRITIC will mail you a brief shortly; you may also mail CRITIC first if you prefer.");
	assert.equal(solo.kickoff.builder(), '[SUPERVISOR] Session start. Read README.md. The full specification is in your system prompt under SPECIFICATION. Implement it under src/, test it yourself, then send kind="done" to the supervisor.');
	assert.equal(orch.kickoff.orchestrator(), '[SUPERVISOR] Session start. The specification is in your system prompt. Read README.md and src/, decide how to split the work, and start a worker with subagent_type "worker". Verify with kind="probe" before you claim kind="done".');
});

test("time status lines", () => {
	assert.equal(dyad.time.budget(30, 1500, 2, 1470), "[time: 30s elapsed / 1500s wall-clock budget — 2% used, ~1470s left]");
	assert.equal(dyad.time.nearlyExhausted, " ⚠ Budget nearly exhausted. Stop exploring further edge cases — reach a decision now with what you already know.");
	assert.equal(dyad.time.halfGone, " More than half the budget is gone. Start converging toward done/approval rather than opening new lines of inquiry.");
	assert.equal(dyad.time.noProbeYet, ' You have not sent a single kind="probe" yet — approval cannot go through without one. Send a probe now.');
	assert.equal(dyad.time.gateSatisfiable, ' The approval gate is satisfiable right now: your last probe matches the current, quiescent workspace. If nothing in it looked wrong, send kind="done" now rather than re-probing the same ground again.');
});

test("the orchestrator's texts never name roles the run does not have", () => {
	const all = [
		orch.silentTurn(), orch.ack(), orch.probe.noSrc(), orch.probe.allRepeats(1, ["x"]), orch.probe.results(1, ["y"]),
		orch.gate.no_probe(), orch.gate.no_src(), orch.gate.stale(), orch.gate.too_soon(1000),
		orch.oracle.missingSrc(1), orch.oracle.failedVerifier("V", 1), orch.nudge.idle(1), orch.bash.timeoutWorker("worker:a", 1, 1, "x"), orch.kickoff.orchestrator(),
	];
	for (const text of all) assert.doesNotMatch(text, /BUILDER|CRITIC|your counterpart/, text);
});
