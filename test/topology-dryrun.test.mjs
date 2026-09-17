import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { rosterSection } from "../lib/roster.mjs";
import { initialState, noteToolCall, decideSpawn } from "../lib/policies/topology-policy.mjs";

// The sequence the pathnorm topology run is expected to take, end to end through
// the pure policy with the real config and roster: implementer-first is nudged,
// tester passes, tests written + read lets the implementer through, a resume is
// never judged.
test("orch-pathnorm-27b-topology.json: the intended sequence passes and the wrong one is nudged exactly once", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const c = loadConfig({ configPath: path.join(here, "..", "configs", "orch-pathnorm-27b-topology.json"), env: { ...process.env, ARBITER_SKIP_MODEL_PREFLIGHT: "1" } });
	const needsFor = Object.fromEntries(c.workers.specialists.map((s) => [s.name, s.needs]));
	assert.deepEqual(needsFor, { tester: ["api"], implementer: ["api", "tests"] });
	assert.match(rosterSection(c.workers.specialists), /^Order for this roster: tester → implementer\.$/m);

	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topology-dryrun-"));
	const files = () => {
		const dir = path.join(ws, "src", "__tests__");
		return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => ({ mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs })) : [];
	};
	const state = initialState();
	const mode = c.guards.topology.mode;
	const spawn = (subagent_type, extra = {}) => decideSpawn({ mode, needsFor, input: { subagent_type, description: "d", prompt: "brief", ...extra }, state, testsFiles: files() });

	assert.equal(spawn("implementer").event, "denied", "implementer before tests is nudged");
	assert.deepEqual(spawn("tester"), { ok: true, event: null }, "tester is never judged");
	fs.mkdirSync(path.join(ws, "src", "__tests__"), { recursive: true });
	fs.writeFileSync(path.join(ws, "src", "__tests__", "pathnorm.test.mjs"), "// tests\n");
	const written = spawn("implementer");
	assert.equal(written.event, "denied", "written but not reviewed");
	assert.equal(written.failed, "tests:unread", "written but not reviewed");
	noteToolCall({ toolName: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, state, Date.now() + 1000);
	assert.deepEqual(spawn("implementer"), { ok: true, event: null }, "reviewed tests let the implementer through");
	assert.deepEqual(spawn("implementer", { resume: "abc" }), { ok: true, event: null }, "a resume is never judged");
});
