// checkpoint — the accepted workspaces a task advances through (spec §1: `checkpoints/<id>/`).
//
// A checkpoint is a directory, not a task.json field, and that is what makes this file safe for
// the supervisor to use. `task.json` has exactly one writer, the executor; the supervisor runs in
// another process and may not touch it. But a run's final workspace only exists while that run's
// process is alive, so something inside the run has to preserve it. So the supervisor writes a
// CANDIDATE — `checkpoints/cand-<runId>/`, inert, named by the run, read by nothing — and the
// executor promotes it to the next `ck-NNNN` when a manager accepts it. Nothing here imports
// task-state, and nothing here writes task.json.
import fs from "node:fs";
import path from "node:path";
import { treeHash } from "../tree-hash.mjs";

/** `.pi` is the agent's own directory inside a workspace — extensions, agent definitions and
 * session scratch the host installed, not work the run produced. It is excluded from every
 * checkpoint, so two runs of the same task that produced identical source hash identically. */
export const SKIP_PI = (p) => path.basename(p) === ".pi";

/** The hash a checkpoint's manifest records: the tree as a checkpoint sees it, `.pi` left out.
 * Run against a live workspace it answers the question the evidence check asks — "is this the
 * tree the checkpoint was taken from?" — without copying the workspace a second time. */
export const workspaceHash = (dir) => treeHash(dir, SKIP_PI);

export const checkpointsDir = (taskDir) => path.join(taskDir, "checkpoints");
export const checkpointDir = (taskDir, id) => path.join(checkpointsDir(taskDir), id);

/** A promoted checkpoint, the only kind a manager may accept at. */
export const isCheckpointId = (id) => typeof id === "string" && /^ck-\d+$/.test(id);
/** A supervisor's candidate: preserved by the run that made it, not yet accepted by anyone.
 * Fully anchored over a filename alphabet, like a compare branch's label and for the same reason:
 * the id is joined into a path, and `promoteCandidate` RENAMES what it names — `cand-../../x`
 * typed at a terminal would move a directory out of the task. A run id fits (a timestamp with its
 * colons already replaced), and that is the only thing the supervisor ever puts here. */
export const isCandidateId = (id) => typeof id === "string" && /^cand-[A-Za-z0-9._-]+$/.test(id);

/** What a checkpoint directory holds about ITSELF rather than about the tree it preserves. A
 * workspace containing either at its root cannot be snapshotted (the copy would overwrite the
 * manifest, or read as evidence nobody produced), and a restore leaves both behind. */
export const CHECKPOINT_OWN = ["manifest.json", "evidence"];

/**
 * Next `ck-NNNN`: the max numeric id already on disk plus one, ignoring gaps.
 *
 * By max rather than by count, for the reason packet.mjs's nextPacketId gives — counting reuses
 * an id the moment there is a gap, and a reused checkpoint id would write one accepted workspace
 * over another. Candidates are not counted: they are named by their run and never numbered.
 */
export function nextCheckpointId(taskDir) {
	const dir = checkpointsDir(taskDir);
	const ids = fs.existsSync(dir)
		? fs.readdirSync(dir).map((f) => /^ck-(\d+)$/.exec(f)).filter(Boolean).map((m) => Number(m[1]))
		: [];
	return `ck-${String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, "0")}`;
}

/**
 * Copies `fromDir` (minus `.pi`) into the task's checkpoints and writes its manifest.
 *
 * The directory is created EXCLUSIVELY — `mkdirSync` without `recursive` on the leaf — so two
 * writers racing for the same id cannot merge two workspaces into one checkpoint. The hash is
 * taken over the copy BEFORE the manifest is written, which is what makes it equal to
 * `workspaceHash(fromDir)`: the manifest is the checkpoint's own record, not part of the tree it
 * describes.
 *
 * `id` names the checkpoint; left out it is the next `ck-NNNN`. The supervisor passes
 * `cand-<runId>` — see the file header for why a run may write one and may not promote it.
 */
export function snapshotCheckpoint({ taskDir, fromDir, runId, oracle = null, id = null }) {
	if (!fs.existsSync(fromDir)) throw new Error(`no workspace to snapshot at ${fromDir}`);
	// A workspace whose root already holds what a checkpoint keeps about itself cannot be one: the
	// manifest written below would overwrite the run's own file, and an `evidence/` directory the
	// agents wrote would read as playthrough logs this harness produced.
	for (const own of CHECKPOINT_OWN) if (fs.existsSync(path.join(fromDir, own))) throw new Error(`${fromDir} has a root ${own}, which is what a checkpoint records about itself — it cannot be snapshotted as one`);
	const ckId = id ?? nextCheckpointId(taskDir);
	fs.mkdirSync(checkpointsDir(taskDir), { recursive: true });
	const dir = checkpointDir(taskDir, ckId);
	fs.mkdirSync(dir); // exclusive: EEXIST rather than a silent merge
	fs.cpSync(fromDir, dir, { recursive: true, filter: (src) => !SKIP_PI(src) });
	const hash = treeHash(dir);
	const manifest = { id: ckId, runId: runId ?? null, treeHash: hash, oracle, createdAt: Date.now() };
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	return { id: ckId, dir, treeHash: hash, manifest };
}

export function readManifest(taskDir, id) {
	const f = path.join(checkpointDir(taskDir, id), "manifest.json");
	if (!fs.existsSync(f)) return null;
	return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** Every checkpoint on disk, candidates included, with its manifest. */
export function listCheckpoints(taskDir) {
	const dir = checkpointsDir(taskDir);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && (isCheckpointId(e.name) || isCandidateId(e.name)))
		.map((e) => ({ id: e.name, candidate: isCandidateId(e.name), manifest: readManifest(taskDir, e.name) }))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Renames a candidate to the next `ck-NNNN` and rewrites its manifest id.
 *
 * A rename, not a copy: the candidate IS the workspace the run ended with, and copying it would
 * leave two trees on disk with one hash between them and no way to say which the task advanced
 * from. The manifest keeps the candidate's name under `candidateId`, so a checkpoint can always
 * be traced back to the run that preserved it even after the run's directory is cleaned up.
 */
export function promoteCandidate(taskDir, candidateId) {
	if (!isCandidateId(candidateId)) throw new Error(`not a candidate id: ${JSON.stringify(candidateId)} (expected cand-<runId>)`);
	const from = checkpointDir(taskDir, candidateId);
	if (!fs.existsSync(from)) throw new Error(`no candidate checkpoint at ${from}`);
	const id = nextCheckpointId(taskDir);
	const to = checkpointDir(taskDir, id);
	fs.renameSync(from, to);
	const manifest = { ...(JSON.parse(fs.readFileSync(path.join(to, "manifest.json"), "utf8"))), id, candidateId, promotedAt: Date.now() };
	fs.writeFileSync(path.join(to, "manifest.json"), JSON.stringify(manifest, null, 2));
	return { id, dir: to, manifest };
}

/**
 * The workspace a finished run ended with, or null.
 *
 * Two places, in this order, and no third: `runs/<id>/ws-builder` is the archive finish() makes
 * on the way out, and `runs/.ws-<id>/ws-builder` is the live workspace of a run still going (or
 * one whose supervisor died before archiving). `requests/<n>-ws` is deliberately NOT consulted —
 * those are the workspace as of a captured inference, mid-run, and hashing one as "final" would
 * report a mismatch that reads like tampering.
 */
export function finalWorkspaceOf(runsDir, runId) {
	for (const dir of [path.join(runsDir, runId, "ws-builder"), path.join(runsDir, `.ws-${runId}`, "ws-builder")]) {
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}
