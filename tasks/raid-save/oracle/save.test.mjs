import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./src/raid.mjs";
import * as S from "./src/save.mjs";

const C = R.SAMPLE_CHAMPIONS;
const throwsType = (fn, prefix = "invalid argument") => assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
const throwsRange = (fn, prefix) => assert.throws(fn, (e) => e instanceof RangeError && e.message.startsWith(prefix), `expected RangeError "${prefix}..."`);
const state1 = () => ({ roster: [R.makeChampion(C.kael), R.addXp(R.makeChampion(C.vell), 30)], silver: 1200, stage: 3, seed: 7 });

test("constants", () => {
	assert.equal(S.SAVE_VERSION, 1);
	assert.equal(S.SAVE_PREFIX, "RAID1");
});
test("stage 1: canonical sorts keys, drops undefined props, no whitespace", () => {
	assert.equal(S.canonical({ b: 1, a: [true, null, "x", { z: 1, y: 2 }], c: undefined }), '{"a":[true,null,"x",{"y":2,"z":1}],"b":1}');
	assert.equal(S.canonical([1.5, -0, 1e21, 0.1]), "[1.5,0,1e+21,0.1]");
	assert.equal(S.canonical("é"), '"é"');
	assert.equal(S.canonical({}), "{}");
	assert.equal(S.canonical({ "b c": { a: [] } }), '{"b c":{"a":[]}}');
	assert.equal(S.canonical(null), "null");
});
test("stage 1: canonical rejects non-JSON values", () => {
	throwsType(() => S.canonical(NaN));
	throwsType(() => S.canonical({ a: Infinity }));
	throwsType(() => S.canonical([undefined]));
	throwsType(() => S.canonical(() => 1));
	throwsType(() => S.canonical(undefined));
	throwsType(() => S.canonical({ a: 1n }));
});
test("stage 1: fnv1a", () => {
	assert.deepEqual(["", "a", "hello", "raid", "The quick brown fox"].map(S.fnv1a), ["811c9dc5", "e40c292c", "4f9f2cab", "93a3c591", "ae4d67e2"]);
	assert.equal(S.fnv1a("é"), S.fnv1a("é"));
	assert.notEqual(S.fnv1a("é"), S.fnv1a("e"));
	assert.match(S.fnv1a("anything"), /^[0-9a-f]{8}$/);
	throwsType(() => S.fnv1a(5));
	throwsType(() => S.fnv1a());
});
test("stage 2: saveGame exact strings", () => {
	assert.equal(S.saveGame({ roster: [], silver: 0, stage: 1, seed: 0 }), 'RAID1:f1cb777e:{"roster":[],"seed":0,"silver":0,"stage":1,"version":1}');
	const s = S.saveGame(state1());
	assert.equal(s.length, 913);
	assert.equal(s.split(":")[1], "ae340678");
	assert.ok(s.startsWith('RAID1:ae340678:{"roster":[{"affinity":"force","base":{"atk":'));
	assert.ok(!s.includes('"stats"'), "stats are derived, not stored");
	assert.ok(s.includes('"effects":[]'), "skills are stored normalised");
});
test("stage 2: saveGame validation", () => {
	const st = state1();
	throwsType(() => S.saveGame({ ...st, silver: -1 }));
	throwsType(() => S.saveGame({ ...st, stage: 0 }));
	throwsType(() => S.saveGame({ ...st, seed: 1.5 }));
	throwsType(() => S.saveGame({ ...st, roster: "x" }));
	throwsType(() => S.saveGame({ ...st, roster: [{ ...st.roster[0], hp: 1501 }] }));
	throwsType(() => S.saveGame({ ...st, roster: [{ ...st.roster[0], level: 61 }] }));
	throwsType(() => S.saveGame({ ...st, roster: [st.roster[0], st.roster[0]] }));
	throwsType(() => S.saveGame({ ...st, roster: [{ ...st.roster[0], affinity: "fire" }] }));
	throwsType(() => S.saveGame(null));
	assert.equal(st.roster[0].hp, 1500, "input untouched");
});
test("stage 2: loadGame round trip", () => {
	const s = S.saveGame(state1());
	const l = S.loadGame(s);
	assert.deepEqual(Object.keys(l).sort(), ["roster", "seed", "silver", "stage"]);
	assert.deepEqual([l.silver, l.stage, l.seed], [1200, 3, 7]);
	assert.deepEqual(l.roster.map((c) => [c.id, c.level, c.xp, c.hp, c.stats.hp]), [["kael", 1, 0, 1500, 1500], ["vell", 2, 5, 1300, 1300]]);
	assert.deepEqual(l.roster[1].stats, { hp: 1300, atk: 98, def: 124, spd: 98, crit: 0.15, critDmg: 1.5 });
	assert.equal(S.saveGame(l), s);
	const hurt = state1();
	hurt.roster[0] = { ...hurt.roster[0], hp: 10 };
	const hs = S.saveGame(hurt);
	assert.notEqual(hs, s);
	assert.equal(S.loadGame(hs).roster[0].hp, 10);
});
test("stage 2: loadGame errors", () => {
	const s = S.saveGame(state1());
	throwsRange(() => S.loadGame(s.replace('"silver":1200', '"silver":9999')), "checksum mismatch: expected 4aab38bd, found ae340678");
	throwsRange(() => S.loadGame("RAID2:" + s.slice(6)), "unsupported version: prefix RAID2");
	throwsRange(() => S.loadGame("nope"), "malformed save");
	throwsRange(() => S.loadGame(""), "malformed save");
	const notJson = "{oops";
	throwsRange(() => S.loadGame(`RAID1:${S.fnv1a(notJson)}:${notJson}`), "malformed save");
	const v2 = S.canonical({ version: 2, roster: [], silver: 0, stage: 1, seed: 1 });
	throwsRange(() => S.loadGame(`RAID1:${S.fnv1a(v2)}:${v2}`), "unsupported version: 2");
	const badHp = S.canonical({ version: 1, roster: [{ ...state1().roster[0], hp: 99999 }], silver: 0, stage: 1, seed: 1 });
	throwsType(() => S.loadGame(`RAID1:${S.fnv1a(badHp)}:${badHp}`));
	throwsType(() => S.loadGame(42));
});
test("stage 3: diffSaves", () => {
	const s = S.saveGame(state1());
	assert.deepEqual(S.diffSaves(s, s), {});
	const st2 = { roster: [R.addXp(state1().roster[0], 25), R.makeChampion(C.nyx)], silver: 1300, stage: 4, seed: 7 };
	assert.deepEqual(S.diffSaves(s, S.saveGame(st2)), { silver: [1200, 1300], stage: [3, 4], roster: { added: ["nyx"], removed: ["vell"], leveled: [{ id: "kael", from: 1, to: 2 }] } });
	const st3 = { ...state1(), seed: 8 };
	assert.deepEqual(S.diffSaves(s, S.saveGame(st3)), { seed: [7, 8] });
	const st4 = { ...state1(), roster: [...state1().roster, R.makeChampion(C.grim)] };
	assert.deepEqual(S.diffSaves(s, S.saveGame(st4)), { roster: { added: ["grim"], removed: [], leveled: [] } });
	throwsRange(() => S.diffSaves(s, "nope"), "malformed save");
});
