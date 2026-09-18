import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrigger, PAUSING, DEFAULT_FAIL_THRESHOLD, DEFAULT_BUDGET_FRACTION } from "../lib/manage/triggers.mjs";

test("nothing happening is not a trigger", () => {
	assert.equal(decideTrigger({}), null);
	assert.equal(decideTrigger({ oracleFails: 0, capsUsedFraction: 0.1 }), null);
});

test("a passing oracle for the active milestone is a milestone candidate, and nothing is paused", () => {
	assert.deepEqual(decideTrigger({ oraclePassed: true }), { kind: "milestone_candidate", pauses: false });
});

test("N failed done attempts pauses the run; N defaults to 2 and comes from config", () => {
	assert.equal(DEFAULT_FAIL_THRESHOLD, 2);
	assert.equal(decideTrigger({ oracleFails: 1 }), null);
	assert.deepEqual(decideTrigger({ oracleFails: 2 }), { kind: "oracle_failed_repeatedly", pauses: true });
	assert.deepEqual(decideTrigger({ oracleFails: 1, failThreshold: 1 }), { kind: "oracle_failed_repeatedly", pauses: true });
	assert.equal(decideTrigger({ oracleFails: 2, failThreshold: 3 }), null);
});

test("crossing a fraction of any cap fires once and does not pause", () => {
	assert.equal(DEFAULT_BUDGET_FRACTION, 0.75);
	assert.deepEqual(decideTrigger({ capsUsedFraction: 0.75 }), { kind: "budget_threshold", pauses: false });
	assert.equal(decideTrigger({ capsUsedFraction: 0.74 }), null);
	assert.equal(decideTrigger({ capsUsedFraction: 0.9, budgetThresholdFired: true }), null, "once per run");
	assert.equal(decideTrigger({ capsUsedFraction: 0.8, budgetFraction: 0.9 }), null);
});

test("an escalate mail pauses at the mail", () => {
	assert.deepEqual(decideTrigger({ escalateMail: true }), { kind: "escalation", pauses: true });
});

test("a run that ended without acceptance triggers but cannot pause — there is nobody left to wait", () => {
	assert.deepEqual(decideTrigger({ runEnded: { reason: "CAP: wall 900s >= 900s", accepted: false } }), { kind: "run_ended_without_acceptance", pauses: false });
	assert.equal(decideTrigger({ runEnded: { reason: "SUCCESS: oracle passed", accepted: true } }), null);
});

test("a finished compare batch is comparison_ready", () => {
	assert.deepEqual(decideTrigger({ comparisonReady: true }), { kind: "comparison_ready", pauses: false });
});

test("the first match in the spec's table order wins", () => {
	// Every condition true at once: milestone_candidate heads the table.
	const all = { oraclePassed: true, oracleFails: 5, capsUsedFraction: 1, escalateMail: true, runEnded: { reason: "x", accepted: false }, comparisonReady: true };
	assert.equal(decideTrigger(all).kind, "milestone_candidate");
	assert.equal(decideTrigger({ ...all, oraclePassed: false }).kind, "oracle_failed_repeatedly");
	assert.equal(decideTrigger({ ...all, oraclePassed: false, oracleFails: 0 }).kind, "budget_threshold");
	assert.equal(decideTrigger({ ...all, oraclePassed: false, oracleFails: 0, budgetThresholdFired: true }).kind, "escalation");
	assert.equal(decideTrigger({ ...all, oraclePassed: false, oracleFails: 0, budgetThresholdFired: true, escalateMail: false }).kind, "run_ended_without_acceptance");
});

test("exactly two triggers pause: the withheld verdict and the escalate mail", () => {
	assert.deepEqual([...PAUSING].sort(), ["escalation", "oracle_failed_repeatedly"]);
});
