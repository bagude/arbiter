import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCampaign, validateCampaign, legacyCampaign, median, decideRound, noveltyTally, findingsWithRows, seedTally } from "../lib/campaign.mjs";

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

test("median: empty is null, odd and even lengths, ignores non-finite", () => {
	assert.equal(median([]), null);
	assert.equal(median([5]), 5);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([1, NaN, 3]), 2);
});

test("decideRound: no budget always runs; exhausted skips; below the median round skips; otherwise runs with the remainder", () => {
	assert.deepEqual(decideRound({}), { run: true, remaining: null, reason: null });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 1000 }), { run: false, remaining: 0, reason: "budget exhausted (1000 of 1000 tokens spent)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 1200, roundTokens: [1200] }), { run: false, remaining: 0, reason: "budget exhausted (1200 of 1000 tokens spent)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 700, roundTokens: [200, 300] }), { run: true, remaining: 300, reason: null });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 800, roundTokens: [400, 400] }), { run: false, remaining: 200, reason: "remaining 200 tokens below the median round (400)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 0, roundTokens: [] }), { run: true, remaining: 1000, reason: null });
});

test("noveltyTally: same normalised query, identical rows, similar title, or novel", () => {
	const t = noveltyTally({ sameTitle: 0.4 });
	assert.equal(t.absorb([{ title: "Water cut rises sharply in county 421 after 2019", query: "SELECT a FROM t;", result: [{ a: 1 }] }]), 1);
	assert.equal(t.isKnown({ title: "something else entirely", query: "select   a from t" }), "same query");
	assert.equal(t.isKnown({ title: "something else entirely", query: "SELECT b FROM u", result: [{ a: 1 }] }), "same result");
	assert.equal(t.isKnown({ title: "Water cut rises sharply in county 421 after 2020", query: "SELECT c FROM v", result: [{ c: 9 }] }), "similar title");
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county", query: "SELECT c FROM v", result: [{ c: 9 }] }), null);
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county" }), null, "no query and no rows: title only");
	assert.equal(t.absorbTitles(["Gas oil ratio flat in Lea county"]), 1);
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county" }), "similar title");
	assert.equal(t.size(), 2);
});

test("findingsWithRows carries each observation's query and rows next to the retention-shaped finding", () => {
	const doc = { observations: [{ id: "O1", title: "T1", claim: "observed", observation: "x", query: "SELECT 1", result: [{ n: 1 }] }] };
	const [f] = findingsWithRows(doc);
	assert.equal(f.title, "T1");
	assert.equal(f.query, "SELECT 1");
	assert.deepEqual(f.result, [{ n: 1 }]);
	assert.deepEqual(findingsWithRows(null), []);
});

test("seedTally reads earlier runs' deliverables for the campaign's tasks and semantic titles for its scopes", () => {
	const r = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-seed-"));
	const runs = path.join(r, "runs");
	const mk = (id, task, name, doc) => {
		fs.mkdirSync(path.join(runs, id, "ws-builder", "src"), { recursive: true });
		fs.writeFileSync(path.join(runs, id, "summary.json"), JSON.stringify({ task }));
		fs.writeFileSync(path.join(runs, id, "ws-builder", "src", name), JSON.stringify(doc));
	};
	mk("2026-09-01T00-00-00", "dw-explore-real", "exploration.json", { observations: [{ id: "O1", title: "Alpha beta gamma delta", query: "SELECT 1", result: [] }] });
	mk("2026-09-02T00-00-00", "other-task", "exploration.json", { observations: [{ id: "O1", title: "Epsilon zeta eta theta", query: "SELECT 2", result: [] }] });
	fs.mkdirSync(path.join(runs, ".campaign-x"));
	const log = path.join(r, "records.jsonl");
	fs.writeFileSync(log, [JSON.stringify({ scope: "repo:dw", kind: "semantic", summary: "Iota kappa lambda mu" }), JSON.stringify({ scope: "repo:elsewhere", kind: "semantic", summary: "Nu xi omicron pi" }), JSON.stringify({ scope: "repo:dw", kind: "episodic", text: "..." }), JSON.stringify({ scope: "repo:dw", op: "tombstone" })].join("\n") + "\n");
	const t = noveltyTally();
	assert.deepEqual(seedTally(t, { runsDir: runs, memoryLog: log, tasks: ["dw-explore-real"], scopes: ["repo:dw"] }), { runs: 1, findings: 1, fromMemory: 1 });
	assert.equal(t.isKnown({ title: "Alpha beta gamma delta" }), "similar title");
	assert.equal(t.isKnown({ title: "Epsilon zeta eta theta" }), null, "other task's run is not a seed");
	assert.equal(t.isKnown({ title: "Iota kappa lambda mu" }), "similar title");
	assert.equal(t.isKnown({ title: "Nu xi omicron pi" }), null, "other scope is not a seed");
});
