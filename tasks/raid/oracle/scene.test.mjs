import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as R from "./src/raid.mjs";
import * as S from "./src/scene.mjs";

const C = R.SAMPLE_CHAMPIONS;
const throwsType = (fn, prefix = "invalid argument") => assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
const near = (a, b, tol = 1e-12) => assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `|${a} - ${b}| > ${tol}`);

// Units for the scene tests are built from the spec's shapes directly, so the scene
// module is graded on its own even when stage 5 is incomplete.
const units4 = () => [
	{ id: "kael", side: 0, hp: 1500, stats: { hp: 1500 }, affinity: "force" },
	{ id: "vell", side: 0, hp: 956, stats: { hp: 1250 }, affinity: "spirit" },
	{ id: "grim", side: 1, hp: 1800, stats: { hp: 1800 }, affinity: "magic" },
	{ id: "nyx", side: 1, hp: 1055, stats: { hp: 1400 }, affinity: "void" },
];

test("stage 7: AFFINITY_COLORS", () => {
	assert.deepEqual(S.AFFINITY_COLORS, { magic: 0x3b82f6, force: 0xef4444, spirit: 0x22c55e, void: 0x8b5cf6 });
});
test("stage 7: unitPosition", () => {
	assert.deepEqual(S.unitPosition(0, 0, 1), [-4, 0, 0]);
	assert.deepEqual(S.unitPosition(0, 0, 2), [-4, 0, -1.25]);
	assert.deepEqual(S.unitPosition(0, 1, 2), [-4, 0, 1.25]);
	assert.deepEqual(S.unitPosition(1, 0, 3), [4, 0, -2.5]);
	assert.deepEqual(S.unitPosition(1, 2, 3), [4, 0, 2.5]);
	assert.deepEqual(S.unitPosition(1, 1, 4), [4, 0, -1.25]);
	throwsType(() => S.unitPosition(2, 0, 1));
	throwsType(() => S.unitPosition(0, 1, 1));
	throwsType(() => S.unitPosition(0, 0, 0));
});
test("stage 7: makeCamera", () => {
	const cam = S.makeCamera(1.5);
	assert.equal(cam.type, "PerspectiveCamera");
	assert.equal(cam.name, "camera");
	assert.equal(cam.fov, 50);
	assert.equal(cam.aspect, 1.5);
	assert.equal(cam.near, 0.1);
	assert.equal(cam.far, 100);
	assert.deepEqual(cam.position.toArray(), [0, 9, 13]);
	near(cam.rotation.x, -0.605545, 1e-5);
	throwsType(() => S.makeCamera(0));
	throwsType(() => S.makeCamera("1"));
});
test("stage 7: buildScene top-level structure", () => {
	const sc = S.buildScene(units4());
	assert.equal(sc.type, "Scene");
	assert.equal(sc.name, "raid");
	assert.equal(sc.background.getHex(), 0x0b1020);
	assert.deepEqual(sc.children.map((o) => [o.name, o.type]), [["arena", "Group"], ["ambient", "AmbientLight"], ["sun", "DirectionalLight"], ["side-0", "Group"], ["side-1", "Group"]]);
	const floor = sc.getObjectByName("floor");
	assert.equal(floor.type, "Mesh");
	assert.equal(floor.parent.name, "arena");
	assert.equal(floor.geometry.type, "PlaneGeometry");
	assert.deepEqual([floor.geometry.parameters.width, floor.geometry.parameters.height], [20, 20]);
	near(floor.rotation.x, -Math.PI / 2);
	assert.deepEqual(sc.getObjectByName("sun").position.toArray(), [5, 10, 5]);
});
test("stage 7: buildScene unit groups, positions, colours, hp bars", () => {
	const sc = S.buildScene(units4());
	assert.deepEqual(sc.getObjectByName("side-0").children.map((o) => o.name), ["unit-0", "unit-1"]);
	assert.deepEqual(sc.getObjectByName("side-1").children.map((o) => o.name), ["unit-2", "unit-3"]);
	const pos = (k) => sc.getObjectByName(`unit-${k}`).position.toArray();
	assert.deepEqual(pos(0), [-4, 0, -1.25]);
	assert.deepEqual(pos(1), [-4, 0, 1.25]);
	assert.deepEqual(pos(2), [4, 0, -1.25]);
	assert.deepEqual(pos(3), [4, 0, 1.25]);
	const g1 = sc.getObjectByName("unit-1");
	assert.deepEqual(g1.userData, { id: "vell", index: 1, side: 0 });
	assert.deepEqual(g1.children.map((o) => [o.name, o.type]), [["body", "Mesh"], ["hpbar", "Mesh"]]);
	const body = g1.getObjectByName("body");
	assert.equal(body.geometry.type, "BoxGeometry");
	assert.deepEqual([body.geometry.parameters.width, body.geometry.parameters.height, body.geometry.parameters.depth], [1, 1.8, 1]);
	assert.equal(body.material.type, "MeshStandardMaterial");
	assert.equal(body.material.color.getHex(), 0x22c55e);
	assert.equal(body.position.y, 0.9);
	const bar = g1.getObjectByName("hpbar");
	assert.deepEqual([bar.geometry.parameters.width, bar.geometry.parameters.height, bar.geometry.parameters.depth], [1.2, 0.12, 0.12]);
	assert.equal(bar.position.y, 2.2);
	near(bar.scale.x, 0.7648);
	near(sc.getObjectByName("unit-3").getObjectByName("hpbar").scale.x, 0.7535714285714286);
	assert.equal(sc.getObjectByName("unit-0").getObjectByName("hpbar").scale.x, 1);
	assert.equal(sc.getObjectByName("unit-0").getObjectByName("body").material.color.getHex(), 0xef4444);
	assert.equal(sc.getObjectByName("unit-3").getObjectByName("body").material.color.getHex(), 0x8b5cf6);
	assert.equal(sc.getObjectByName("unit-2").getObjectByName("body").material.color.getHex(), 0x3b82f6);
});
test("stage 7: buildScene uneven sides and dead units", () => {
	const u = [
		{ id: "a", side: 0, hp: 10, stats: { hp: 10 }, affinity: "magic" },
		{ id: "b", side: 1, hp: 0, stats: { hp: 10 }, affinity: "magic" },
		{ id: "c", side: 1, hp: 5, stats: { hp: 10 }, affinity: "force" },
		{ id: "d", side: 1, hp: 10, stats: { hp: 10 }, affinity: "void" },
	];
	const sc = S.buildScene(u);
	assert.deepEqual(sc.getObjectByName("unit-0").position.toArray(), [-4, 0, 0]);
	assert.deepEqual(sc.getObjectByName("unit-1").position.toArray(), [4, 0, -2.5]);
	assert.deepEqual(sc.getObjectByName("unit-2").position.toArray(), [4, 0, 0]);
	assert.deepEqual(sc.getObjectByName("unit-3").position.toArray(), [4, 0, 2.5]);
	assert.equal(sc.getObjectByName("unit-1").visible, false);
	assert.equal(sc.getObjectByName("unit-2").visible, true);
	assert.equal(sc.getObjectByName("unit-1").getObjectByName("hpbar").scale.x, 0);
	assert.equal(sc.getObjectByName("unit-2").getObjectByName("hpbar").scale.x, 0.5);
	assert.deepEqual(sc.getObjectByName("unit-3").userData, { id: "d", index: 3, side: 1 });
});
test("stage 7: buildScene validation", () => {
	throwsType(() => S.buildScene([]));
	throwsType(() => S.buildScene([{ id: "a", side: 2, hp: 1, stats: { hp: 1 }, affinity: "magic" }]));
	throwsType(() => S.buildScene([{ id: "a", side: 0, hp: -1, stats: { hp: 1 }, affinity: "magic" }]));
	throwsType(() => S.buildScene([{ id: "a", side: 0, hp: 1, stats: { hp: 1 }, affinity: "fire" }]));
});
test("stage 7: updateScene", () => {
	const u = units4();
	const sc = S.buildScene(u);
	const later = u.map((x, k) => (k === 1 ? { ...x, hp: 0 } : { ...x, hp: Math.floor(x.stats.hp / 2) }));
	const same = S.updateScene(sc, later);
	assert.equal(same, sc);
	assert.deepEqual(later.map((x, k) => [sc.getObjectByName(`unit-${k}`).visible, sc.getObjectByName(`unit-${k}`).getObjectByName("hpbar").scale.x]), [[true, 0.5], [false, 0], [true, 0.5], [true, 0.5]]);
	const back = S.updateScene(sc, u);
	assert.equal(back.getObjectByName("unit-1").visible, true);
	near(back.getObjectByName("unit-1").getObjectByName("hpbar").scale.x, 0.7648);
	throwsType(() => S.updateScene(sc, [...u, { id: "e", side: 0, hp: 1, stats: { hp: 1 }, affinity: "magic" }]));
	throwsType(() => S.updateScene(sc, []));
});
test("stage 7: scene from a real battle state", () => {
	const A = [R.makeChampion(C.kael), R.makeChampion(C.vell)];
	const B = [R.makeChampion(C.grim), R.makeChampion(C.nyx)];
	const b = R.runBattle(A, B, 1, 3);
	const sc = S.buildScene(b.units);
	near(sc.getObjectByName("unit-1").getObjectByName("hpbar").scale.x, 956 / 1250);
	near(sc.getObjectByName("unit-3").getObjectByName("hpbar").scale.x, 1055 / 1400);
	const end = R.runBattle(A, B, 1);
	S.updateScene(sc, end.units);
	assert.deepEqual(end.units.map((x, k) => sc.getObjectByName(`unit-${k}`).visible), [true, false, false, false]);
});
test("stage 7: index.html wires the modules and a renderer", () => {
	assert.ok(fs.existsSync("src/index.html"), "src/index.html missing");
	const html = fs.readFileSync("src/index.html", "utf8");
	assert.match(html, /<script[^>]*type\s*=\s*["']module["']/i, "needs a module script");
	assert.match(html, /["']\.\/raid\.mjs["']/, "must import ./raid.mjs");
	assert.match(html, /["']\.\/scene\.mjs["']/, "must import ./scene.mjs");
	for (const word of ["WebGLRenderer", "runBattle", "updateScene", "requestAnimationFrame"]) assert.ok(html.includes(word), `must mention ${word}`);
	assert.doesNotMatch(html, /<script[^>]*src\s*=\s*["']https?:/i, "no remote scripts");
	assert.doesNotMatch(html, /import[^;]*["']https?:\/\/[^"']*["']/i, "no remote imports");
});
