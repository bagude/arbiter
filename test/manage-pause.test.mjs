import { test } from "node:test";
import assert from "node:assert/strict";
import { createPause, suppressWhilePaused, DEFAULT_TIMEOUT_MS } from "../lib/manage/pause.mjs";

const T0 = 1_000_000;
const held = { what: "the failed verdict" };

test("a pause opens once and reports itself open", () => {
	const p = createPause({ timeoutMs: 1000 });
	assert.equal(p.isOpen(), false);
	const r = p.open("oracle_failed_repeatedly", T0, held);
	assert.equal(r.opened, true);
	assert.equal(p.isOpen(), true);
	assert.equal(p.kind(), "oracle_failed_repeatedly");
	assert.equal(p.deadline(), T0 + 1000);
});

test("a tick before the deadline does nothing at all", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);
	for (const now of [T0, T0 + 1, T0 + 999]) {
		const r = p.tick(now);
		assert.deepEqual(r.deliver, [], `tick at +${now - T0} must not deliver`);
		assert.equal(r.released, false);
		assert.equal(p.isOpen(), true);
	}
});

// The failure the live check actually hit: the run sat paused past its own wall cap with
// nothing logged. Whatever else is true, the deadline must fire, and fire once.
test("a tick at or after the deadline defaults and releases exactly once", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);
	const r = p.tick(T0 + 1000);
	assert.equal(r.released, true);
	assert.equal(r.defaulted, true);
	assert.equal(r.kind, "oracle_failed_repeatedly");
	assert.deepEqual(r.deliver, [{ kind: "release", payload: held, correction: null, defaulted: true }]);
	assert.match(r.log.join(" "), /no decision within 1000ms/);
	assert.equal(p.isOpen(), false);
	// A later tick has nothing left to release.
	const again = p.tick(T0 + 999_999);
	assert.equal(again.released, false);
	assert.deepEqual(again.deliver, []);
});

test("a decision releases the pause, and is not a default", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("escalation", T0, held);
	const r = p.onControl({ type: "decision", packetId: 7, verb: "continue" }, T0 + 10);
	assert.equal(r.released, true);
	assert.equal(r.defaulted, false);
	assert.equal(r.deliver[0].payload, held);
	assert.equal(p.isOpen(), false);
	assert.match(r.log.join(" "), /decision on packet 7: continue/);
});

test("a correction while a pause is open travels with the release, never before it", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);
	const c = p.onControl({ type: "correct", packetId: 7, message: "the tester's suite is the gate" }, T0 + 5);
	assert.deepEqual(c.deliver, [], "nothing is delivered on its own while the pause is open");
	assert.equal(p.correction(), "the tester's suite is the gate");
	const r = p.onControl({ type: "decision", packetId: 7, verb: "correct" }, T0 + 6);
	assert.equal(r.deliver[0].correction, "the tester's suite is the gate");
	// Order within the release is the caller's to honour; the pause only guarantees they arrive
	// together. A correction that arrives in a LATER poll than its decision would be too late,
	// which is why the executor writes both before the decision entry.
});

test("a correction with no pause open is delivered at once", () => {
	const p = createPause({ timeoutMs: 1000 });
	const r = p.onControl({ type: "correct", packetId: 3, message: "hello" }, T0);
	assert.deepEqual(r.deliver, [{ kind: "correction", message: "hello" }]);
	assert.equal(r.released, false);
});

test("a grant is reported to the caller and never touches the pause", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);
	const r = p.onControl({ type: "grant", packetId: 7, wallSec: 300, toolCalls: 50 }, T0 + 1);
	assert.deepEqual(r.grant, { wallSec: 300, toolCalls: 50 });
	assert.equal(r.released, false);
	assert.equal(p.isOpen(), true, "a grant is not an answer to the question the pause asked");
});

test("a second open while one is held is logged, not re-opened, and the first payload survives", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);
	const second = p.open("escalation", T0 + 5, { what: "the escalation ack" });
	assert.equal(second.opened, false);
	assert.match(second.log.join(" "), /escalation arrived while a oracle_failed_repeatedly decision is still owed/);
	assert.equal(p.kind(), "oracle_failed_repeatedly");
	assert.equal(p.deadline(), T0 + 1000, "and the first pause's deadline is not extended");
	assert.equal(p.tick(T0 + 1000).deliver[0].payload, held);
});

test("a decision or a tick with no pause open is harmless", () => {
	const p = createPause({ timeoutMs: 1000 });
	assert.deepEqual(p.tick(T0 + 999_999).deliver, []);
	const r = p.onControl({ type: "decision", packetId: 1, verb: "continue" }, T0);
	assert.equal(r.released, false);
	assert.match(r.log.join(" "), /with no pause open/);
});

test("an unknown control entry is logged and ignored, never acted on", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("escalation", T0, held);
	const r = p.onControl({ type: "shutdown", packetId: 9 }, T0 + 1);
	assert.deepEqual(r.deliver, []);
	assert.equal(r.grant, null);
	assert.equal(p.isOpen(), true);
	assert.match(r.log.join(" "), /unknown type "shutdown"/);
});

// A NaN deadline compares false against every clock, so the pause would never default and the
// run would hold for ever — which is what "sat paused for 35 minutes" looks like from outside.
test("an absent, zero or unparseable timeout falls back to 120 000 ms", () => {
	assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
	for (const bad of [undefined, null, 0, -1, NaN, "", "soon", {}]) {
		const p = createPause({ timeoutMs: bad });
		assert.equal(p.timeoutMs, DEFAULT_TIMEOUT_MS, `timeoutMs ${JSON.stringify(bad)} must fall back`);
		p.open("escalation", T0, held);
		assert.equal(Number.isFinite(p.deadline()), true, "a deadline must be a real instant");
		assert.equal(p.tick(T0 + DEFAULT_TIMEOUT_MS).released, true);
	}
	// A configured timeout is honoured, including one from the env override the supervisor reads.
	assert.equal(createPause({ timeoutMs: 5000 }).timeoutMs, 5000);
	assert.equal(createPause({ timeoutMs: "30000" }).timeoutMs, 30000, "an env var arrives as a string");
});

test("nudges are suppressed while a decision is owed; real answers are not", () => {
	for (const why of ["silent turn (text but no tool call)", "idle nudge 1", "idle nudge 12"]) {
		assert.equal(suppressWhilePaused(why), true, `${why} must be held`);
	}
	for (const why of ["oracle verdict", "manager correction", "compaction done", "probe results", "checkpoint request", "jev done hold", "kickoff"]) {
		assert.equal(suppressWhilePaused(why), false, `${why} must still go through`);
	}
	assert.equal(suppressWhilePaused(undefined), false);
});
