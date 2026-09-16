import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendManifest, readManifest, manifestJoin } from "../lib/worker-manifest.mjs";

function tmpRunDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-manifest-"));
}

test("appendManifest then readManifest round-trips records with ts numbers", () => {
	const dir = tmpRunDir();
	appendManifest(dir, { ts: 111, ev: "created", wid: "worker:a1", description: "do the thing", background: false });
	appendManifest(dir, { ts: 222, ev: "bound", wid: "worker:a1", sessionId: "sess-a1", transcriptPath: "sessions/orchestrator/2026/tasks/sess-a1.jsonl" });
	const records = readManifest(dir);
	assert.equal(records.length, 2);
	assert.deepEqual(records[0], { ts: 111, ev: "created", wid: "worker:a1", description: "do the thing", background: false });
	assert.deepEqual(records[1], { ts: 222, ev: "bound", wid: "worker:a1", sessionId: "sess-a1", transcriptPath: "sessions/orchestrator/2026/tasks/sess-a1.jsonl" });
});

test("appendManifest defaults ts to Date.now() when omitted", () => {
	const dir = tmpRunDir();
	const before = Date.now();
	appendManifest(dir, { ev: "resuming", wid: "worker:a1" });
	const after = Date.now();
	const [record] = readManifest(dir);
	assert.ok(record.ts >= before && record.ts <= after);
	assert.equal(record.ev, "resuming");
});

test("appendManifest creates the run directory if it does not exist", () => {
	const dir = path.join(tmpRunDir(), "nested", "run-dir");
	appendManifest(dir, { ts: 1, ev: "created", wid: "worker:a1", description: "x", background: false });
	assert.deepEqual(readManifest(dir), [{ ts: 1, ev: "created", wid: "worker:a1", description: "x", background: false }]);
});

test("readManifest skips malformed lines", () => {
	const dir = tmpRunDir();
	fs.writeFileSync(path.join(dir, "workers.jsonl"), '{"ts":1,"ev":"created","wid":"worker:a1"}\nnot json\n{"ts":2,"ev":"resuming","wid":"worker:a1"}\n');
	const records = readManifest(dir);
	assert.deepEqual(records, [
		{ ts: 1, ev: "created", wid: "worker:a1" },
		{ ts: 2, ev: "resuming", wid: "worker:a1" },
	]);
});

test("readManifest on a dir without the file returns []", () => {
	const dir = tmpRunDir();
	assert.deepEqual(readManifest(dir), []);
});

test("manifestJoin folds created + bound + completed for one wid into one row", () => {
	const records = [
		{ ts: 100, ev: "created", wid: "worker:a1", description: "do the thing", background: false },
		{ ts: 150, ev: "bound", wid: "worker:a1", sessionId: "sess-a1", transcriptPath: "sessions/orchestrator/x/tasks/sess-a1.jsonl" },
		{ ts: 400, ev: "completed", wid: "worker:a1", status: "completed" },
	];
	const rows = manifestJoin(records);
	assert.equal(rows.size, 1);
	assert.deepEqual(rows.get("worker:a1"), {
		wid: "worker:a1",
		description: "do the thing",
		background: false,
		sessionId: "sess-a1",
		transcriptPath: "sessions/orchestrator/x/tasks/sess-a1.jsonl",
		createdTs: 100,
		boundTs: 150,
		endedTs: 400,
		status: "completed",
	});
});

test("manifestJoin gives a wid with only created a null sessionId and status running", () => {
	const rows = manifestJoin([{ ts: 100, ev: "created", wid: "worker:a2", description: "solo", background: true }]);
	assert.deepEqual(rows.get("worker:a2"), {
		wid: "worker:a2",
		description: "solo",
		background: true,
		sessionId: null,
		transcriptPath: null,
		createdTs: 100,
		boundTs: null,
		endedTs: null,
		status: "running",
	});
});

test("manifestJoin: resuming after completed sets status back to running", () => {
	const rows = manifestJoin([
		{ ts: 100, ev: "created", wid: "worker:a3", description: "loop", background: false },
		{ ts: 200, ev: "completed", wid: "worker:a3", status: "completed" },
		{ ts: 300, ev: "resuming", wid: "worker:a3" },
	]);
	assert.equal(rows.get("worker:a3").status, "running");
});

test("manifestJoin: status becomes the last of completed/failed/resumed seen", () => {
	const rows = manifestJoin([
		{ ts: 100, ev: "created", wid: "worker:a4", description: "flaky", background: false },
		{ ts: 200, ev: "failed", wid: "worker:a4", status: "failed" },
		{ ts: 300, ev: "resuming", wid: "worker:a4" },
		{ ts: 400, ev: "resumed", wid: "worker:a4", status: "resumed" },
	]);
	assert.equal(rows.get("worker:a4").status, "resumed");
	assert.equal(rows.get("worker:a4").endedTs, 400);
});
