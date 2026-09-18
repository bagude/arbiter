import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLedger, readLedger, findByKey, appendFinding, readFindings, settleFinding } from "../lib/manage/ledger.mjs";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));

test("appendLedger numbers rows, stamps ts, and findByKey finds an executed idempotency key", () => {
	const dir = mk();
	const a = appendLedger(dir, { packetId: 1, stateVersion: 3, trigger: "run_ended", instruction: { idempotencyKey: "p1-v3", verb: "continue" }, verified: true });
	const b = appendLedger(dir, { packetId: 2, stateVersion: 4, trigger: "budget_threshold", instruction: { idempotencyKey: "p2-v4", verb: "correct" }, verified: true });
	assert.deepEqual([a.seq, b.seq], [1, 2]);
	assert.ok(a.ts <= b.ts);
	assert.equal(readLedger(dir).length, 2);
	assert.equal(findByKey(dir, "p2-v4").seq, 2);
	assert.equal(findByKey(dir, "nope"), null);
});

// Only an execution can be duplicated. A refusal under a key must leave that key usable, or the
// manager can never correct the instruction the harness just told it was wrong — it would get
// "already executed" about something that never ran.
test("findByKey ignores refusal rows by default, and sees them when asked", () => {
	const dir = mk();
	appendLedger(dir, { packetId: 3, instruction: { idempotencyKey: "p3-v9", verb: "correct" }, verified: false, refused: "precondition" });
	assert.equal(findByKey(dir, "p3-v9"), null, "a refused key is free to be retried");
	assert.equal(findByKey(dir, "p3-v9", { executedOnly: false }).refused, "precondition", "the audit question still has an answer");
	// Once the corrected instruction runs under that key, the key IS taken.
	appendLedger(dir, { packetId: 3, instruction: { idempotencyKey: "p3-v9", verb: "correct" }, verified: true });
	assert.equal(findByKey(dir, "p3-v9").verified, true);
});

test("findings are claims with a settlement criterion; settleFinding updates status and verifiedOn", () => {
	const dir = mk();
	const f = appendFinding(dir, { id: "f1", scope: "harness:pathnorm", claim: "skipping ls at p≥.95 changes nothing", settlement_criterion: "same on a second run", evidence: ["docs/batch/x.md"] });
	assert.equal(f.status, "candidate");
	settleFinding(dir, "f1", { status: "verified", verifiedOn: ["run-a", "run-b"] });
	const [g] = readFindings(dir);
	assert.equal(g.status, "verified");
	assert.deepEqual(g.verifiedOn, ["run-a", "run-b"]);
	assert.throws(() => appendFinding(dir, { id: "f2", claim: "no criterion" }), /settlement_criterion/);
});
