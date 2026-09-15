import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./raid.mjs";

const C = R.SAMPLE_CHAMPIONS;
const throwsType = (fn, prefix = "invalid argument") => assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
const throwsRange = (fn, prefix) => assert.throws(fn, (e) => e instanceof RangeError && e.message.startsWith(prefix), `expected RangeError "${prefix}..."`);
const near = (a, b, tol = 1e-12, msg = "") => assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${msg} |${a} - ${b}| > ${tol}`);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const lvl1 = () => ({ A: [R.makeChampion(C.kael), R.makeChampion(C.vell)], B: [R.makeChampion(C.grim), R.makeChampion(C.nyx)] });

// ---- Stage 1 ----------------------------------------------------------------

test("stage 1: mulberry32 seed 1 sequence is exact", () => {
	const r = R.mulberry32(1);
	assert.deepEqual([r(), r(), r(), r(), r()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849]);
});
test("stage 1: mulberry32 other seeds", () => {
	const r42 = R.mulberry32(42);
	assert.deepEqual([r42(), r42()], [0.6011037519201636, 0.44829055899754167]);
	const r0 = R.mulberry32(0);
	assert.deepEqual([r0(), r0()], [0.26642920868471265, 0.0003297457005828619]);
	assert.equal(R.mulberry32(-7)(), 0.43306733411736786);
	assert.equal(R.mulberry32(2 ** 32 + 1)(), 0.6270739405881613);
});
test("stage 1: mulberry32 generators are independent and validated", () => {
	const a = R.mulberry32(9);
	const b = R.mulberry32(9);
	a();
	a();
	assert.equal(b(), R.mulberry32(9)());
	throwsType(() => R.mulberry32(1.5));
	throwsType(() => R.mulberry32("1"));
	throwsType(() => R.mulberry32());
});
test("stage 1: statsAt levels", () => {
	assert.deepEqual(R.statsAt(C.kael.base, 1), { hp: 1500, atk: 130, def: 90, spd: 104, crit: 0.3, critDmg: 1.6 });
	assert.deepEqual(pick(R.statsAt(C.kael.base, 2), ["hp", "atk", "def"]), { hp: 1560, atk: 135, def: 93 });
	assert.deepEqual(pick(R.statsAt(C.kael.base, 3), ["hp", "atk", "def"]), { hp: 1620, atk: 140, def: 97 });
	assert.deepEqual(pick(R.statsAt(C.kael.base, 10), ["hp", "atk", "def"]), { hp: 2040, atk: 176, def: 122 });
	assert.deepEqual(pick(R.statsAt(C.kael.base, 26), ["hp", "atk", "def"]), { hp: 3000, atk: 260, def: 180 });
	assert.deepEqual(pick(R.statsAt(C.kael.base, 60), ["hp", "atk", "def"]), { hp: 5040, atk: 436, def: 302 });
	assert.deepEqual(R.statsAt(C.vell.base, 7), { hp: 1550, atk: 117, def: 148, spd: 98, crit: 0.15, critDmg: 1.5 });
	assert.deepEqual(Object.keys(R.statsAt(C.grim.base, 4)).sort(), ["atk", "crit", "critDmg", "def", "hp", "spd"]);
});
test("stage 1: statsAt validation", () => {
	throwsType(() => R.statsAt(C.kael.base, 0));
	throwsType(() => R.statsAt(C.kael.base, 61));
	throwsType(() => R.statsAt(C.kael.base, 1.5));
	throwsType(() => R.statsAt(C.kael.base, "3"));
	throwsType(() => R.statsAt({ ...C.kael.base, hp: 0 }, 1));
	throwsType(() => R.statsAt({ ...C.kael.base, crit: 1.5 }, 1));
	throwsType(() => R.statsAt({ ...C.kael.base, critDmg: 0.9 }, 1));
});
test("stage 1: makeChampion shape and copies", () => {
	const g = R.makeChampion(C.grim);
	assert.equal(g.level, 1);
	assert.equal(g.xp, 0);
	assert.deepEqual(g.stats, { hp: 1800, atk: 110, def: 100, spd: 91, crit: 0.2, critDmg: 1.5 });
	assert.equal(g.hp, 1800);
	assert.deepEqual(g.skills[0].effects, []);
	assert.deepEqual(g.skills[1].effects[0], { stat: "def", pct: 40, turns: 3 });
	assert.equal(g.id, "grim");
	assert.equal(g.affinity, "magic");
	assert.notEqual(g.base, C.grim.base);
	assert.notEqual(g.skills, C.grim.skills);
	assert.notEqual(g.skills[1], C.grim.skills[1]);
	assert.equal(C.grim.skills[0].effects, undefined, "def must not be mutated");
	const n = R.makeChampion(C.nyx, 5);
	assert.equal(n.level, 5);
	assert.deepEqual(n.stats, { hp: 1624, atk: 174, def: 98, spd: 110, crit: 0.35, critDmg: 1.7 });
	assert.equal(n.hp, 1624);
});
test("stage 1: makeChampion validation", () => {
	const bad = (patch) => throwsType(() => R.makeChampion(patch));
	const { id, ...noId } = C.kael;
	bad(noId);
	bad({ ...C.kael, affinity: "fire" });
	bad({ ...C.kael, rarity: "mythic" });
	bad({ ...C.kael, skills: [] });
	bad({ ...C.kael, skills: [{ ...C.kael.skills[0], cooldown: 1 }] });
	bad({ ...C.kael, skills: [C.kael.skills[0], { ...C.kael.skills[1], target: "enemies" }] });
	bad({ ...C.kael, skills: [C.kael.skills[0], { ...C.kael.skills[2], effects: [{ stat: "hp", pct: -30, turns: 2 }] }] });
	bad({ ...C.kael, skills: [C.kael.skills[0], { ...C.kael.skills[2], effects: [{ stat: "def", pct: 0.5, turns: 2 }] }] });
	bad({ ...C.kael, skills: [C.kael.skills[0], { ...C.kael.skills[2], effects: [{ stat: "def", pct: -30, turns: 0 }] }] });
	throwsType(() => R.makeChampion(C.kael, 0));
});
test("stage 1: xpForLevel", () => {
	assert.deepEqual([1, 2, 10, 59].map(R.xpForLevel), [25, 100, 2500, 87025]);
	throwsRange(() => R.xpForLevel(60), "max level");
	throwsType(() => R.xpForLevel(0));
	throwsType(() => R.xpForLevel(61));
	throwsType(() => R.xpForLevel(2.5));
});
test("stage 1: addXp levels up and heals", () => {
	const k = R.makeChampion(C.kael);
	const a = R.addXp(k, 24);
	assert.deepEqual(pick(a, ["level", "xp", "hp"]), { level: 1, xp: 24, hp: 1500 });
	const b = R.addXp(k, 25);
	assert.deepEqual(pick(b, ["level", "xp", "hp"]), { level: 2, xp: 0, hp: 1560 });
	assert.equal(b.stats.hp, 1560);
	const c = R.addXp(k, 200);
	assert.deepEqual(pick(c, ["level", "xp", "hp"]), { level: 3, xp: 75, hp: 1620 });
	const d = R.addXp(R.addXp(k, 1000), 100);
	assert.deepEqual(pick(d, ["level", "xp", "hp"]), { level: 5, xp: 350, hp: 1740 });
	assert.equal(k.level, 1, "input not mutated");
	assert.equal(k.xp, 0);
});
test("stage 1: addXp at the cap and hp rules", () => {
	const k59 = R.makeChampion(C.kael, 59);
	assert.deepEqual(pick(R.addXp(k59, 87024), ["level", "xp"]), { level: 59, xp: 87024 });
	assert.deepEqual(pick(R.addXp(k59, 100000), ["level", "xp", "hp"]), { level: 60, xp: 0, hp: 5040 });
	const hurt = { ...R.makeChampion(C.kael), hp: 700 };
	assert.equal(R.addXp(hurt, 10).hp, 700);
	assert.equal(R.addXp(hurt, 25).hp, 1560);
	throwsType(() => R.addXp(hurt, -1));
	throwsType(() => R.addXp(hurt, 1.5));
	throwsType(() => R.addXp(null, 1));
});

// ---- Stage 2 ----------------------------------------------------------------

test("stage 2: affinityMod triangle", () => {
	assert.equal(R.affinityMod("magic", "spirit"), 1.25);
	assert.equal(R.affinityMod("spirit", "magic"), 0.8);
	assert.equal(R.affinityMod("force", "magic"), 1.25);
	assert.equal(R.affinityMod("spirit", "force"), 1.25);
	assert.equal(R.affinityMod("magic", "force"), 0.8);
	assert.equal(R.affinityMod("force", "spirit"), 0.8);
	assert.equal(R.affinityMod("void", "magic"), 1);
	assert.equal(R.affinityMod("magic", "void"), 1);
	assert.equal(R.affinityMod("force", "force"), 1);
	throwsType(() => R.affinityMod("fire", "magic"));
	throwsType(() => R.affinityMod("magic"));
});
test("stage 2: mitigation", () => {
	assert.equal(R.mitigation(0), 1);
	assert.equal(R.mitigation(100), 0.9090909090909091);
	assert.equal(R.mitigation(250), 0.8);
	assert.equal(R.mitigation(1000), 0.5);
	throwsType(() => R.mitigation(-1));
	throwsType(() => R.mitigation(1.5));
});
test("stage 2: computeDamage examples", () => {
	assert.equal(R.computeDamage({ atk: 130, def: 100, multiplier: 1 }), 118);
	assert.equal(R.computeDamage({ atk: 130, def: 100, multiplier: 1.8, mod: 1.25 }), 265);
	assert.equal(R.computeDamage({ atk: 130, def: 100, multiplier: 1.8, mod: 1.25, crit: true, critDmg: 1.6 }), 425);
	assert.equal(R.computeDamage({ atk: 95, def: 120, multiplier: 0.7, mod: 0.8 }), 47);
	assert.equal(R.computeDamage({ atk: 150, def: 0, multiplier: 2.2, crit: true, critDmg: 1.7 }), 561);
});
test("stage 2: computeDamage floor of 1 and validation", () => {
	assert.equal(R.computeDamage({ atk: 1, def: 5000, multiplier: 0.1 }), 1);
	assert.equal(R.computeDamage({ atk: 100, def: 100, multiplier: 0 }), 1);
	throwsType(() => R.computeDamage({ atk: 0, def: 100, multiplier: 1 }));
	throwsType(() => R.computeDamage({ atk: 100, def: -1, multiplier: 1 }));
	throwsType(() => R.computeDamage({ atk: 100, def: 1, multiplier: 1, mod: 0 }));
	throwsType(() => R.computeDamage({ atk: 100, def: 1, multiplier: 1, crit: "yes" }));
	throwsType(() => R.computeDamage({ atk: 100, def: 1, multiplier: 1, critDmg: 0.5 }));
	throwsType(() => R.computeDamage());
});

// ---- Stage 3 ----------------------------------------------------------------

test("stage 3: nextActor fastest first and meters advance", () => {
	const r = R.nextActor([{ spd: 100, tm: 0, hp: 1 }, { spd: 120, tm: 0, hp: 1 }]);
	assert.equal(r.index, 1);
	near(r.elapsed, 0.8333333333333334);
	near(r.units[0].tm, 83.33333333333334);
	assert.equal(r.units[1].tm, 0);
});
test("stage 3: nextActor ties go to the lowest index", () => {
	const r = R.nextActor([{ spd: 100, tm: 0, hp: 1 }, { spd: 100, tm: 0, hp: 1 }]);
	assert.equal(r.index, 0);
	assert.equal(r.elapsed, 1);
	assert.equal(r.units[1].tm, 100);
});
test("stage 3: nextActor honours existing meter and skips the dead", () => {
	const input = [{ spd: 100, tm: 50, hp: 1 }, { spd: 120, tm: 0, hp: 1 }, { spd: 200, tm: 0, hp: 0 }];
	const r = R.nextActor(input);
	assert.equal(r.index, 0);
	assert.equal(r.elapsed, 0.5);
	near(r.units[1].tm, 60);
	assert.equal(r.units[2].tm, 0);
	assert.equal(input[1].tm, 0, "input not mutated");
	assert.notEqual(r.units, input);
	assert.notEqual(r.units[0], input[0]);
});
test("stage 3: nextActor four speeds", () => {
	const r = R.nextActor([{ spd: 104, tm: 0, hp: 5 }, { spd: 98, tm: 0, hp: 5 }, { spd: 91, tm: 0, hp: 5 }, { spd: 110, tm: 0, hp: 5 }]);
	assert.equal(r.index, 3);
	near(r.elapsed, 0.9090909090909091);
	near(r.units[0].tm, 94.54545454545455);
	near(r.units[1].tm, 89.0909090909091);
	near(r.units[2].tm, 82.72727272727272);
	assert.equal(r.units[3].tm, 0);
});
test("stage 3: nextActor errors", () => {
	throwsType(() => R.nextActor([]));
	throwsType(() => R.nextActor([{ spd: 0, tm: 0, hp: 1 }]));
	throwsType(() => R.nextActor([{ spd: 100, tm: -1, hp: 1 }]));
	throwsType(() => R.nextActor([{ spd: 100, tm: "0", hp: 1 }]));
	throwsRange(() => R.nextActor([{ spd: 100, tm: 0, hp: 0 }]), "no living units");
});

// ---- Stage 4 ----------------------------------------------------------------

const U = () => ({ stats: { atk: 130, def: 90, spd: 104 }, effects: [{ stat: "atk", pct: 25, turns: 2 }, { stat: "atk", pct: -30, turns: 1 }, { stat: "def", pct: -30, turns: 2 }] });

test("stage 4: effectiveStat sums percents and floors", () => {
	assert.equal(R.effectiveStat(U(), "atk"), 123);
	assert.equal(R.effectiveStat(U(), "def"), 63);
	assert.equal(R.effectiveStat(U(), "spd"), 104);
	assert.equal(R.effectiveStat({ stats: { atk: 95 }, effects: [{ stat: "atk", pct: 25, turns: 1 }] }, "atk"), 118);
	assert.equal(R.effectiveStat({ stats: { atk: 50 }, effects: [{ stat: "atk", pct: -100, turns: 1 }] }, "atk"), 1);
	assert.equal(R.effectiveStat({ stats: { atk: 50 } }, "atk"), 50);
	throwsType(() => R.effectiveStat(U(), "hp"));
	throwsType(() => R.effectiveStat(U(), "crit"));
});
test("stage 4: tickEffects", () => {
	const u = U();
	const t = R.tickEffects(u);
	assert.deepEqual(t.effects, [{ stat: "atk", pct: 25, turns: 1 }, { stat: "def", pct: -30, turns: 1 }]);
	assert.equal(u.effects.length, 3, "input not mutated");
	assert.equal(u.effects[0].turns, 2);
	assert.deepEqual(R.tickEffects({ stats: {} }).effects, []);
	assert.deepEqual(R.tickEffects(t).effects, []);
});
test("stage 4: availableSkills and chooseSkill", () => {
	const k = R.makeChampion(C.kael);
	assert.deepEqual(R.availableSkills(k), [0, 1, 2]);
	assert.equal(R.chooseSkill(k), 2);
	assert.deepEqual(R.availableSkills({ ...k, cooldowns: { 1: 2, 2: 0 } }), [0, 2]);
	assert.equal(R.chooseSkill({ ...k, cooldowns: { 1: 2, 2: 0 } }), 2);
	assert.equal(R.chooseSkill({ ...k, cooldowns: { 1: 1, 2: 3 } }), 0);
	throwsType(() => R.availableSkills({ skills: [] }));
});
test("stage 4: chooseTarget", () => {
	assert.equal(R.chooseTarget([{ hp: 5 }, { hp: 3 }, { hp: 3 }]), 1);
	assert.equal(R.chooseTarget([{ hp: 0 }, { hp: 9 }]), 1);
	assert.equal(R.chooseTarget([{ hp: 0 }]), -1);
	assert.equal(R.chooseTarget([]), -1);
	throwsType(() => R.chooseTarget("x"));
});
test("stage 4: rollHit draws once and combines the pieces", () => {
	const k = { ...R.makeChampion(C.kael), effects: [] };
	const g = { ...R.makeChampion(C.grim), effects: [] };
	assert.deepEqual(R.rollHit(k, g, C.kael.skills[0], R.mulberry32(1)), { damage: 147, crit: false, roll: 0.6270739405881613 });
	assert.deepEqual(R.rollHit(k, g, C.kael.skills[2], R.mulberry32(0)), { damage: 425, crit: true, roll: 0.26642920868471265 });
	let calls = 0;
	const counting = () => (calls++, 0.99);
	R.rollHit(k, g, C.kael.skills[0], counting);
	assert.equal(calls, 1);
});
test("stage 4: rollHit uses effective stats and validates rng", () => {
	const k = { ...R.makeChampion(C.kael), effects: [{ stat: "atk", pct: 25, turns: 1 }] };
	const g = { ...R.makeChampion(C.grim), effects: [{ stat: "def", pct: -30, turns: 1 }] };
	assert.equal(R.rollHit(k, g, C.kael.skills[0], R.mulberry32(1)).damage, 189);
	throwsType(() => R.rollHit(k, g, C.kael.skills[0], 5));
});

// ---- Stage 5 ----------------------------------------------------------------

test("stage 5: battle seed 1 outcome and shape", () => {
	const { A, B } = lvl1();
	const b = R.runBattle(A, B, 1);
	assert.deepEqual(Object.keys(b).sort(), ["log", "turns", "units", "winner"]);
	assert.equal(b.winner, "A");
	assert.equal(b.turns, 35);
	assert.equal(b.log.length, 35);
	assert.deepEqual(b.units.map((u) => u.hp), [1103, 0, 0, 0]);
	assert.deepEqual(b.units.map((u) => u.side), [0, 0, 1, 1]);
	assert.equal(A[0].hp, 1500, "teamA not mutated");
	assert.equal(A[1].hp, 1250);
	assert.equal(A[0].tm, undefined);
});
test("stage 5: battle seed 1 opening turns", () => {
	const { A, B } = lvl1();
	const b = R.runBattle(A, B, 1);
	assert.deepEqual(b.log[0], { turn: 1, actor: 3, skill: 2, hits: [{ target: 1, damage: 294, crit: false, killed: false }] });
	assert.deepEqual(b.log[1], { turn: 2, actor: 0, skill: 2, hits: [{ target: 3, damage: 345, crit: true, killed: false }] });
	assert.deepEqual(b.log[2], { turn: 3, actor: 1, skill: 1, hits: [] });
	assert.deepEqual(b.log[3], { turn: 4, actor: 2, skill: 1, hits: [] });
	assert.deepEqual(b.log[4], { turn: 5, actor: 3, skill: 1, hits: [] });
	assert.deepEqual(b.log[5].hits.map((h) => [h.target, h.damage]), [[2, 124], [3, 107]]);
	assert.deepEqual(b.log[34], { turn: 35, actor: 0, skill: 2, hits: [{ target: 2, damage: 265, crit: false, killed: true }] });
});
test("stage 5: battle maxTurns draw keeps cooldowns and effects", () => {
	const { A, B } = lvl1();
	const b = R.runBattle(A, B, 1, 3);
	assert.equal(b.winner, "draw");
	assert.equal(b.turns, 3);
	assert.deepEqual(b.units.map((u) => u.hp), [1500, 956, 1800, 1055]);
	assert.deepEqual(b.units.map((u) => u.cooldowns), [{ 2: 4 }, { 1: 3 }, {}, { 2: 5 }]);
	assert.deepEqual(b.units.map((u) => u.effects), [[{ stat: "atk", pct: 25, turns: 2 }], [{ stat: "atk", pct: 25, turns: 1 }], [], [{ stat: "def", pct: -30, turns: 2 }]]);
});
test("stage 5: duel seed 7", () => {
	const b = R.runBattle([R.makeChampion(C.kael)], [R.makeChampion(C.grim)], 7);
	assert.equal(b.winner, "A");
	assert.equal(b.turns, 14);
	assert.deepEqual(b.units.map((u) => u.hp), [1148, 0]);
	const dmg = b.log.map((t) => (t.hits.length ? `${t.hits[0].damage}${t.hits[0].crit ? "c" : ""}${t.hits[0].killed ? "k" : ""}` : "-"));
	assert.deepEqual(dmg, ["425c", "-", "163c", "88", "142", "88", "147", "88", "425c", "-", "102", "88", "228c", "228ck"]);
	assert.deepEqual(b.log.map((t) => t.actor), [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0]);
});
test("stage 5: self buff applies to the actor and cooldowns count down", () => {
	const b = R.runBattle([R.makeChampion(C.vell)], [R.makeChampion(C.grim)], 3, 5);
	assert.equal(b.winner, "draw");
	assert.deepEqual(b.log.map((t) => t.actor), [0, 1, 0, 1, 0]);
	assert.deepEqual(b.log.map((t) => t.skill), [1, 1, 0, 0, 0]);
	assert.deepEqual(b.log.slice(2).map((t) => [t.hits[0].damage, t.hits[0].crit]), [[82, false], [202, true], [66, false]]);
	assert.deepEqual(b.units[1].effects, [{ stat: "def", pct: 40, turns: 1 }]);
	assert.deepEqual(b.units[0].cooldowns, { 1: 1 });
	assert.deepEqual(b.units[1].cooldowns, { 1: 3 });
});
test("stage 5: battle is deterministic per seed and validates", () => {
	const { A, B } = lvl1();
	const x = R.runBattle(A, B, 11);
	const y = R.runBattle(A, B, 11);
	assert.deepEqual(x, y);
	assert.notDeepEqual(R.runBattle(A, B, 12).log, x.log);
	throwsType(() => R.runBattle([], B, 1));
	throwsType(() => R.runBattle(A, [], 1));
	throwsType(() => R.runBattle(A, B, 1.5));
	throwsType(() => R.runBattle(A, B, 1, 0));
});

// ---- Stage 6 ----------------------------------------------------------------

const pool = () => ({ common: [C.vell, C.grim], rare: [C.vell], epic: [C.kael], legendary: [C.nyx] });

test("stage 6: summon draws in sequence from one generator", () => {
	const r = R.mulberry32(1);
	const ids = [1, 2, 3, 4, 5, 6].map(() => R.summon(r, pool()).id);
	assert.deepEqual(ids, ["vell", "grim", "vell", "grim", "grim", "vell"]);
});
test("stage 6: summon rarity thresholds", () => {
	assert.equal(R.summon(R.mulberry32(307), pool()).id, "nyx");
	assert.equal(R.summon(R.mulberry32(7), pool()).id, "kael");
	const rare = R.summon(R.mulberry32(8), pool());
	assert.equal(rare.id, "vell");
	assert.equal(rare.level, 1);
	assert.equal(rare.hp, 1250);
	throwsRange(() => R.summon(R.mulberry32(307), { ...pool(), legendary: [] }), "empty pool: legendary");
	throwsType(() => R.summon(5, pool()));
	throwsType(() => R.summon(R.mulberry32(1), { common: [] }));
});
test("stage 6: summon returns a fresh champion", () => {
	const r = R.mulberry32(1);
	const c = R.summon(r, pool());
	assert.notEqual(c.base, C.vell.base);
	assert.equal(c.xp, 0);
	assert.deepEqual(c.stats, { hp: 1250, atk: 95, def: 120, spd: 98, crit: 0.15, critDmg: 1.5 });
});
test("stage 6: stageEnemies", () => {
	const s1 = R.stageEnemies(1);
	assert.equal(s1.length, 3);
	assert.deepEqual(s1.map((e) => e.id), ["stage1-enemy0", "stage1-enemy1", "stage1-enemy2"]);
	assert.deepEqual(s1.map((e) => e.name), ["Minion 1", "Minion 2", "Minion 3"]);
	assert.deepEqual(s1.map((e) => e.affinity), ["force", "spirit", "void"]);
	assert.deepEqual(s1.map((e) => e.stats.spd), [90, 95, 100]);
	assert.deepEqual(pick(s1[0].stats, ["hp", "atk", "def", "crit", "critDmg"]), { hp: 340, atk: 46, def: 35, crit: 0.1, critDmg: 1.5 });
	assert.equal(s1[0].level, 1);
	assert.equal(s1[0].rarity, "common");
	assert.deepEqual(s1[0].skills, [{ name: "Strike", multiplier: 1, cooldown: 0, target: "enemy", effects: [] }]);
	const s5 = R.stageEnemies(5);
	assert.equal(s5[1].level, 5);
	assert.deepEqual(pick(s5[1].stats, ["hp", "atk", "def"]), { hp: 580, atk: 81, def: 63 });
	assert.deepEqual(R.stageEnemies(6).map((e) => e.affinity), ["spirit", "void", "magic"]);
	const s61 = R.stageEnemies(61);
	assert.equal(s61[0].level, 60);
	assert.equal(s61[0].stats.hp, 9206);
	throwsType(() => R.stageEnemies(0));
	throwsType(() => R.stageEnemies(1.5));
});
test("stage 6: resolveStage win", () => {
	const team = [R.makeChampion(C.kael), R.makeChampion(C.vell), R.makeChampion(C.grim), R.makeChampion(C.nyx)];
	const r = R.resolveStage(team, 1, 3);
	assert.deepEqual(Object.keys(r).sort(), ["battle", "rewards", "team", "won"]);
	assert.equal(r.won, true);
	assert.deepEqual(r.rewards, { silver: 100, xp: 50 });
	assert.equal(r.battle.turns, 13);
	assert.equal(r.battle.winner, "A");
	assert.deepEqual(r.team.map((c) => [c.level, c.xp, c.hp]), [[2, 25, 1560], [2, 25, 1300], [2, 25, 1872], [2, 25, 1456]]);
	assert.deepEqual(r.battle.units.map((u) => u.hp), [1500, 1066, 1800, 1400, 0, 0, 0]);
	assert.equal(team[0].level, 1, "input not mutated");
});
test("stage 6: resolveStage loss and healing", () => {
	const r = R.resolveStage([R.makeChampion(C.vell)], 9, 3);
	assert.equal(r.won, false);
	assert.deepEqual(r.rewards, { silver: 0, xp: 0 });
	assert.equal(r.battle.turns, 15);
	assert.deepEqual(r.team.map((c) => [c.level, c.xp, c.hp]), [[1, 0, 1250]]);
	const hurt = [R.makeChampion(C.kael), R.makeChampion(C.vell), R.makeChampion(C.grim), R.makeChampion(C.nyx)].map((c) => ({ ...c, hp: 1 }));
	const h = R.resolveStage(hurt, 1, 3);
	assert.equal(h.won, true);
	assert.deepEqual(h.battle.units.slice(0, 4).map((u) => u.hp), [1500, 1066, 1800, 1400]);
	assert.equal(hurt[0].hp, 1, "input not mutated");
	throwsType(() => R.resolveStage([], 1, 3));
	throwsType(() => R.resolveStage(hurt, 0, 3));
	throwsType(() => R.resolveStage(hurt, 1, 1.5));
});
