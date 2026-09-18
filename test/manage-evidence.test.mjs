import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEvidence, oracleResults, parseArtifact, parseCheck, oracleDirOfRun } from "../lib/manage/evidence.mjs";
import { snapshotCheckpoint } from "../lib/manage/checkpoint.mjs";
import { appendLedger, reverseRow } from "../lib/manage/ledger.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A workspace, a task directory holding a checkpoint of it, and a runs directory. The three
 * things every kind below is verified against. */
function fixture({ files = { "src/x.mjs": "export const x = 1;\n" } } = {}) {
	const ws = tmp("evid-ws-");
	for (const [rel, body] of Object.entries(files)) {
		const f = path.join(ws, ...rel.split("/"));
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, body);
	}
	const taskDir = tmp("evid-task-");
	const runsDir = tmp("evid-runs-");
	const ck = snapshotCheckpoint({ taskDir, fromDir: ws, runId: "2026-09-18T01-02-03" });
	return { ws, taskDir, runsDir, ck, checkpoint: ck.id };
}

/**
 * A finished run on disk: its summary (which task it ran), its audit (the oracle verdicts) and
 * its archived final workspace, copied from `wsFrom` so the tree hash is the checkpoint's.
 */
function mkRun(runsDir, runId, { task = "pathnorm", oracle = [[1, 70, 70]], wsFrom = null } = {}) {
	const dir = path.join(runsDir, runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ runId, task, reason: "SUCCESS" }));
	fs.writeFileSync(
		path.join(dir, "audit.jsonl"),
		[{ t: "0.0", type: "config", msg: "configs/x.json" }, ...oracle.map(([n, pass, total]) => ({ t: "1.0", type: "oracle", msg: `Oracle run #${n}: ${pass}/${total} passed.` }))].map((r) => JSON.stringify(r)).join("\n") + "\n",
	);
	if (wsFrom) fs.cpSync(wsFrom, path.join(dir, "ws-builder"), { recursive: true, filter: (src) => path.basename(src) !== ".pi" });
	return dir;
}

const criterion = (check, id = "c1") => ({ id, text: "…", check });

// ---------- parsing ----------

test("a check is kind:rest, and only the four kinds", () => {
	assert.deepEqual(parseCheck("oracle:tasks/x/oracle"), { kind: "oracle", rest: "tasks/x/oracle" });
	assert.deepEqual(parseCheck("review:human"), { kind: "review", rest: "human" });
	assert.equal(parseCheck("shell:rm -rf /"), null);
	assert.equal(parseCheck(undefined), null);
});

// Splitting on every colon would take `b` for the validator and leave a regex of `grep=a`.
test("artifact parses its validator from the right, and only when it is one", () => {
	assert.deepEqual(parseArtifact("docs/a.md"), { file: "docs/a.md", validator: "exists" });
	assert.deepEqual(parseArtifact("docs/a.md:nonempty"), { file: "docs/a.md", validator: "nonempty" });
	assert.deepEqual(parseArtifact("docs/a.md:grep=a:b"), { file: "docs/a.md", validator: "grep=a:b" });
	assert.deepEqual(parseArtifact("docs/a:b.md"), { file: "docs/a:b.md", validator: "exists" });
});

test("the oracle verdicts come from audit.jsonl, in order", () => {
	const runsDir = tmp("evid-runs-");
	const dir = mkRun(runsDir, "r1", { oracle: [[1, 68, 70], [2, 70, 70]] });
	assert.deepEqual(oracleResults(dir), [{ attempt: 1, pass: 68, total: 70 }, { attempt: 2, pass: 70, total: 70 }]);
	assert.equal(oracleDirOfRun({ task: "pathnorm" }), "tasks/pathnorm/oracle");
});

// ---------- oracle: ----------

test("oracle evidence passes when the run's task, its last verdict and its tree hash all agree", () => {
	const f = fixture();
	mkRun(f.runsDir, "r1", { wsFrom: f.ws });
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["r1"] });
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.artefacts, ["oracle:runs/r1/oracle-1"]);
});

test("a run whose final workspace is not the checkpoint's tree is refused, and the reason names both hashes", () => {
	const f = fixture();
	mkRun(f.runsDir, "r1", { wsFrom: f.ws });
	fs.writeFileSync(path.join(f.runsDir, "r1", "ws-builder", "src", "x.mjs"), "export const x = 2;\n");
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["r1"] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /hashes [0-9a-f]{40}, and ck-0001 is [0-9a-f]{40}/);
});

test("a failing last verdict is refused even when an earlier attempt passed", () => {
	const f = fixture();
	mkRun(f.runsDir, "r1", { wsFrom: f.ws, oracle: [[1, 70, 70], [2, 69, 70]] });
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["r1"] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /oracle run #2 was 69\/70/);
});

// The "treating as 0/0 (fail-closed)" line a validator that produced nothing leaves would satisfy
// a naive pass === total, and accept a milestone on a run whose oracle never reported.
test("a 0/0 verdict is not a pass", () => {
	const f = fixture();
	mkRun(f.runsDir, "r1", { wsFrom: f.ws, oracle: [[1, 0, 0]] });
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["r1"] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /0\/0/);
});

test("a run of a different task is not evidence for this oracle, and the reason says which it ran", () => {
	const f = fixture();
	mkRun(f.runsDir, "r1", { task: "raid", wsFrom: f.ws });
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["r1"] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /ran tasks\/raid\/oracle, not tasks\/pathnorm\/oracle/);
});

test("several runs may be named; the one that matches is the evidence", () => {
	const f = fixture();
	mkRun(f.runsDir, "old", { wsFrom: f.ws, oracle: [[1, 60, 70]] });
	mkRun(f.runsDir, "new", { wsFrom: f.ws });
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["old", "new"] });
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.artefacts, ["oracle:runs/new/oracle-1"]);
});

test("a run with no records at all is refused by name", () => {
	const f = fixture();
	const r = checkEvidence(criterion("oracle:tasks/pathnorm/oracle"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: ["ghost"] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /ghost: no summary\.json/);
});

// ---------- artifact: ----------

test("artifact validators: exists, nonempty, json and grep", () => {
	const f = fixture({ files: { "docs/a.md": "", "docs/b.md": "the answer is 42\n", "data/c.json": '{"ok":true}', "data/bad.json": "{oops" } });
	const ctx = { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] };
	const at = (check) => checkEvidence(criterion(check), ctx);

	assert.equal(at("artifact:docs/a.md").ok, true, "an empty file still exists");
	assert.equal(at("artifact:docs/a.md:nonempty").ok, false);
	assert.match(at("artifact:docs/a.md:nonempty").reason, /is empty/);
	assert.equal(at("artifact:docs/b.md:nonempty").ok, true);
	assert.deepEqual(at("artifact:docs/b.md:nonempty").artefacts, ["artifact:docs/b.md:nonempty"]);
	assert.equal(at("artifact:data/c.json:json").ok, true);
	assert.equal(at("artifact:data/bad.json:json").ok, false);
	assert.match(at("artifact:data/bad.json:json").reason, /not valid JSON/);
	assert.equal(at("artifact:docs/b.md:grep=answer is \\d+").ok, true);
	assert.equal(at("artifact:docs/b.md:grep=answer is x").ok, false);
	assert.equal(at("artifact:docs/missing.md").ok, false);
	assert.match(at("artifact:docs/missing.md").reason, /no file docs\/missing\.md in the checkpoint/);
	assert.equal(at("artifact:docs/b.md:grep=[").ok, false, "an unparseable regex is a refusal, not a throw");
});

/**
 * A checkpoint is a copy of an agent's workspace, and this repo treats that workspace as
 * adversarial everywhere else. A builder that cannot produce docs/a.md can plant a link to
 * something that exists: cpSync copies the link verbatim, treeHash counts regular files only so
 * the link is invisible to the oracle tie-back, and every reader would follow it.
 *
 * A file symlink needs developer mode on Windows, so the fallback is a directory junction, which
 * does not and which `lstat` reports as a link just the same. Skipped only if neither can be made.
 */
test("a symlinked artifact is refused, not followed", (t) => {
	const f = fixture({ files: { "docs/real.md": "the real thing\n" } });
	const link = path.join(f.taskDir, "checkpoints", "ck-0001", "docs", "a.md");
	const outside = path.join(f.taskDir, "outside.txt");
	fs.writeFileSync(outside, "not the run's work\n");
	try {
		fs.symlinkSync(outside, link);
	} catch {
		try {
			const dir = path.join(f.taskDir, "outside-dir");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "inside.txt"), "not the run's work\n");
			fs.symlinkSync(dir, link, "junction");
		} catch {
			return t.skip("this environment allows neither a symlink nor a junction");
		}
	}
	const ctx = { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] };
	for (const check of ["artifact:docs/a.md", "artifact:docs/a.md:nonempty", "artifact:docs/a.md:grep=not the run"]) {
		const r = checkEvidence(criterion(check), ctx);
		assert.equal(r.ok, false, `${check} must be refused`);
		assert.match(r.reason, /symbolic link/);
	}
	assert.equal(checkEvidence(criterion("artifact:docs/real.md:nonempty"), ctx).ok, true, "a real file is unaffected");
});

// A criterion is human-written, but the checkpoint is the only tree this kind may speak about.
test("an artifact path outside the checkpoint is refused", () => {
	const f = fixture();
	const r = checkEvidence(criterion("artifact:../../../etc/hosts"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /resolves outside the checkpoint/);
});

// ---------- playthrough: ----------

// The script gets a COPY. A playthrough is not guaranteed read-only — a build step, a save file,
// an install — and an accepted checkpoint is the state a later restore starts from, so a script
// that writes would silently redefine what was accepted. The manifest and any earlier evidence
// logs stay out of the copy: they are the checkpoint's record of itself, not the tree under test.
test("a playthrough runs the script against a copy of the checkpoint, never the checkpoint", () => {
	const f = fixture();
	const script = path.join(f.taskDir, "play.mjs");
	fs.writeFileSync(script, "console.log('played');\n");
	fs.mkdirSync(path.join(f.ck.dir, "evidence"), { recursive: true });
	fs.writeFileSync(path.join(f.ck.dir, "evidence", "c1.log"), "an earlier criterion\n");
	const calls = [];
	const spawn = (cmd, args, opts) => {
		const handed = args[1];
		calls.push({ cmd, args, opts, saw: fs.readdirSync(handed).sort(), src: fs.readFileSync(path.join(handed, "src", "x.mjs"), "utf8") });
		// What a careless playthrough does. The checkpoint must be untouched by it.
		fs.writeFileSync(path.join(handed, "src", "x.mjs"), "rewritten by the playthrough\n");
		return { status: 0, stdout: "played\n", stderr: "" };
	};
	const r = checkEvidence(criterion(`playthrough:${script}`, "c2"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [], spawn });

	assert.equal(r.ok, true, r.reason);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].cmd, process.execPath);
	assert.equal(calls[0].args[0], script);
	assert.notEqual(calls[0].args[1], f.ck.dir, "the checkpoint itself is never handed to a script");
	assert.deepEqual(calls[0].saw, ["src"], "the copy carries the tree, not the manifest or the earlier logs");
	assert.equal(calls[0].src, "export const x = 1;\n");
	assert.equal(fs.readFileSync(path.join(f.ck.dir, "src", "x.mjs"), "utf8"), "export const x = 1;\n", "a writing playthrough must not reach the checkpoint");
	assert.equal(fs.existsSync(calls[0].args[1]), false, "and the copy is cleaned up afterwards");
	assert.equal(calls[0].opts.timeout, 10 * 60 * 1000);
	const log = path.join(f.ck.dir, "evidence", "c2.log");
	assert.equal(fs.readFileSync(log, "utf8"), "played\n");
	assert.deepEqual(r.artefacts, [`playthrough:${script.replace(/\\/g, "/")}`, "log:ck-0001/evidence/c2.log"]);
});

test("a non-zero playthrough is refused, and its output is still on disk", () => {
	const f = fixture();
	const script = path.join(f.taskDir, "play.mjs");
	fs.writeFileSync(script, "process.exit(1);\n");
	const spawn = () => ({ status: 1, stdout: "step 3 failed\n", stderr: "boom\n" });
	const r = checkEvidence(criterion(`playthrough:${script}`, "c2"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [], spawn });
	assert.equal(r.ok, false);
	assert.match(r.reason, /exited 1 \(log: ck-0001\/evidence\/c2\.log\)/);
	assert.equal(fs.readFileSync(path.join(f.ck.dir, "evidence", "c2.log"), "utf8"), "step 3 failed\nboom\n");
});

test("a playthrough script that does not exist is refused before anything is spawned", () => {
	const f = fixture();
	let spawned = 0;
	const r = checkEvidence(criterion("playthrough:docs/nothing-here.mjs", "c2"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [], spawn: () => (spawned++, { status: 0 }) });
	assert.equal(r.ok, false);
	assert.equal(spawned, 0);
	assert.match(r.reason, /does not exist/);
});

// A real child process, once: the injected spawn above proves the wiring, this proves the
// default is a working one.
test("with no injected spawn, the real script decides", () => {
	const f = fixture();
	const script = path.join(f.taskDir, "play.mjs");
	fs.writeFileSync(script, "import fs from 'node:fs';\nconst ok = fs.existsSync(process.argv[2] + '/src/x.mjs');\nprocess.stdout.write(ok ? 'ok' : 'missing');\nprocess.exit(ok ? 0 : 1);\n");
	const r = checkEvidence(criterion(`playthrough:${script}`, "c2"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] });
	assert.equal(r.ok, true, r.reason);
	assert.equal(fs.readFileSync(path.join(f.ck.dir, "evidence", "c2.log"), "utf8"), "ok");
});

// ---------- review:human ----------

test("review:human needs a signed ledger row for this criterion and this checkpoint", () => {
	const f = fixture();
	const ctx = { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] };
	const c = criterion("review:human", "c3");

	assert.equal(checkEvidence(c, ctx).ok, false, "nothing in the ledger");
	appendLedger(f.taskDir, { kind: "review", criterion: "c3", checkpoint: "ck-0002", by: "david", signed: true });
	assert.match(checkEvidence(c, ctx).reason, /no signed review row for c3 on ck-0001/, "a row for another checkpoint is not this one's");
	appendLedger(f.taskDir, { kind: "review", criterion: "c3", checkpoint: "ck-0001", by: "david", signed: "yes" });
	assert.equal(checkEvidence(c, ctx).ok, false, "signed must be true, not merely truthy");

	const row = appendLedger(f.taskDir, { kind: "review", criterion: "c3", checkpoint: "ck-0001", by: "david", signed: true });
	const r = checkEvidence(c, ctx);
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.artefacts, ["review:david"]);

	// A retracted row is something that did not happen, here as everywhere else the ledger is read.
	reverseRow(f.taskDir, row.seq, "signed in error");
	assert.equal(checkEvidence(c, ctx).ok, false, "a reversed review row must not count");
});

test("review: anything other than human is refused", () => {
	const f = fixture();
	const r = checkEvidence(criterion("review:auto", "c3"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /only one is review:human/);
});

test("an unknown check kind is refused rather than ignored", () => {
	const f = fixture();
	const r = checkEvidence(criterion("vibes:good", "c9"), { taskDir: f.taskDir, checkpoint: f.checkpoint, runsDir: f.runsDir, evidence: [] });
	assert.equal(r.ok, false);
	assert.match(r.reason, /criterion c9/);
});
