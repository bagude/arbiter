import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { charge, spent, wouldExceed } from "../lib/memory-budget.mjs";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-budget-")), "memory-calls.jsonl");

test("charge appends and spent sums by tool and role; refusals are counted, not charged", () => {
	const f = tmp();
	assert.equal(spent(f).chars, 0, "a missing ledger is empty");
	assert.equal(charge(f, { role: "supervisor", tool: "seed", chars: 1200, detail: "seeded brief" }), 1200);
	assert.equal(charge(f, { role: "orchestrator", tool: "search", chars: 800, detail: "TX water loader" }), 2000);
	assert.equal(charge(f, { role: "worker:854e28b7", tool: "get", chars: 3000, detail: "m_a,m_b" }), 5000);
	charge(f, { role: "worker:854e28b7", tool: "refused", chars: 0, detail: "get m_c" });
	const s = spent(f);
	assert.equal(s.chars, 5000);
	assert.deepEqual(s.calls, { seed: 1, search: 1, get: 1 });
	assert.equal(s.refused, 1);
	assert.deepEqual(s.byRole, { supervisor: 1200, orchestrator: 800, "worker:854e28b7": 3000 });
	assert.equal(wouldExceed(f, 6000, 1000), false);
	assert.equal(wouldExceed(f, 6000, 1001), true);
});

test("several processes appending lose nothing", () => {
	const f = tmp();
	const script = `import { charge } from ${JSON.stringify(new URL("../lib/memory-budget.mjs", import.meta.url).href)}; for (let i = 0; i < 200; i++) charge(${JSON.stringify(f)}, { role: process.argv[1], tool: "get", chars: 1, detail: "" });`;
	const kids = ["a", "b", "c"].map((name) => spawnSync(process.execPath, ["--input-type=module", "-e", script, name], { encoding: "utf8" }));
	for (const k of kids) assert.equal(k.status, 0, k.stderr);
	assert.equal(spent(f).chars, 600);
	assert.equal(fs.readFileSync(f, "utf8").trim().split("\n").length, 600);
});
