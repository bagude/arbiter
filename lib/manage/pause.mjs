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
 * Deliveries that MAY reach the orchestrator while a decision is owed, keyed by the `why` label
 * the supervisor already passes to deliver(). Everything else is held.
 *
 * An allow-list, not a deny-list, and the second live check is the reason. The first version
 * named the two nudges to suppress; what reached the orchestrator mid-pause next was a memory
 * acknowledgement — a label nobody had thought to name, which is precisely what a deny-list
 * cannot cover. Every delivery is a prompt, and a prompt is a turn: the orchestrator answered
 * that receipt by re-sending `done` ("re-send after memory receipt"), which ran the oracle a
 * second time on the tree already sitting in front of the manager. A delivery site added later
 * must default to being held and showing up in the audit as held, rather than silently handing
 * a blocked agent something to do.
 *
 * What is allowed, and why each one:
 *   - the oracle verdict and the manager's correction — releasing them IS the point; by then
 *     the pause has already closed, so allowing them here is belt and braces;
 *   - the escalation acknowledgements, which are the release of an escalation pause;
 *   - compaction and its checkpoint request, which answer something the orchestrator is waiting
 *     on inside pi itself. A held checkpoint request would stall the compaction machinery on a
 *     checkpoint never asked for, and compaction moves no work forward on its own.
 */
export const ALLOWED_WHILE_PAUSED = [/^oracle verdict$/, /^manager correction$/, /^escalation (answered|defaulted)$/, /^compaction /, /^checkpoint request$/];

/**
 * Held deliveries that are REPLIES to something the orchestrator itself asked for. These are
 * queued and delivered right after the release, in the order they were produced — never
 * dropped.
 *
 * The distinction matters because the orchestrator is not told it is paused. A probe is work it
 * paid for out of its own budget: dropping the answer would change its next decision for a
 * reason that belongs to the harness rather than to the experiment, and it would have no way to
 * know that is what happened. A nudge is the opposite — the harness's own prompt to an agent
 * that stopped, which is stale the moment the real answer arrives, so a nudge is dropped.
 */
export const QUEUED_WHILE_PAUSED = [/^probe /, /^auto-probe /, /^memory candidate recorded$/, /^ack /, /^jev done hold$/, /^mail #/];

/** What to do with a delivery attempted while a decision is owed. */
export function classifyDelivery(why) {
	const label = String(why ?? "");
	if (ALLOWED_WHILE_PAUSED.some((re) => re.test(label))) return "allow";
	if (QUEUED_WHILE_PAUSED.some((re) => re.test(label))) return "queue";
	return "drop";
}

/** True when this delivery must not go out now because a manager decision is owed. */
export function suppressWhilePaused(why) {
	return classifyDelivery(why) !== "allow";
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
	let open = null; // { kind, deadline, correction, payload, queued: [] }

	return {
		timeoutMs: limit,
		isOpen: () => open !== null,
		kind: () => open?.kind ?? null,
		deadline: () => open?.deadline ?? null,
		correction: () => open?.correction ?? null,
		queued: () => (open ? [...open.queued] : []),

		/**
		 * Offers a delivery attempted while a decision is owed. Returns what the caller should
		 * do with it: "allow" it now, "queue" it for the release, or "drop" it.
		 *
		 * A queued item is the orchestrator's own answer coming back — it never learns it was
		 * paused, so an answer it paid for must arrive late rather than never.
		 */
		hold(item) {
			const action = classifyDelivery(item?.why);
			if (!open || action === "allow") return { action: "allow" };
			if (action === "queue") open.queued.push(item);
			return { action };
		},

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
			open = { kind, deadline: now + limit, correction: null, payload, queued: [] };
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
			// The held delivery first, then the replies that piled up behind it, in the order
			// they were produced: the orchestrator reads the answer it was waiting for and then
			// the answers to its own calls, which is the sequence it would have seen had the
			// harness never paused at all.
			deliver: [
				{ kind: "release", payload: held.payload, correction: held.correction, defaulted },
				...held.queued.map((item) => ({ kind: "queued", item })),
			],
			grant: null,
			released: true,
			defaulted,
			kind: held.kind,
			payload: held.payload,
			log: [...log, `releasing the held ${held.kind} delivery (${why})`, ...(held.queued.length ? [`flushing ${held.queued.length} reply(ies) held during the pause`] : [])],
		};
	}
}
