import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval } from "../lib/gate.mjs";

const base = { lastProbeHash: "h1", currentHash: "h1", srcExists: true, lastEditTs: 0, now: 100_000, quiescenceMs: 15_000 };

test("rejects when no probe has ever run", () => {
	assert.deepEqual(decideApproval({ ...base, lastProbeHash: null }).reason, "no_probe");
});
test("rejects when src is gone", () => {
	assert.equal(decideApproval({ ...base, srcExists: false }).reason, "no_src");
});
test("rejects when the tree changed since the probe", () => {
	assert.equal(decideApproval({ ...base, currentHash: "h2" }).reason, "stale");
});
test("rejects when an edit is too recent", () => {
	const r = decideApproval({ ...base, lastEditTs: 95_000 });
	assert.equal(r.reason, "too_soon");
	assert.equal(r.sinceEditMs, 5_000);
});
test("accepts when probed, unchanged and quiet", () => {
	const r = decideApproval({ ...base, lastEditTs: 50_000 });
	assert.equal(r.ok, true);
	assert.equal(r.reason, null);
});
test("checks are ordered: no_probe wins over stale", () => {
	assert.equal(decideApproval({ ...base, lastProbeHash: null, currentHash: "zzz" }).reason, "no_probe");
});
