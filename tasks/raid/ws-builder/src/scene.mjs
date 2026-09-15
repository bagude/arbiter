// Stage 7: a three.js scene graph for a battle state. Must build in Node (no renderer here).
import * as THREE from "./vendor/three.module.js";

export const AFFINITY_COLORS = { magic: 0x3b82f6, force: 0xef4444, spirit: 0x22c55e, void: 0x8b5cf6 };

export function unitPosition(side, i, n) {
	throw new Error("not implemented");
}
export function makeCamera(aspect) {
	throw new Error("not implemented");
}
export function buildScene(units) {
	throw new Error("not implemented");
}
export function updateScene(scene, units) {
	throw new Error("not implemented");
}
