// Animation keyframes for a raid battle log. See README.md.
// The constants below are given data: keep them as they are.

export const TURN_MS = 600;
export const LUNGE_MS = 150;
export const HIT_GAP_MS = 100;
export const FLASH_MS = 80;
export const LUNGE_X = 0.6;

// Stage 1: keyframes for one log entry.
export function turnTimeline(entry, units) {
	throw new Error("not implemented");
}

// Stage 2: the whole battle on an absolute clock.
export function battleTimeline(battle, initialUnits) {
	throw new Error("not implemented");
}

// Stage 3: the animated state at a time.
export function stateAt(timeline, initialUnits, t) {
	throw new Error("not implemented");
}
export function turnAt(timeline, t) {
	throw new Error("not implemented");
}
