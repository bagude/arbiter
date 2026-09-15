// Reference scene builder for the `raid` task: a three.js scene graph for a battle
// state. Structural only (no renderer) so it can be built and inspected in Node.
import * as THREE from "./vendor/three.module.js";

export const AFFINITY_COLORS = { magic: 0x3b82f6, force: 0xef4444, spirit: 0x22c55e, void: 0x8b5cf6 };
export const SIDE_X = [-4, 4];
export const LANE_GAP = 2.5;

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function unitPosition(side, i, n) {
	if (side !== 0 && side !== 1) throw inv("side must be 0 or 1");
	if (!Number.isInteger(n) || n < 1) throw inv("n must be an integer >= 1");
	if (!Number.isInteger(i) || i < 0 || i >= n) throw inv("i must be an integer in 0..n-1");
	return [SIDE_X[side], 0, (i - (n - 1) / 2) * LANE_GAP];
}

function validateUnits(units) {
	if (!Array.isArray(units) || units.length === 0) throw inv("units must be a non-empty array");
	units.forEach((u, i) => {
		if (!isObj(u)) throw inv(`units[${i}] must be an object`);
		if (u.side !== 0 && u.side !== 1) throw inv(`units[${i}].side must be 0 or 1`);
		if (typeof u.hp !== "number" || !Number.isFinite(u.hp) || u.hp < 0) throw inv(`units[${i}].hp must be a number >= 0`);
		if (!isObj(u.stats) || !Number.isInteger(u.stats.hp) || u.stats.hp < 1) throw inv(`units[${i}].stats.hp must be an integer >= 1`);
		if (!(u.affinity in AFFINITY_COLORS)) throw inv(`units[${i}].affinity is invalid`);
	});
}

export function makeCamera(aspect) {
	if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0) throw inv("aspect must be a finite number > 0");
	const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 100);
	camera.name = "camera";
	camera.position.set(0, 9, 13);
	camera.lookAt(0, 0, 0);
	return camera;
}

export function buildScene(units) {
	validateUnits(units);
	const scene = new THREE.Scene();
	scene.name = "raid";
	scene.background = new THREE.Color(0x0b1020);

	const arena = new THREE.Group();
	arena.name = "arena";
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x1f2937 }));
	floor.name = "floor";
	floor.rotation.x = -Math.PI / 2;
	arena.add(floor);
	scene.add(arena);

	const ambient = new THREE.AmbientLight(0xffffff, 0.6);
	ambient.name = "ambient";
	scene.add(ambient);
	const sun = new THREE.DirectionalLight(0xffffff, 1.0);
	sun.name = "sun";
	sun.position.set(5, 10, 5);
	scene.add(sun);

	const sides = [new THREE.Group(), new THREE.Group()];
	sides[0].name = "side-0";
	sides[1].name = "side-1";
	const counts = [units.filter((u) => u.side === 0).length, units.filter((u) => u.side === 1).length];
	const placed = [0, 0];
	units.forEach((u, index) => {
		const group = new THREE.Group();
		group.name = `unit-${index}`;
		group.userData = { id: u.id, index, side: u.side };
		const [x, y, z] = unitPosition(u.side, placed[u.side]++, counts[u.side]);
		group.position.set(x, y, z);
		const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 1), new THREE.MeshStandardMaterial({ color: AFFINITY_COLORS[u.affinity] }));
		body.name = "body";
		body.position.y = 0.9;
		group.add(body);
		const hpbar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
		hpbar.name = "hpbar";
		hpbar.position.y = 2.2;
		hpbar.scale.x = u.hp / u.stats.hp;
		group.add(hpbar);
		group.visible = u.hp > 0;
		sides[u.side].add(group);
	});
	scene.add(sides[0]);
	scene.add(sides[1]);
	return scene;
}

export function updateScene(scene, units) {
	if (!scene || typeof scene.getObjectByName !== "function") throw inv("scene must be a three.js Object3D");
	validateUnits(units);
	units.forEach((u, index) => {
		const group = scene.getObjectByName(`unit-${index}`);
		if (!group) throw inv(`scene has no unit-${index}`);
		const hpbar = group.getObjectByName("hpbar");
		if (!hpbar) throw inv(`unit-${index} has no hpbar`);
		hpbar.scale.x = u.hp / u.stats.hp;
		group.visible = u.hp > 0;
	});
	return scene;
}
