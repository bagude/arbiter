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
const AGENTS_BY_PATTERN = { dyad: ["builder", "critic"], solo: ["builder"], orchestrator: ["orchestrator"] };
const VERIFIER_BY_PATTERN = { dyad: "critic", orchestrator: "orchestrator" };

export function routeMail(pattern, msg) {
	const verifier = VERIFIER_BY_PATTERN[pattern];
	if (verifier && msg.from === verifier && msg.kind === "probe") return { action: "probe" };
	if (verifier && msg.from === verifier && msg.kind === "done") return { action: "approval" };
	if (msg.kind === "probe") return { action: "bounce_probe", to: msg.from };
	if (pattern === "solo" && msg.from === "builder") return msg.kind === "done" ? { action: "solo_done" } : { action: "solo_ack", to: "builder" };
	if (pattern === "orchestrator" && msg.from === "orchestrator") return { action: "solo_ack", to: "orchestrator" };
	if ((AGENTS_BY_PATTERN[pattern] ?? []).includes(msg.to)) return { action: "deliver", to: msg.to };
	return { action: "drop" };
}
