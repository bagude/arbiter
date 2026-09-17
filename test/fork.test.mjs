import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateSessionEntries, truncateEntriesAt, rewriteSessionHeader, forkCounters, payloadEquals, forkSpec } from "../lib/fork.mjs";
import { readSessionFile } from "../lib/context-trace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "run-trace", "sessions", "orchestrator", "2026-09-15T04-19-13-843Z_01a0a34a-5932-73db-aba5-dad81622d78a.jsonl");
const WORKER_FIXTURE = path.join(here, "fixtures", "run-trace", "sessions", "orchestrator", "2026-09-15T04-19-13-843Z_01a0a34a-5932-73db-aba5-dad81622d78a", "tasks", "2026-09-15T04-22-16-260Z_01a0a34d-21c4-73db-aba5-dadced313919.jsonl");

test("truncateSessionEntries keeps the header and everything before the call-th assistant entry", () => {
	const entries = readSessionFile(FIXTURE);
	const assistants = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
	assert.equal(assistants.length, 29);
	const { entries: kept, cut } = truncateSessionEntries(entries, 4);
	assert.equal(kept[0].type, "session");
	assert.equal(kept.filter((e) => e.type === "message" && e.message.role === "assistant").length, 3);
	assert.equal(entries[cut].message.role, "assistant", "the first dropped entry is the 4th assistant message");
	assert.notEqual(kept.at(-1).message?.role, "assistant", "the leaf is a user or tool-result message, which Agent.continue() accepts");
	assert.deepEqual(truncateSessionEntries(entries, 1).entries.filter((e) => e.type === "message").map((e) => e.message.role), ["user"]);
	assert.throws(() => truncateSessionEntries(entries, 30), /only 29 assistant/);
});

// An inherited worker transcript is cut at the fork INSTANT, not at an entry count: the
// source run kept appending to it, and pi-subagents resumes a worker by appending to that
// very file, so an untruncated one would resume from the source run's final state.
test("truncateEntriesAt keeps the header and stops at the first entry past the instant", () => {
	const entries = readSessionFile(WORKER_FIXTURE);
	assert.equal(entries.length, 25);
	assert.ok(
		entries.every((e) => Number.isFinite(Date.parse(e.timestamp))),
		"every pi session entry carries an ISO timestamp; this function depends on it",
	);
	// Cut exactly on entry 11's own timestamp: `<=` keeps it, entry 12 is the first past.
	const cut = Date.parse("2026-09-15T04:25:17.898Z");
	const kept = truncateEntriesAt(entries, cut);
	assert.equal(kept.length, 12);
	assert.equal(kept[0].type, "session", "the header is kept");
	assert.deepEqual(kept, entries.slice(0, 12), "the kept entries are the file's own, in order");
	assert.ok(kept.every((e) => Date.parse(e.timestamp) <= cut), "nothing recorded after the instant survives");
	// An instant past the whole file keeps it whole; one before the first body entry keeps
	// only the header.
	assert.equal(truncateEntriesAt(entries, Date.parse("2027-01-01T00:00:00.000Z")).length, 25);
	assert.deepEqual(truncateEntriesAt(entries, 0), [entries[0]]);
	assert.deepEqual(truncateEntriesAt([], 1), []);
	// An entry with no usable timestamp is kept only while no earlier entry has passed the
	// instant: the scan stops at the first entry past, and never resumes.
	const mixed = [
		{ type: "session", timestamp: "2026-09-15T04:00:00.000Z" },
		{ type: "model_change" }, // no timestamp, before the cut — kept
		{ type: "message", timestamp: "2026-09-15T04:10:00.000Z" },
		{ type: "message", timestamp: "2026-09-15T04:30:00.000Z" }, // first past the cut — stops here
		{ type: "message" }, // no timestamp, but after the stop — dropped
		{ type: "message", timestamp: "2026-09-15T04:11:00.000Z" }, // out of order, still dropped
	];
	assert.deepEqual(truncateEntriesAt(mixed, Date.parse("2026-09-15T04:20:00.000Z")), mixed.slice(0, 3));
	// message entries also carry an epoch-ms timestamp on message.timestamp; a numeric
	// top-level timestamp is read as epoch ms rather than parsed as a date string.
	assert.deepEqual(truncateEntriesAt([{ type: "session" }, { type: "message", timestamp: 5 }, { type: "message", timestamp: 50 }], 10).length, 2);
});

test("rewriteSessionHeader replaces cwd and keeps the rest of the header", () => {
	const entries = readSessionFile(FIXTURE);
	const out = rewriteSessionHeader(entries, { cwd: "C:/fork/ws-builder" });
	assert.equal(out[0].cwd, "C:/fork/ws-builder");
	assert.equal(out[0].id, entries[0].id);
	assert.equal(out[0].type, "session");
	assert.notEqual(out[0], entries[0], "the original header object is not mutated");
	assert.equal(out.length, entries.length);
});

test("forkCounters reads the harness state at the decision point and counts the mails sent before it", () => {
	const pts = [
		{ i: 0, action: { cls: "inspect" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 1, action: { cls: "spawn" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 2, action: { cls: "probe" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 3, action: { cls: "memory" }, state: { probes: 1, doneAttempts: 0, pendingProbe: true } },
		{ i: 4, action: { cls: "resume" }, state: { probes: 1, doneAttempts: 0, pendingProbe: false } },
	];
	assert.deepEqual(forkCounters(pts, 5), { probeCount: 1, doneAttempts: 0, pendingProbe: false, mailCount: 2 });
	assert.deepEqual(forkCounters(pts, 1), { probeCount: 0, doneAttempts: 0, pendingProbe: false, mailCount: 0 });
	assert.throws(() => forkCounters(pts, 6), /no decision point/);
});

test("payloadEquals compares messages deeply and tool names, and names the first difference", () => {
	const a = { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: [{ type: "function", function: { name: "read" } }] };
	assert.deepEqual(payloadEquals(a, JSON.parse(JSON.stringify(a))), { equal: true, firstDiff: null });
	const b = { ...a, messages: [a.messages[0], { role: "user", content: "U2" }] };
	assert.deepEqual(payloadEquals(a, b), { equal: false, firstDiff: { index: 1, field: "content" } });
	const c = { ...a, tools: [] };
	assert.deepEqual(payloadEquals(a, c), { equal: false, firstDiff: "tools" });
	const d = { ...a, messages: a.messages.slice(0, 1) };
	assert.deepEqual(payloadEquals(a, d), { equal: false, firstDiff: { index: 1, field: "missing" } });
});

test("forkSpec parses ARBITER_FORK and validates it", () => {
	assert.equal(forkSpec({}), null);
	assert.deepEqual(forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 5, branch: "G" }) }), { run: "r", call: 5, branch: "G", action: null, tool: null, args: null, replicate: 1 });
	const oracle = forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 5, branch: "A-oracle", action: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" }, replicate: 2 }) });
	assert.equal(oracle.replicate, 2);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 0, branch: "G" }) }), /call/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "B" }) }), /branch/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "A-natural" }) }), /action/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "A-oracle", action: "probe" }) }), /tool/);
});
