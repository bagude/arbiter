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
test("rejects when a completed worker has no report — after no_probe and no_src, before stale", () => {
	const r = decideApproval({ ...base, unreported: ["worker:a"] });
	assert.equal(r.reason, "unreported");
	assert.deepEqual(r.unreported, ["worker:a"]);
	assert.equal(decideApproval({ ...base, lastProbeHash: null, unreported: ["worker:a"] }).reason, "no_probe");
	assert.equal(decideApproval({ ...base, srcExists: false, unreported: ["worker:a"] }).reason, "no_src");
	assert.equal(decideApproval({ ...base, currentHash: "h2", unreported: ["worker:a"] }).reason, "unreported");
	assert.equal(decideApproval({ ...base, lastEditTs: 50_000, unreported: [] }).ok, true);
	assert.equal(decideApproval({ ...base, lastEditTs: 50_000 }).ok, true, "default is an empty list");
});
