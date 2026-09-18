import { PATTERNS } from "./patterns.mjs";

// Every bus message goes through here. The supervisor intercepts what it must act on
// (probes, approvals) and relays the rest; nothing a model writes is executed by
// accident because the routing is decided by (pattern, from, kind), never by body.
//
// Probes are intercepted, never relayed: the verifying role verifies real values by
// asking the supervisor to run them against the builder's actual current code,
// instead of asking the builder to self-report — the builder never sees this exchange.
//
// A probe from the builder is never executed (only the verifying role's are) —
// relaying it as ordinary mail produced a live mutual stall: the verifier waited on
// a "run" of the builder's probe that was never going to happen. mail-ext.ts now
// drops the kind for the builder entirely; this is a backstop in case one still
// arrives.
//
// The verifying role's approval is also intercepted, never blind-relayed as raw
// "approved" text: the builder finding out "critic approved!" and then, a beat
// later, "actually that was rejected" is exactly the confusing sequence a stale
// relay produced. The real outcome (from runOracle, on success) is what the
// builder should see.
//
// Solo: the builder's done is the trigger (the original builder-claim gate). Any
// other mail has no recipient — acknowledge it once so the model doesn't wait on
// an answer that will never come.
// Derived from PATTERNS rather than restated: a pattern's roles and its verifier are
// declared once in lib/patterns.mjs, and a second literal copy here is a table a new
// pattern can be added to in one place and forgotten in the other. "worker" is excluded
// because it is not a mail recipient — workers are pi-subagents children without the
// send_mail tool, so mail addressed to one has no destination and is dropped.
const AGENTS_BY_PATTERN = Object.fromEntries(
	Object.entries(PATTERNS).map(([pattern, def]) => [pattern, def.roles.filter((role) => role !== "worker")]),
);
const VERIFIER_BY_PATTERN = Object.fromEntries(Object.entries(PATTERNS).map(([pattern, def]) => [pattern, def.verifier]));

export function routeMail(pattern, msg) {
	// A memory observation is addressed to the future, not to anyone in this run: the
	// supervisor stores it as a candidate (never promoted by its writer) and no agent
	// ever sees it during the run that produced it.
	if (msg.kind === "memory") return { action: "memory", from: msg.from };
	const verifier = VERIFIER_BY_PATTERN[pattern];
	if (verifier && msg.from === verifier && msg.kind === "probe") return { action: "probe" };
	if (verifier && msg.from === verifier && msg.kind === "done") return { action: "approval" };
	// The management interface's one inbound channel (spec §4): the verifying role asks for a
	// decision it cannot make — a criterion looks wrong, it is blocked, it needs budget. Routed
	// like a done claim and never relayed as ordinary mail: the supervisor holds the reply until
	// the manager answers or the decision timeout passes. The kind only exists in the tool when
	// management is on (ext/mail-ext.ts), so this branch is unreachable in a run without it.
	if (verifier && msg.from === verifier && msg.kind === "escalate") return { action: "escalate" };
	if (msg.kind === "probe") return { action: "bounce_probe", to: msg.from };
	if (pattern === "solo" && msg.from === "builder") return msg.kind === "done" ? { action: "solo_done" } : { action: "solo_ack", to: "builder" };
	if (pattern === "orchestrator" && msg.from === "orchestrator") return { action: "solo_ack", to: "orchestrator" };
	if ((AGENTS_BY_PATTERN[pattern] ?? []).includes(msg.to)) return { action: "deliver", to: msg.to };
	return { action: "drop" };
}
