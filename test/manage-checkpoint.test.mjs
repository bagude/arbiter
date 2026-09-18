import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { treeHash } from "../lib/tree-hash.mjs";
import { snapshotCheckpoint, promoteCandidate, nextCheckpointId, listCheckpoints, readManifest, workspaceHash, finalWorkspaceOf, isCandidateId, isCheckpointId } from "../lib/manage/checkpoint.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A workspace as a run leaves it: source the agent wrote, plus the `.pi` the host installed —
 * at the top level and nested, because the exclusion is by name at any depth. */
function mkWorkspace({ pi = true } = {}) {
	const dir = tmp("manage-ws-");
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "x.mjs"), "export const x = 1;\n");
	fs.writeFileSync(path.join(dir, "README.md"), "# ws\n");
	if (pi) {
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "agents", "worker.md"), "you are a worker\n");
		fs.mkdirSync(path.join(dir, "src", ".pi"), { recursive: true });
		fs.writeFileSync(path.join(dir, "src", ".pi", "scratch"), "nested\n");
	}
	return dir;
}

const mkTask = () => tmp("manage-ck-task-");

test("a snapshot copies the workspace, excludes .pi at every depth and records its hash", () => {
	const taskDir = mkTask();
	const ws = mkWorkspace();
	const ck = snapshotCheckpoint({ taskDir, fromDir: ws, runId: "2026-09-18T01-02-03", oracle: { attempt: 1, pass: 70, total: 70 } });

	assert.equal(ck.id, "ck-0001");
	assert.equal(fs.readFileSync(path.join(ck.dir, "src", "x.mjs"), "utf8"), "export const x = 1;\n");
	assert.equal(fs.existsSync(path.join(ck.dir, ".pi")), false, "the host's .pi must not be in a checkpoint");
	assert.equal(fs.existsSync(path.join(ck.dir, "src", ".pi")), false, "nor a nested one");

	const manifest = readManifest(taskDir, ck.id);
	assert.equal(manifest.id, "ck-0001");
	assert.equal(manifest.runId, "2026-09-18T01-02-03");
	assert.deepEqual(manifest.oracle, { attempt: 1, pass: 70, total: 70 });
	assert.equal(manifest.treeHash, ck.treeHash);
	assert.ok(manifest.createdAt > 0);
});

// The one property the evidence check depends on: hashing the SOURCE workspace with the skip
// predicate must equal the hash of the copy the cpSync filter made. Nothing else pins the filter
// and the predicate to each other, and if they drift every oracle: criterion fails as a mismatch.
test("workspaceHash of the source equals the checkpoint's recorded hash", () => {
	const taskDir = mkTask();
	const ws = mkWorkspace();
	const ck = snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r1" });
	assert.equal(workspaceHash(ws), ck.treeHash);
	// And the manifest itself is not part of what it describes.
	assert.equal(treeHash(ck.dir, (p) => path.basename(p) === "manifest.json"), ck.treeHash);
});

test("a workspace with no .pi hashes identically under treeHash and workspaceHash", () => {
	const ws = mkWorkspace({ pi: false });
	assert.equal(treeHash(ws), workspaceHash(ws), "the skip predicate must not change a tree it excludes nothing from");
});

test("checkpoint ids are the max on disk plus one, gaps and candidates ignored", () => {
	const taskDir = mkTask();
	fs.mkdirSync(path.join(taskDir, "checkpoints", "ck-0001"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "checkpoints", "ck-0007"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "checkpoints", "cand-2026-09-18T01-02-03"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "checkpoints", "notes"), { recursive: true });
	assert.equal(nextCheckpointId(taskDir), "ck-0008", "counting rather than maxing would hand out ck-0003 and overwrite nothing safely");
	const ws = mkWorkspace();
	assert.equal(snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r" }).id, "ck-0008");
});

test("a checkpoint directory is created exclusively", () => {
	const taskDir = mkTask();
	const ws = mkWorkspace();
	snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r", id: "cand-r" });
	assert.throws(() => snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r", id: "cand-r" }), /EEXIST/);
});

test("a snapshot of a workspace that is not there says so", () => {
	assert.throws(() => snapshotCheckpoint({ taskDir: mkTask(), fromDir: path.join(os.tmpdir(), "no-such-ws-9f3"), runId: "r" }), /no workspace to snapshot/);
});

// The manifest written by the snapshot would overwrite the run's own file, and an `evidence/`
// the agents wrote would read as playthrough logs this harness produced.
test("a workspace whose root holds what a checkpoint records about itself is refused", () => {
	for (const own of ["manifest.json", "evidence"]) {
		const ws = mkWorkspace({ pi: false });
		if (own === "evidence") fs.mkdirSync(path.join(ws, own));
		else fs.writeFileSync(path.join(ws, own), "{}");
		assert.throws(() => snapshotCheckpoint({ taskDir: mkTask(), fromDir: ws, runId: "r" }), new RegExp(`root ${own}`), `a root ${own} must be refused`);
	}
});

test("promote renames a candidate to the next ck id and rewrites its manifest", () => {
	const taskDir = mkTask();
	const ws = mkWorkspace();
	const cand = snapshotCheckpoint({ taskDir, fromDir: ws, runId: "2026-09-18T04-06-24", oracle: { attempt: 2, pass: 10, total: 10 }, id: "cand-2026-09-18T04-06-24" });
	const out = promoteCandidate(taskDir, "cand-2026-09-18T04-06-24");

	assert.equal(out.id, "ck-0001");
	assert.equal(fs.existsSync(cand.dir), false, "a promotion moves the tree, it does not copy it");
	assert.equal(out.manifest.id, "ck-0001");
	assert.equal(out.manifest.candidateId, "cand-2026-09-18T04-06-24");
	assert.equal(out.manifest.runId, "2026-09-18T04-06-24");
	assert.equal(out.manifest.treeHash, cand.treeHash, "promotion must not change what the checkpoint is");
	assert.deepEqual(out.manifest.oracle, { attempt: 2, pass: 10, total: 10 });
	assert.equal(readManifest(taskDir, "ck-0001").id, "ck-0001");
});

test("promote refuses anything that is not a candidate that exists", () => {
	const taskDir = mkTask();
	assert.throws(() => promoteCandidate(taskDir, "ck-0001"), /not a candidate id/);
	assert.throws(() => promoteCandidate(taskDir, "cand-nothing"), /no candidate checkpoint/);
});

test("list reports both kinds with their manifests", () => {
	const taskDir = mkTask();
	const ws = mkWorkspace();
	snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r1" });
	snapshotCheckpoint({ taskDir, fromDir: ws, runId: "r2", id: "cand-r2" });
	const list = listCheckpoints(taskDir);
	assert.deepEqual(list.map((c) => [c.id, c.candidate]), [["cand-r2", true], ["ck-0001", false]]);
	assert.equal(list[1].manifest.runId, "r1");
});

test("the id predicates tell an accepted checkpoint from a candidate", () => {
	assert.equal(isCheckpointId("ck-0007"), true);
	assert.equal(isCheckpointId("cand-r"), false);
	assert.equal(isCandidateId("cand-2026-09-18T01-02-03"), true);
	assert.equal(isCandidateId("ck-0007"), false);
	assert.equal(isCheckpointId(null), false);
	// Anchored over a filename alphabet: promoteCandidate RENAMES what this admits, so a
	// traversal typed at a terminal would move a directory out of the task.
	assert.equal(isCandidateId("cand-../../x"), false);
	assert.equal(isCandidateId("cand-a/b"), false);
	assert.equal(isCandidateId("cand-"), false);
});

// The archive finish() writes comes first; the live workspace is the fallback for a run whose
// supervisor never got there. requests/<n>-ws is deliberately not consulted — see the doc comment.
test("the final workspace is the archive, then the live directory, and never a captured request", () => {
	const runs = tmp("manage-runs-");
	fs.mkdirSync(path.join(runs, "r1", "requests", "0009-ws"), { recursive: true });
	assert.equal(finalWorkspaceOf(runs, "r1"), null, "a captured mid-run snapshot is not a final workspace");
	fs.mkdirSync(path.join(runs, ".ws-r1", "ws-builder"), { recursive: true });
	assert.equal(finalWorkspaceOf(runs, "r1"), path.join(runs, ".ws-r1", "ws-builder"));
	fs.mkdirSync(path.join(runs, "r1", "ws-builder"), { recursive: true });
	assert.equal(finalWorkspaceOf(runs, "r1"), path.join(runs, "r1", "ws-builder"), "the archive wins once it exists");
});
