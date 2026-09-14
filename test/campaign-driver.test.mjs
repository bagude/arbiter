import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The driver's control flow with nothing spawned: --dry lists every round and the
// caps.tokens each would get, honours --from, and writes no report.
test("--dry plans every round, honours --from, runs nothing", () => {
	const name = `drytest-${process.pid}`;
	const camp = path.join(os.tmpdir(), `${name}.json`);
	fs.writeFileSync(camp, JSON.stringify({ name, phases: [{ phase: "a", config: "configs/smoke-orch.json", rounds: 2 }, { phase: "b", config: "configs/smoke-orch.json", rounds: 1, file: "report.json" }], budget: { tokens: 1000 } }));
	const r = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry"], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /a round 1\/2: would run smoke-orch\.json with caps\.tokens=1000/);
	assert.match(r.stdout, /a round 2\/2: would run/);
	assert.match(r.stdout, /b round 1\/1: would run/);
	assert.match(r.stdout, /dry run: 3 round\(s\) planned/);
	assert.ok(!fs.existsSync(path.join("docs", "batch", `campaign-${name}.md`)), "no report on a dry run");
	const plan = JSON.parse(fs.readFileSync(path.join("runs", `.campaign-${name}`, "dry.json"), "utf8"));
	assert.deepEqual(plan.rows.map((x) => [x.phase, x.round, x.skipped]), [["a", 1, "dry run"], ["a", 2, "dry run"], ["b", 1, "dry run"]]);

	const from = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry", "--from", "b:1"], { encoding: "utf8" });
	assert.equal(from.status, 0, from.stderr);
	const plan2 = JSON.parse(fs.readFileSync(path.join("runs", `.campaign-${name}`, "dry.json"), "utf8"));
	assert.deepEqual(plan2.rows.map((x) => [x.phase, x.round, x.skipped]), [["a", 1, "before --from b:1"], ["a", 2, "before --from b:1"], ["b", 1, "dry run"]]);

	const bad = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry", "--from", "zzz:1"], { encoding: "utf8" });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /--from must be <phase>:<round>/);
	fs.rmSync(path.join("runs", `.campaign-${name}`), { recursive: true, force: true });
});
