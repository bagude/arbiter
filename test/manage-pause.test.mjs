import { test } from "node:test";
import assert from "node:assert/strict";
import { createPause, suppressWhilePaused, classifyDelivery, DEFAULT_TIMEOUT_MS } from "../lib/manage/pause.mjs";

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

// An allow-list, so a delivery site added later defaults to being held. The deny-list version
// of this rule named the two nudges and was outflanked on the very next live run by a memory
// receipt — a label nobody had thought to name.
test("only the release and the compaction path may reach a paused orchestrator", () => {
	for (const why of ["oracle verdict", "manager correction", "escalation answered", "escalation defaulted", "compaction done", "compaction done (queued during compaction)", "checkpoint request"]) {
		assert.equal(suppressWhilePaused(why), false, `${why} must still go through`);
	}
	// Every other label deliver() is called with today. Each is a prompt, and a prompt is a turn
	// the orchestrator should not have while waiting for an answer it was promised.
	for (const why of [
		"silent turn (text but no tool call)",
		"idle nudge 1",
		"memory candidate recorded",
		"ack (no counterpart)",
		"probe results",
		"auto-probe results (tester)",
		"probe bounced",
		"probe error",
		"probe crash",
		"probe unsupported",
		"probe body unparseable",
		"probe fully blocked (all repeats)",
		"jev done hold",
		"kickoff",
		"mail #7 from orchestrator",
	]) {
		assert.equal(suppressWhilePaused(why), true, `${why} must be held while a decision is owed`);
	}
	// A label nobody has invented yet is held by default. That inversion is the whole fix.
	assert.equal(suppressWhilePaused("some new delivery site"), true);
	assert.equal(suppressWhilePaused(undefined), true);
	// Anchored: a longer label that merely begins with an allowed one is not allowed by accident.
	assert.equal(suppressWhilePaused("oracle verdict (stale)"), true);
});

// Held is not one thing. The orchestrator is never told it is paused, so an answer to its own
// call must arrive late rather than never — dropping a probe it paid for out of its own budget
// would change its next decision for a reason belonging to the harness, not the experiment.
// A nudge is the harness's own prompt and is stale the moment the real answer lands.
test("a held delivery is queued when it is a reply, dropped when it is a nudge", () => {
	for (const why of ["probe results", "probe error", "auto-probe results (tester)", "memory candidate recorded", "ack (no counterpart)", "jev done hold", "mail #7 from orchestrator"]) {
		assert.equal(classifyDelivery(why), "queue", `${why} is an answer the orchestrator asked for`);
	}
	for (const why of ["silent turn (text but no tool call)", "idle nudge 1", "kickoff", "some new delivery site", undefined]) {
		assert.equal(classifyDelivery(why), "drop", `${why} is not a reply to anything`);
	}
	for (const why of ["oracle verdict", "manager correction", "compaction done", "checkpoint request"]) {
		assert.equal(classifyDelivery(why), "allow");
	}
});

test("queued replies flush in order right after the released verdict; nudges never come back", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("oracle_failed_repeatedly", T0, held);

	assert.deepEqual(p.hold({ to: "orchestrator", text: "probe #1 says 25/25", why: "probe results" }), { action: "queue" });
	assert.deepEqual(p.hold({ to: "orchestrator", text: "nudge", why: "silent turn (text but no tool call)" }), { action: "drop" });
	assert.deepEqual(p.hold({ to: "orchestrator", text: "recorded", why: "memory candidate recorded" }), { action: "queue" });
	assert.deepEqual(p.hold({ to: "orchestrator", text: "idle", why: "idle nudge 1" }), { action: "drop" });
	assert.equal(p.queued().length, 2, "only the replies are kept");

	const r = p.tick(T0 + 1000);
	assert.deepEqual(
		r.deliver.map((d) => d.kind),
		["release", "queued", "queued"],
		"the verdict first, then the held replies — the sequence the orchestrator would have seen unpaused",
	);
	assert.deepEqual(
		r.deliver.slice(1).map((d) => d.item.why),
		["probe results", "memory candidate recorded"],
		"in the order they were produced",
	);
	assert.equal(r.deliver[1].item.to, "orchestrator", "each carries its own recipient and text");
	assert.equal(r.deliver[1].item.text, "probe #1 says 25/25");
	assert.match(r.log.join(" "), /flushing 2 reply/);
	// The queue belongs to the pause that held it: nothing is left for the next one.
	assert.deepEqual(p.queued(), []);
	assert.deepEqual(p.tick(T0 + 99_999).deliver, []);
});

test("a decision flushes the queue too, and a pause with nothing held says nothing about it", () => {
	const p = createPause({ timeoutMs: 1000 });
	p.open("escalation", T0, held);
	p.hold({ to: "orchestrator", text: "probe", why: "probe results" });
	const r = p.onControl({ type: "decision", packetId: 7, verb: "continue" }, T0 + 5);
	assert.deepEqual(r.deliver.map((d) => d.kind), ["release", "queued"]);

	const quiet = createPause({ timeoutMs: 1000 });
	quiet.open("escalation", T0, held);
	const q = quiet.tick(T0 + 1000);
	assert.deepEqual(q.deliver.map((d) => d.kind), ["release"]);
	assert.ok(!q.log.join(" ").includes("flushing"), "no flush line when nothing was held");
});

test("hold() with no pause open always says allow — the guard is the caller's, the rule is ours", () => {
	const p = createPause({ timeoutMs: 1000 });
	assert.deepEqual(p.hold({ to: "orchestrator", text: "x", why: "probe results" }), { action: "allow" });
	assert.deepEqual(p.hold({ to: "orchestrator", text: "x", why: "idle nudge 1" }), { action: "allow" });
	assert.deepEqual(p.queued(), []);
});
