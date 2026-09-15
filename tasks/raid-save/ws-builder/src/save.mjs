// Save files for the raid core. See README.md.
// The constants below are given data: keep them as they are.

export const SAVE_VERSION = 1;
export const SAVE_PREFIX = "RAID1";

// Stage 1: canonical JSON and checksum.
export function canonical(value) {
	throw new Error("not implemented");
}
export function fnv1a(str) {
	throw new Error("not implemented");
}

// Stage 2: save and load.
export function saveGame(state) {
	throw new Error("not implemented");
}
export function loadGame(text) {
	throw new Error("not implemented");
}

// Stage 3: diffs.
export function diffSaves(a, b) {
	throw new Error("not implemented");
}
