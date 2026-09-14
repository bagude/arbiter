import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCampaign, validateCampaign, legacyCampaign } from "../lib/campaign.mjs";

function root() {
	const r = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-camp-"));
	fs.mkdirSync(path.join(r, "configs"));
	fs.writeFileSync(path.join(r, "configs", "a.json"), JSON.stringify({ task: "orbit" }));
	fs.writeFileSync(path.join(r, "configs", "b.json"), JSON.stringify({ task: "orbit" }));
	return r;
}
const good = { name: "demo", phases: [{ phase: "study", config: "configs/a.json", rounds: 2, file: "study.json" }, { phase: "apply", config: "configs/b.json", rounds: 1 }], brake: { minNovelty: 0.6 }, budget: { tokens: 1000 } };

test("a valid campaign loads with defaults filled", () => {
	const r = root();
	const file = path.join(r, "demo.json");
	fs.writeFileSync(file, JSON.stringify(good));
	const c = loadCampaign(file, { root: r });
	assert.equal(c.name, "demo");
	assert.deepEqual(c.phases, [{ phase: "study", config: "configs/a.json", rounds: 2, file: "study.json" }, { phase: "apply", config: "configs/b.json", rounds: 1, file: null }]);
	assert.deepEqual(c.brake, { minNovelty: 0.6, sameTitle: 0.4 });
	assert.deepEqual(c.budget, { tokens: 1000 });
	assert.equal(validateCampaign({ name: "x", phases: [{ phase: "p", config: "configs/a.json", rounds: 1 }] }, { root: r }).budget, null);
});

test("every malformed shape fails at load with the field named", () => {
	const r = root();
	const bad = (patch, re) => assert.throws(() => validateCampaign({ ...good, ...patch }, { root: r, file: "t.json" }), re);
	bad({ phases: [] }, /phases must be a non-empty list/);
	bad({ phases: [{ phase: "p", config: "configs/nope.json", rounds: 1 }] }, /config "configs\/nope\.json" not found/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 0 }] }, /rounds must be an integer >= 1/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1, extra: 1 }] }, /phases\[0\]: unknown key "extra"/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1, file: "notes.json" }] }, /file must be one of exploration\.json, study\.json, report\.json, watchlist\.json/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1 }, { phase: "p", config: "configs/b.json", rounds: 1 }] }, /phase "p" appears twice/);
	bad({ name: "bad name" }, /name must match/);
	bad({ budget: { tokens: 1.5 } }, /budget\.tokens must be an integer >= 1/);
	bad({ budget: { usd: 5 } }, /unknown budget key "usd"/);
	bad({ brake: { minNovelty: 2 } }, /brake\.minNovelty must be between 0 and 1/);
	bad({ surprise: true }, /unknown key "surprise"/);
});

test("legacy args become a one-phase campaign; a .json first argument is not legacy", () => {
	const r = root();
	const c = legacyCampaign(["explore-3", "configs/a.json", "--rounds", "4", "--min-novelty", "0.3"], { root: r });
	assert.equal(c.name, "explore-3");
	assert.deepEqual(c.phases, [{ phase: "explore", config: "configs/a.json", rounds: 4, file: "exploration.json" }]);
	assert.deepEqual(c.brake, { minNovelty: 0.3, sameTitle: 0.4 });
	assert.equal(c.budget, null);
	assert.equal(legacyCampaign(["campaigns/x.json"], { root: r }), null);
	assert.equal(legacyCampaign([], { root: r }), null);
});
