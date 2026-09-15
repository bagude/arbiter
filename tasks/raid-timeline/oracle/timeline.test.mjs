import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./src/raid.mjs";
import * as T from "./src/timeline.mjs";

const C = R.SAMPLE_CHAMPIONS;
const throwsType = (fn, prefix = "invalid argument") => assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
const teams = () => ({ A: [R.makeChampion(C.kael), R.makeChampion(C.vell)], B: [R.makeChampion(C.grim), R.makeChampion(C.nyx)] });
const units0 = () => [{ side: 0, hp: 1500 }, { side: 0, hp: 1250 }, { side: 1, hp: 1800 }, { side: 1, hp: 1400 }];
const F = (t, unit, prop, value) => ({ t, unit, prop, value });
const battle1 = () => {
	const { A, B } = teams();
	return R.runBattle(A, B, 1);
};

test("constants", () => {
	assert.deepEqual([T.TURN_MS, T.LUNGE_MS, T.HIT_GAP_MS, T.FLASH_MS, T.LUNGE_X], [600, 150, 100, 80, 0.6]);
});
test("stage 1: turnTimeline single hit", () => {
	const r = T.turnTimeline(battle1().log[0], units0());
	assert.deepEqual(Object.keys(r), ["frames", "duration", "hp"]);
	assert.deepEqual(r.frames, [F(0, 3, "offsetX", -0.6), F(150, 3, "offsetX", 0), F(150, 1, "flash", "hit"), F(150, 1, "hp", 956), F(230, 1, "flash", null)]);
	assert.equal(r.duration, 600);
	assert.deepEqual(r.hp, [1500, 956, 1800, 1400]);
});
test("stage 1: turnTimeline two hits and no hits", () => {
	const b = battle1();
	const r = T.turnTimeline(b.log[5], [{ side: 0, hp: 1500 }, { side: 0, hp: 956 }, { side: 1, hp: 1800 }, { side: 1, hp: 1055 }]);
	assert.deepEqual(r.frames, [F(0, 0, "offsetX", 0.6), F(150, 0, "offsetX", 0), F(150, 2, "flash", "hit"), F(150, 2, "hp", 1676), F(230, 2, "flash", null), F(250, 3, "flash", "hit"), F(250, 3, "hp", 948), F(330, 3, "flash", null)]);
	assert.equal(r.duration, 600);
	assert.deepEqual(r.hp, [1500, 956, 1676, 948]);
	const u = units0();
	const n = T.turnTimeline(b.log[2], u);
	assert.deepEqual(n.frames, [F(0, 1, "offsetX", 0.6), F(150, 1, "offsetX", 0)]);
	assert.equal(n.duration, 600);
	assert.deepEqual(n.hp, [1500, 1250, 1800, 1400]);
	assert.notEqual(n.hp, u);
	assert.equal(u[1].hp, 1250, "input untouched");
});
test("stage 1: turnTimeline kill, long turns, running hp", () => {
	const k = T.turnTimeline({ turn: 9, actor: 2, skill: 0, hits: [{ target: 1, damage: 500, crit: true, killed: true }] }, [{ side: 0, hp: 1500 }, { side: 0, hp: 120 }, { side: 1, hp: 1800 }, { side: 1, hp: 1055 }]);
	assert.deepEqual(k.frames, [F(0, 2, "offsetX", -0.6), F(150, 2, "offsetX", 0), F(150, 1, "flash", "crit"), F(150, 1, "hp", 0), F(230, 1, "flash", null), F(230, 1, "visible", false)]);
	assert.deepEqual(k.hp, [1500, 0, 1800, 1055]);
	const big = T.turnTimeline({ turn: 1, actor: 0, skill: 1, hits: [0, 1, 2, 3, 4].map((i) => ({ target: 2 + (i % 2), damage: 1, crit: false, killed: false })) }, units0());
	assert.equal(big.frames.length, 17);
	assert.deepEqual(big.frames[16], F(630, 2, "flash", null));
	assert.equal(big.duration, 730);
	assert.deepEqual(big.hp, [1500, 1250, 1797, 1398]);
	const same = T.turnTimeline({ turn: 1, actor: 0, skill: 0, hits: [{ target: 2, damage: 1000, crit: false, killed: false }, { target: 2, damage: 1000, crit: false, killed: true }] }, units0());
	assert.deepEqual(same.frames.filter((f) => f.prop === "hp").map((f) => f.value), [800, 0]);
	assert.deepEqual(same.frames[same.frames.length - 1], F(330, 2, "visible", false));
});
test("stage 1: turnTimeline validation", () => {
	const e = battle1().log[0];
	throwsType(() => T.turnTimeline(e, []));
	throwsType(() => T.turnTimeline(e, [{ side: 2, hp: 1 }]));
	throwsType(() => T.turnTimeline(e, [{ side: 0, hp: -1 }]));
	throwsType(() => T.turnTimeline({ ...e, actor: 4 }, units0()));
	throwsType(() => T.turnTimeline({ ...e, hits: [{ target: 9, damage: 1, crit: false, killed: false }] }, units0()));
	throwsType(() => T.turnTimeline({ ...e, hits: [{ target: 1, damage: 1.5, crit: false, killed: false }] }, units0()));
	throwsType(() => T.turnTimeline({ ...e, hits: [{ target: 1, damage: 1, crit: "yes", killed: false }] }, units0()));
	throwsType(() => T.turnTimeline(null, units0()));
});
test("stage 2: battleTimeline whole battle", () => {
	const tl = T.battleTimeline(battle1(), units0());
	assert.deepEqual(Object.keys(tl), ["frames", "turns", "total"]);
	assert.equal(tl.total, 21000);
	assert.equal(tl.frames.length, 163);
	assert.equal(tl.turns.length, 35);
	assert.deepEqual(tl.turns[6], { turn: 7, start: 3600, duration: 600 });
	assert.deepEqual(tl.frames[5], { t: 600, unit: 0, prop: "offsetX", value: 0.6, turn: 2 });
	assert.deepEqual(tl.frames[0], { t: 0, unit: 3, prop: "offsetX", value: -0.6, turn: 1 });
});
test("stage 2: battleTimeline three turns exact", () => {
	const { A, B } = teams();
	const tl = T.battleTimeline(R.runBattle(A, B, 1, 3), units0());
	assert.equal(tl.total, 1800);
	assert.deepEqual(tl.turns, [{ turn: 1, start: 0, duration: 600 }, { turn: 2, start: 600, duration: 600 }, { turn: 3, start: 1200, duration: 600 }]);
	assert.deepEqual(tl.frames.map((f) => [f.t, f.turn, f.unit, f.prop, f.value]), [[0, 1, 3, "offsetX", -0.6], [150, 1, 3, "offsetX", 0], [150, 1, 1, "flash", "hit"], [150, 1, 1, "hp", 956], [230, 1, 1, "flash", null], [600, 2, 0, "offsetX", 0.6], [750, 2, 0, "offsetX", 0], [750, 2, 3, "flash", "crit"], [750, 2, 3, "hp", 1055], [830, 2, 3, "flash", null], [1200, 3, 1, "offsetX", 0.6], [1350, 3, 1, "offsetX", 0]]);
});
test("stage 2: battleTimeline long turns shift later starts; validation", () => {
	const log = [{ turn: 1, actor: 0, skill: 1, hits: [0, 1, 2, 3, 4].map((i) => ({ target: 2 + (i % 2), damage: 1, crit: false, killed: false })) }, { turn: 2, actor: 2, skill: 0, hits: [] }];
	const tl = T.battleTimeline({ log }, units0());
	assert.deepEqual(tl.turns, [{ turn: 1, start: 0, duration: 730 }, { turn: 2, start: 730, duration: 600 }]);
	assert.equal(tl.total, 1330);
	assert.deepEqual(tl.frames.slice(-2).map((f) => [f.t, f.turn]), [[730, 2], [880, 2]]);
	assert.deepEqual(T.battleTimeline({ log: [] }, units0()), { frames: [], turns: [], total: 0 });
	throwsType(() => T.battleTimeline({}, units0()));
	throwsType(() => T.battleTimeline({ log }, []));
});
test("stage 3: stateAt", () => {
	const tl = T.battleTimeline(battle1(), units0());
	const rest = (hp) => ({ offsetX: 0, flash: null, hp, visible: true });
	assert.deepEqual(T.stateAt(tl, units0(), 0), [rest(1500), rest(1250), rest(1800), { offsetX: -0.6, flash: null, hp: 1400, visible: true }]);
	assert.deepEqual(T.stateAt(tl, units0(), 100)[3], { offsetX: -0.6, flash: null, hp: 1400, visible: true });
	const s750 = T.stateAt(tl, units0(), 750);
	assert.deepEqual(s750[1], rest(956));
	assert.deepEqual(s750[3], { offsetX: 0, flash: "crit", hp: 1055, visible: true });
	assert.deepEqual(T.stateAt(tl, units0(), 1000)[3], rest(1055));
	const end = T.stateAt(tl, units0(), tl.total);
	assert.deepEqual(end.map((s) => s.hp), [1103, 0, 0, 0]);
	assert.deepEqual(end.map((s) => s.visible), [true, false, false, false]);
	assert.deepEqual(Object.keys(end[0]), ["offsetX", "flash", "hp", "visible"]);
	assert.deepEqual(T.stateAt({ frames: [] }, [{ side: 0, hp: 0 }, { side: 1, hp: 5 }], 0), [{ offsetX: 0, flash: null, hp: 0, visible: false }, { offsetX: 0, flash: null, hp: 5, visible: true }]);
	throwsType(() => T.stateAt(tl, units0(), -1));
	throwsType(() => T.stateAt(tl, units0(), NaN));
	throwsType(() => T.stateAt({}, units0(), 0));
});
test("stage 3: turnAt", () => {
	const tl = T.battleTimeline(battle1(), units0());
	assert.deepEqual([0, 599, 600, 1199, 1200, 20999, 21000, 99999].map((t) => T.turnAt(tl, t)), [1, 1, 2, 2, 3, 35, null, null]);
	assert.equal(T.turnAt({ turns: [] }, 0), null);
	throwsType(() => T.turnAt(tl, -5));
	throwsType(() => T.turnAt({ frames: [] }, 0));
});
