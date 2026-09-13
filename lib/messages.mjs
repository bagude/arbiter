// Every text the supervisor delivers to an agent, keyed by situation and rendered for
// a pattern. The supervisor is a program, not a model: these strings ARE its side of
// the conversation, and test/messages.test.mjs pins each one — dyad and solo to the
// exact literals they have always been, the orchestrator's to texts that never name a
// role the run does not have.
//
// Under the orchestrator pattern there is no BUILDER and no counterpart, yet the first
// orchestrator run (2026-09-11T18-42-34) delivered "executed directly against BUILDER's
// current src/" six times and "nothing was sent to your counterpart" on every silent
// turn. For an experiment about what an orchestrator does, text describing roles the
// run does not have is a confound, not a cosmetic slip. These are the only words that
// vary: `builder` is whatever owns src/, `writer` is whoever edits it, `counterpart` is
// whoever a message would go to.
export function who(pattern) {
	return pattern === "orchestrator"
		? { builder: "the workspace", writer: "a worker", counterpart: "a worker" }
		: { builder: "BUILDER", writer: "BUILDER", counterpart: "your counterpart" };
}

export function messages(pattern) {
	const orch = pattern === "orchestrator";
	const solo = pattern === "solo";
	const WHO = who(pattern);
	return {
		who: WHO,

		// send_mail is the ONLY way an agent reaches anyone. A turn that stops with real
		// text but no tool call is a message composed and then never actually sent.
		silentTurn: () =>
			solo
				? '[SUPERVISOR] Your last turn produced text but called no tool, so nothing happened. If your implementation is complete and self-tested, send kind="done" via send_mail; otherwise keep working.'
				: orch
					? '[SUPERVISOR] Your last turn produced text but called no tool, so nothing happened — no worker was briefed, no probe was run and no mail was sent. ' +
						'If the workspace already satisfies the specification, send kind="done"; otherwise probe it or brief a worker.'
					: "[SUPERVISOR] Your last turn produced text but never called send_mail — nothing was sent to your counterpart, and they never saw it. " +
						"You can only communicate via the send_mail tool. If you meant to say something, send it now.",

		memoryAck: () => '[SUPERVISOR] Recorded as a memory candidate for future runs of this task. Nothing else happens with it now; carry on.',

		probeBounced: () =>
			'[SUPERVISOR] Your kind="probe" was not run — only the verifying role\'s probes are host-executed. Describe what you found as kind="status" instead.',

		// routeMail sends the orchestrator's non-probe, non-done mail here too, so this is
		// one of the texts that must not describe a counterpart the run does not have, or
		// an implementation the orchestrator does not write.
		ack: () =>
			orch
				? '[SUPERVISOR] Acknowledged, but nobody will answer this — the supervisor is a program and there is no other agent to reply. When the workspace satisfies the specification and you have probed it, send kind="done".'
				: '[SUPERVISOR] Acknowledged, but nobody will answer this — there is no counterpart in this run. When your implementation is complete and self-tested, send kind="done".',

		probe: {
			unsupported: (task) => `[SUPERVISOR] This task has no probe runner — kind="probe" isn't supported for "${task}".`,
			noSrc: () => `[SUPERVISOR] Probe failed: ${WHO.builder}'s src/ does not exist yet.`,
			unparseable: (n, err, bytes) =>
				`[SUPERVISOR] Probe #${n} rejected: your probe body is not valid JSON (${err}). ` +
				`Exact bytes received: ${JSON.stringify(bytes)}\n` +
				`Check for a stray/misplaced bracket or brace before re-sending — a single mistyped character here reads as a real result, not a JSON error, once it hits probe.mjs.`,
			allRepeats: (n, blockedLines) =>
				`[SUPERVISOR] Probe #${n} was not run — every case in it is an exact repeat of a prior probe against this same, unchanged code:\n${blockedLines.join("\n")}\n\n` +
				`If you're satisfied, send done. If not, send a genuinely different case, or a question to ${WHO.writer} — this exact probe is now a dead end.`,
			noResult: (n, stderr) => `[SUPERVISOR] Probe run #${n} produced no parseable result.${stderr ? ` stderr: ${stderr.slice(0, 500)}` : ""}`,
			results: (n, parts) =>
				`[SUPERVISOR] Probe run #${n} — executed directly against ${WHO.builder}'s current src/, not self-reported. ` +
				`${orch ? "No worker saw this; there is nobody to reply to." : "BUILDER did not see this; no reply to BUILDER is needed."}\n${parts.join("\n\n")}`,
			crashed: (n, err) => `[SUPERVISOR] Probe run #${n} crashed: ${err}`,
		},

		gate: {
			no_probe: () => `[SUPERVISOR] Approval not accepted: you have not run a single kind="probe" yet, so nothing confirms this matches ${WHO.builder}'s real code. Probe first, then approve.`,
			no_src: () => `[SUPERVISOR] Approval not accepted: ${WHO.builder}'s src/ no longer exists.`,
			stale: () => `[SUPERVISOR] Approval not accepted: ${WHO.builder}'s src/ has changed since your last probe — the code you verified is not the code that would be tested. Send a fresh kind="probe" against the current code, then approve.`,
			too_soon: (sinceEditMs) =>
				`[SUPERVISOR] Approval not accepted yet: ${WHO.writer} edited code ${(sinceEditMs / 1000).toFixed(1)}s ago, too recent to be sure it's settled. Wait a few seconds and send done again — no need to re-probe unless ${WHO.writer} tells you something changed.`,
		},

		oracle: {
			missingSrc: (n) => `Oracle run #${n}: 0/0 — ${WHO.builder}'s src/ is missing.`,
			missingSrcBuilder: (verdict0) => `[SUPERVISOR] ${verdict0} Nothing was found to check.`,
			missingSrcVerifier: (verdict0) => `[SUPERVISOR] ${verdict0}`,
			failedSolo: (verdict, left) =>
				`[SUPERVISOR] ${verdict} Not done. Re-read the SPECIFICATION in your prompt — every error rule, every edge case it names — find what you missed, fix it, then send done again. (${left} attempts left)`,
			failedBuilder: (verdict, left) =>
				`[SUPERVISOR] CRITIC approved your work. ${verdict} Not done. Work with CRITIC to find what you missed, then claim done again. (${left} approvals left)`,
			// The orchestrator did not approve someone else's work — it claimed the workspace
			// was done and was wrong. Its remedy is its own two instruments, probes and a
			// worker, not interrogating a counterpart that does not exist.
			failedVerifier: (verdict, left) =>
				orch
					? `[SUPERVISOR] Your done claim was wrong. ${verdict} Find what was missed with probes and brief a worker on the fix. (${left} claims left)`
					: `[SUPERVISOR] You approved BUILDER's work. ${verdict} Your approval was wrong. Find what you both missed; interrogate on inputs you have not yet asked about. (${left} approvals left)`,
		},

		nudge: {
			idle: (idleNudgeSec) =>
				orch
					? `[SUPERVISOR] You have been idle for ${idleNudgeSec}s with no worker running. Either start or steer a worker, probe the workspace, or send kind="done" if it is complete.`
					: solo
						? `[SUPERVISOR] You have been idle for ${idleNudgeSec}s. Either keep working, or send kind="done" if your implementation is complete.`
						: `[SUPERVISOR] Both agents have been idle for ${idleNudgeSec}s. Either continue working, ask CRITIC something, or send kind="done".`,
		},

		compaction: {
			checkpointRequest: (tokens) =>
				`[SUPERVISOR] Context checkpoint: your context is ${tokens} tokens and a phase just ended, so the supervisor will compact it. Call checkpoint now — findings labelled observed / interpreted / hypothesis, open questions, next steps, every id (probes, m_…, worker ids, h_…) verbatim — before doing anything else. After the compaction you continue from a summary that holds your checkpoint and the supervisor's ledger.`,
			done: (before, after, hadCheckpoint) =>
				`[SUPERVISOR] Context compacted: ${before} → ${after ?? "fewer"} tokens. The summary above holds ${hadCheckpoint ? "your checkpoint and" : "no checkpoint (none was written) but"} the run ledger: probe numbers, memory ids, worker ids and result handles are still valid — a new probe re-runs a query, recall_result pages an archived result, memory_get re-reads a record. Continue from the next steps.`,
		},

		bash: {
			timeoutSelf: (ranSec, limitSec, command) =>
				`[SUPERVISOR] Your bash command was force-aborted after running ${ranSec}s (limit ${limitSec}s): ` +
				`\`${String(command).slice(0, 200)}\`. Always pass an explicit "timeout" (seconds) to bash, and avoid unbounded searches ` +
				`like "find /" — scope searches to the workspace.`,
			// Background flow caveat: get_subagent_result{wait:true} only races the wait
			// against the abort signal, so the abort ends the orchestrator's wait but a
			// background child keeps running — the host cannot reach it. The text must not
			// claim otherwise; steer_subagent is the one thing that reaches a running worker,
			// and resume only opens once it has settled.
			timeoutWorker: (name, ranSec, limitSec, command) =>
				`[SUPERVISOR] Worker ${name} has had a bash command running for ${ranSec}s (limit ${limitSec}s): ` +
				`\`${String(command).slice(0, 200)}\`. Your current turn was aborted. If you started the worker in the foreground, its bash was aborted with it and it has settled — ` +
				`continue it with subagent using resume: "${name.replace(/^worker:/, "")}". If you started it in the background, it is still running: ` +
				`use steer_subagent to tell it to stop that command, scope its searches, and pass an explicit bash "timeout".`,
		},

		kickoff: {
			critic: () => "[SUPERVISOR] Session start. BUILDER is waiting. Open the conversation: tell BUILDER what they are building, at the level of a one-paragraph brief. Let them ask for details.",
			builder: () =>
				solo
					? '[SUPERVISOR] Session start. Read README.md. The full specification is in your system prompt under SPECIFICATION. Implement it under src/, test it yourself, then send kind="done" to the supervisor.'
					: "[SUPERVISOR] Session start. Read README.md. CRITIC will mail you a brief shortly; you may also mail CRITIC first if you prefer.",
			orchestrator: () =>
				'[SUPERVISOR] Session start. The specification is in your system prompt. Read README.md and src/, decide how to split the work, and start a worker with subagent_type "worker". Verify with kind="probe" before you claim kind="done".',
		},

		// Appended to every delivered message so time pressure is always visible, not
		// something either agent has to think to ask about.
		time: {
			budget: (elapsedSec, wallSec, pct, remainingSec) =>
				`[time: ${elapsedSec.toFixed(0)}s elapsed / ${wallSec}s wall-clock budget — ${pct}% used, ~${remainingSec.toFixed(0)}s left]`,
			nearlyExhausted: " ⚠ Budget nearly exhausted. Stop exploring further edge cases — reach a decision now with what you already know.",
			halfGone: " More than half the budget is gone. Start converging toward done/approval rather than opening new lines of inquiry.",
			noProbeYet: ' You have not sent a single kind="probe" yet — approval cannot go through without one. Send a probe now.',
			gateSatisfiable:
				" The approval gate is satisfiable right now: your last probe matches the current, quiescent workspace. " +
				'If nothing in it looked wrong, send kind="done" now rather than re-probing the same ground again.',
		},
	};
}
