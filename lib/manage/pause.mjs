// pause — the state machine behind "the orchestrator waits while the manager decides" (spec §4).
//
// Pure and self-contained: no files, no timers, no supervisor. It is told when a trigger opens a
// pause, what arrives on the control channel, and what time it is; it answers with the actions
// the caller should perform. The supervisor's manageTrigger/pumpControl/releasePause are thin
// adapters over this, so the rules can be tested without starting a run — which matters because
// the live check is expensive and, on its first attempt, never reached the deadline at all.
//
// One pause at a time, deliberately: the manager has one packet open, and stacking held
// deliveries would mean the orchestrator gets two answers to one question.

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Deliveries that must NOT reach the orchestrator while a decision is owed, keyed by the `why`
 * label the supervisor already passes to deliver().
 *
 * Both are nudges that exist to un-stick an agent that has stopped on its own. During a pause
 * the agent has stopped because the harness is holding its answer, so a nudge is the harness
 * prodding a model to work around the harness: the live run took the silent-turn nudge inside
 * the pause window at 35.8 s, and the idle nudge would have told a settled orchestrator to send
 * `done` — burning a done attempt on the very question the manager was being asked about.
 *
 * Everything else still goes: an oracle verdict IS the held delivery, a manager correction is
 * the point of the pause, and compaction messages answer something the orchestrator is waiting
 * on inside pi itself.
 */
export const SUPPRESSED_WHILE_PAUSED = [/^silent turn/, /^idle nudge/];

export function suppressWhilePaused(why) {
	return SUPPRESSED_WHILE_PAUSED.some((re) => re.test(String(why ?? "")));
}

/** Every action set has the same shape, so a caller can handle one branch and ignore the rest. */
const NOTHING = () => ({ deliver: [], grant: null, released: false, defaulted: false, kind: null, payload: null, log: [] });

/**
 * @param {object} opts
 * @param {number} [opts.timeoutMs] the decision timeout; a non-positive, absent or unparseable
 *   value falls back to 120 000, because a NaN deadline compares false against every clock and
 *   would hold the run for ever — the exact failure mode a slow manager is supposed to degrade
 *   away from.
 */
export function createPause({ timeoutMs } = {}) {
	const asked = Number(timeoutMs);
	const limit = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TIMEOUT_MS;
	let open = null; // { kind, deadline, correction, payload }

	return {
		timeoutMs: limit,
		isOpen: () => open !== null,
		kind: () => open?.kind ?? null,
		deadline: () => open?.deadline ?? null,
		correction: () => open?.correction ?? null,

		/**
		 * Opens a pause for `kind`, holding `payload` (opaque here — the supervisor keeps its
		 * delivery thunk in it). A second open while one is already held is refused and logged:
		 * the caller delivers instead of holding.
		 */
		open(kind, now = Date.now(), payload = null) {
			const out = NOTHING();
			if (open) {
				out.log.push(`${kind} arrived while a ${open.kind} decision is still owed; not paused again`);
				return { ...out, opened: false };
			}
			open = { kind, deadline: now + limit, correction: null, payload };
			return { ...out, opened: true, kind, log: [`paused on ${kind}; a decision is owed within ${limit}ms`] };
		},

		/** One control-channel entry: grant, correct, decision, or anything else. */
		onControl(entry, now = Date.now()) {
			const out = NOTHING();
			const type = entry?.type;
			if (type === "grant") {
				out.grant = { wallSec: Number(entry.wallSec ?? 0), toolCalls: Number(entry.toolCalls ?? 0) };
				out.log.push(`grant from packet ${entry.packetId}: +${out.grant.wallSec}s wall, +${out.grant.toolCalls} tool calls`);
				return out;
			}
			if (type === "correct") {
				// Held back while a pause is open: the correction is meant to arrive WITH the
				// verdict the manager was answering, not a beat before it in its own turn. This
				// survives a split batch — the correction waits on the pause, not on the poll.
				if (open) {
					open.correction = entry.message;
					out.log.push(`correction from packet ${entry.packetId} held for the paused delivery`);
					return out;
				}
				out.deliver.push({ kind: "correction", message: entry.message });
				out.log.push(`correction from packet ${entry.packetId}`);
				return out;
			}
			if (type === "decision") {
				if (!open) return { ...out, log: [`decision on packet ${entry.packetId} (${entry.verb}) with no pause open`] };
				return release(`decision ${entry.verb}`, false, [`decision on packet ${entry.packetId}: ${entry.verb}`]);
			}
			return { ...out, log: [`control entry ignored: unknown type ${JSON.stringify(type)}`] };
		},

		/**
		 * The clock. At or past the deadline the held delivery is released exactly once and
		 * marked `defaulted` — spec §4's "the default instruction is continue with a zero
		 * grant", which is precisely "deliver what was held and carry on".
		 */
		tick(now = Date.now()) {
			if (!open || now < open.deadline) return NOTHING();
			return release("decision timeout", true, [`no decision within ${limit}ms — defaulting to continue with a zero grant`]);
		},
	};

	function release(why, defaulted, log) {
		const held = open;
		open = null;
		return {
			deliver: [{ kind: "release", payload: held.payload, correction: held.correction, defaulted }],
			grant: null,
			released: true,
			defaulted,
			kind: held.kind,
			payload: held.payload,
			log: [...log, `releasing the held ${held.kind} delivery (${why})`],
		};
	}
}
