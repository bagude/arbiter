import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendManifest, readManifest, manifestJoin, transcriptManifestPath } from "../lib/worker-manifest.mjs";

function tmpRunDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-manifest-"));
}

test("appendManifest then readManifest round-trips records with ts numbers", () => {
	const dir = tmpRunDir();
	const sessionsDir = path.join("C:", "r", "runs", ".sessions-2026");
	const transcriptPath = transcriptManifestPath(sessionsDir, path.join(sessionsDir, "orchestrator", "2026", "tasks", "sess-a1.jsonl"));
	appendManifest(dir, { ts: 111, ev: "created", wid: "worker:a1", description: "do the thing", background: false });
	appendManifest(dir, { ts: 222, ev: "bound", wid: "worker:a1", sessionId: "sess-a1", transcriptPath });
	const records = readManifest(dir);
	assert.equal(records.length, 2);
	assert.deepEqual(records[0], { ts: 111, ev: "created", wid: "worker:a1", description: "do the thing", background: false });
	assert.deepEqual(records[1], { ts: 222, ev: "bound", wid: "worker:a1", sessionId: "sess-a1", transcriptPath: "sessions/orchestrator/2026/tasks/sess-a1.jsonl" });
});

test("transcriptManifestPath: prefixes the sessions-relative path with 'sessions/' (Windows separators)", () => {
	const sessionsDir = "C:\\r\\runs\\.sessions-x";
	const p = "C:\\r\\runs\\.sessions-x\\orchestrator\\a\\tasks\\b.jsonl";
	assert.equal(transcriptManifestPath(sessionsDir, p), "sessions/orchestrator/a/tasks/b.jsonl");
});

test("transcriptManifestPath: POSIX-style paths", () => {
	const sessionsDir = "/r/runs/.sessions-x";
	const p = "/r/runs/.sessions-x/orchestrator/a/tasks/b.jsonl";
	assert.equal(transcriptManifestPath(sessionsDir, p), "sessions/orchestrator/a/tasks/b.jsonl");
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
		outcome: null,
		type: null,
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
		outcome: null,
		type: null,
	});
});

test("manifestJoin: a created record with a type folds to row.type; a row without one has type null", () => {
	const withType = manifestJoin([{ ts: 100, ev: "created", wid: "worker:t1", description: "do the thing", background: false, type: "tester" }]);
	assert.equal(withType.get("worker:t1").type, "tester");
	const withoutType = manifestJoin([{ ts: 100, ev: "created", wid: "worker:t2", description: "do the thing", background: false }]);
	assert.equal(withoutType.get("worker:t2").type, null);
});

test("manifestJoin: a started record (no created) sets description/background/type, same as created", () => {
	const rows = manifestJoin([{ ts: 100, ev: "started", wid: "worker:t3", description: "foreground spawn", background: false, type: "scout" }]);
	assert.deepEqual(rows.get("worker:t3"), {
		wid: "worker:t3",
		description: "foreground spawn",
		background: false,
		sessionId: null,
		transcriptPath: null,
		createdTs: 100,
		boundTs: null,
		endedTs: null,
		status: "running",
		outcome: null,
		type: "scout",
	});
});

test("manifestJoin: created then started (background dequeued) keeps the created description/background/createdTs, first-write-wins", () => {
	const rows = manifestJoin([
		{ ts: 100, ev: "created", wid: "worker:t4", description: "queued job", background: true, type: "tester" },
		{ ts: 300, ev: "started", wid: "worker:t4", description: "queued job", background: false, type: "tester" },
	]);
	const row = rows.get("worker:t4");
	assert.equal(row.background, true, "created's background wins over started's");
	assert.equal(row.createdTs, 100, "created's ts wins over started's");
	assert.equal(row.type, "tester");
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

test("manifestJoin: a resumed record with outcome error keeps status resumed but carries the real outcome", () => {
	const rows = manifestJoin([
		{ ts: 100, ev: "created", wid: "worker:a5", description: "errored resume", background: false },
		{ ts: 200, ev: "resumed", wid: "worker:a5", status: "resumed", outcome: "error" },
	]);
	assert.equal(rows.get("worker:a5").status, "resumed");
	assert.equal(rows.get("worker:a5").outcome, "error");
});
