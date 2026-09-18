// triggers — when the harness stops and asks the manager (spec §4), and whether the
// orchestrator waits while it decides.
//
// Pure on purpose: the supervisor assembles the state it already keeps (failed done attempts,
// cap fractions, the run's ending, an escalate mail) and this decides. Nothing here reads a
// file, so §4's table is testable without a run.
//
// "Paused" is only ever true for the two triggers where the orchestrator is already blocked on
// a delivery the supervisor owes it — the withheld failed verdict, and the reply to its own
// escalate mail. Everywhere else the run is finished or carries on, and holding a delivery
// would stall work for nothing.

export const PAUSING = new Set(["oracle_failed_repeatedly", "escalation"]);

export const DEFAULT_FAIL_THRESHOLD = 2;
export const DEFAULT_BUDGET_FRACTION = 0.75;

const trigger = (kind) => ({ kind, pauses: PAUSING.has(kind) });

/**
 * The first matching trigger in §4's table order, or null.
 *
 * @param {object} state
 * @param {boolean} [state.oraclePassed]           the active milestone's oracle passed
 * @param {number}  [state.oracleFails]            failed done attempts on this milestone
 * @param {number}  [state.failThreshold]          N (config, default 2)
 * @param {number}  [state.capsUsedFraction]       the largest fraction of any cap used
 * @param {number}  [state.budgetFraction]         the fraction that fires it (default 0.75)
 * @param {boolean} [state.budgetThresholdFired]   already fired once this run
 * @param {boolean} [state.escalateMail]           the orchestrator sent kind="escalate"
 * @param {{reason: string, accepted: boolean}} [state.runEnded]
 * @param {boolean} [state.comparisonReady]        a compare batch finished
 */
export function decideTrigger(state = {}) {
	if (state.oraclePassed) return trigger("milestone_candidate");

	const fails = Number(state.oracleFails ?? 0);
	const threshold = Number(state.failThreshold ?? DEFAULT_FAIL_THRESHOLD);
	if (fails > 0 && fails >= threshold) return trigger("oracle_failed_repeatedly");

	// Once per run: the second crossing of the same line tells the manager nothing new, and
	// the run is not paused for it, so a repeat would be a packet nobody asked for.
	if (!state.budgetThresholdFired && Number(state.capsUsedFraction ?? 0) >= Number(state.budgetFraction ?? DEFAULT_BUDGET_FRACTION)) return trigger("budget_threshold");

	if (state.escalateMail) return trigger("escalation");

	if (state.runEnded && !state.runEnded.accepted) return trigger("run_ended_without_acceptance");

	if (state.comparisonReady) return trigger("comparison_ready");

	return null;
}
