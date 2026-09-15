import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./src/raid.mjs";
import * as A from "./src/arena.mjs";

const C = R.SAMPLE_CHAMPIONS;
const throwsType = (fn, prefix = "invalid argument") => assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
const mk = (id, level = 1) => R.makeChampion(C[id], level);
const four = () => [mk("kael"), mk("vell"), mk("grim"), mk("nyx")];
const fake = (hps, winner) => ({ winner, units: hps.map((hp, i) => ({ side: i < 2 ? 0 : 1, hp })) });

test("constants", () => {
	assert.equal(A.ENERGY_PER_STAGE, 4);
	assert.equal(A.MAX_STAGE, 12);
});
test("stage 1: stars", () => {
	assert.equal(A.stars(R.resolveStage(four(), 1, 3).battle), 3);
	assert.equal(A.stars(R.resolveStage([mk("vell")], 9, 3).battle), 0);
	assert.equal(A.stars(fake([0, 5, 0, 0], "A")), 2);
	assert.equal(A.stars(fake([0, 0, 0, 0], "A")), 1);
	assert.equal(A.stars(fake([1, 1, 0, 0], "A")), 3);
	assert.equal(A.stars(fake([1, 1, 0, 0], "draw")), 0);
	assert.equal(A.stars(fake([1, 1, 5, 0], "B")), 0);
	throwsType(() => A.stars({ winner: "A" }));
	throwsType(() => A.stars(null));
});
test("stage 2: runCampaign clears ten stages on 40 energy", () => {
	const inp = four();
	const c = A.runCampaign(inp, 100, 40);
	assert.deepEqual(Object.keys(c).sort(), ["energyLeft", "log", "nextStage", "silver", "stagesCleared", "stopped", "team", "xp"]);
	assert.deepEqual([c.stagesCleared, c.nextStage, c.silver, c.xp, c.energyLeft, c.stopped], [10, 11, 5500, 2750, 0, "energy"]);
	assert.deepEqual(c.log.map((e) => e.stage), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.deepEqual(c.log.map((e) => e.turns), [12, 14, 12, 15, 16, 18, 20, 23, 23, 23]);
	assert.ok(c.log.every((e) => e.won && e.stars === 3));
	assert.deepEqual(c.log[9].rewards, { silver: 1000, xp: 500 });
	assert.deepEqual(Object.keys(c.log[0]).sort(), ["rewards", "stage", "stars", "turns", "won"]);
	assert.deepEqual(c.team.map((x) => [x.id, x.level, x.xp, x.hp]), [["kael", 7, 475, 1860], ["vell", 7, 475, 1550], ["grim", 7, 475, 2232], ["nyx", 7, 475, 1736]]);
	assert.deepEqual(inp.map((x) => x.level), [1, 1, 1, 1], "input untouched");
});
test("stage 2: runCampaign energy and loss stops", () => {
	const c7 = A.runCampaign(four(), 100, 7);
	assert.deepEqual([c7.stagesCleared, c7.nextStage, c7.energyLeft, c7.stopped, c7.log.length, c7.log[0].turns], [1, 2, 3, "energy", 1, 12]);
	const solo = A.runCampaign([mk("vell")], 100, 100);
	assert.deepEqual([solo.stagesCleared, solo.nextStage, solo.silver, solo.energyLeft, solo.stopped], [1, 2, 100, 92, "loss"]);
	assert.deepEqual(solo.log.map((e) => [e.stage, e.won, e.stars, e.turns]), [[1, true, 3, 42], [2, false, 0, 35]]);
	assert.deepEqual(solo.log[1].rewards, { silver: 0, xp: 0 });
	assert.deepEqual(solo.team.map((x) => [x.level, x.xp]), [[2, 25]]);
	const zero = A.runCampaign(four(), 1, 3);
	assert.deepEqual([zero.stagesCleared, zero.nextStage, zero.silver, zero.xp, zero.energyLeft, zero.stopped], [0, 1, 0, 0, 3, "energy"]);
	assert.deepEqual(zero.log, []);
	assert.equal(zero.team.length, 4);
	assert.equal(zero.team[0].level, 1);
});
test("stage 2: runCampaign completes and honours startStage", () => {
	const maxed = () => four().map((c) => R.addXp(c, 100000));
	const c = A.runCampaign(maxed(), 5, 100);
	assert.deepEqual([c.stagesCleared, c.nextStage, c.silver, c.xp, c.energyLeft, c.stopped], [12, 13, 7800, 3900, 52, "complete"]);
	assert.deepEqual(c.log.map((e) => e.stars), [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
	assert.deepEqual(c.log.map((e) => e.turns), [9, 9, 9, 11, 11, 14, 10, 17, 14, 18, 17, 22]);
	const late = A.runCampaign(maxed(), 5, 100, 11);
	assert.deepEqual(late.log.map((e) => [e.stage, e.won, e.stars]), [[11, true, 3], [12, true, 3]]);
	assert.deepEqual([late.stagesCleared, late.nextStage, late.energyLeft, late.stopped], [2, 13, 92, "complete"]);
	const exact = A.runCampaign(maxed(), 5, 8, 12);
	assert.deepEqual([exact.stagesCleared, exact.nextStage, exact.energyLeft, exact.stopped], [1, 13, 4, "complete"]);
});
test("stage 2: runCampaign validation", () => {
	throwsType(() => A.runCampaign([], 1, 10));
	throwsType(() => A.runCampaign(four(), 1.5, 10));
	throwsType(() => A.runCampaign(four(), 1, -1));
	throwsType(() => A.runCampaign(four(), 1, 10, 0));
	throwsType(() => A.runCampaign(four(), 1, 10, 13));
	throwsType(() => A.runCampaign([{ level: 1 }], 1, 10));
});
test("stage 3: combinations", () => {
	assert.deepEqual(A.combinations(4, 2), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]);
	assert.deepEqual(A.combinations(3, 3), [[0, 1, 2]]);
	assert.deepEqual(A.combinations(3, 0), [[]]);
	assert.deepEqual(A.combinations(2, 3), []);
	assert.deepEqual(A.combinations(5, 1), [[0], [1], [2], [3], [4]]);
	assert.equal(A.combinations(6, 3).length, 20);
	throwsType(() => A.combinations(-1, 1));
	throwsType(() => A.combinations(3, 1.5));
});
test("stage 3: bestTeam", () => {
	const b = A.bestTeam(four(), 2, 3, 9);
	assert.deepEqual(Object.keys(b), ["best", "tried"]);
	assert.deepEqual(b.best, { indexes: [0, 3], turns: 13, stars: 3 });
	assert.deepEqual(b.tried.map((t) => t.turns), [16, 17, 13, 39, 17, 16]);
	assert.ok(b.tried.every((t) => t.won && t.stars === 3));
	assert.deepEqual(b.tried[0], { indexes: [0, 1], won: true, stars: 3, turns: 16 });
	const one = A.bestTeam(four(), 1, 1, 2);
	assert.deepEqual(one.best, { indexes: [0], turns: 21, stars: 3 });
	assert.deepEqual(one.tried.map((t) => [t.indexes[0], t.won, t.turns]), [[0, true, 21], [1, false, 43], [2, true, 38], [3, true, 22]]);
	const none = A.bestTeam([mk("vell"), mk("grim")], 1, 9, 3);
	assert.equal(none.best, null);
	assert.deepEqual(none.tried.map((t) => [t.won, t.stars, t.turns]), [[false, 0, 15], [false, 0, 20]]);
	throwsType(() => A.bestTeam(four(), 0, 1, 1));
	throwsType(() => A.bestTeam(four(), 5, 1, 1));
	throwsType(() => A.bestTeam(four(), 2, 0, 1));
	throwsType(() => A.bestTeam([], 1, 1, 1));
});
