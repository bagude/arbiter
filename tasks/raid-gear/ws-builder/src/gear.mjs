// Artifacts and equipment for the raid core. See README.md.
// The constants below are given data: keep them as they are.

export const SLOTS = ["weapon", "helmet", "shield", "gloves", "chest", "boots"];
export const FLAT_STATS = ["hp", "atk", "def", "spd"];
export const PCT_STATS = ["hp%", "atk%", "def%", "spd%"];
export const SETS = {
	swift: { pieces: 2, bonus: { stat: "spd%", value: 12 } },
	sturdy: { pieces: 2, bonus: { stat: "def%", value: 15 } },
	fierce: { pieces: 2, bonus: { stat: "atk%", value: 15 } },
	vital: { pieces: 2, bonus: { stat: "hp%", value: 15 } },
	relentless: { pieces: 4, bonus: { stat: "atk%", value: 30 } },
};
export const MAX_SUBS = 4;

// The six sample artifacts (return a fresh array each call):
//   ember-blade   weapon  fierce  main atk 40    subs [atk% 5, spd 3]
//   ember-gloves  gloves  fierce  main atk% 10   subs [def 20]
//   wind-boots    boots   swift   main spd 12    subs []
//   wind-helm     helmet  swift   main hp 300    subs [hp% 6, def% 4]
//   oak-shield    shield  sturdy  main def 50    subs [hp 150]
//   oak-chest     chest   sturdy  main def% 12   subs []
export function sampleArtifacts() {
	throw new Error("not implemented");
}

// Stage 1: validation and equipping.
export function validateArtifact(a) {
	throw new Error("not implemented");
}
export function equip(champion, artifact) {
	throw new Error("not implemented");
}
export function unequip(champion, slot) {
	throw new Error("not implemented");
}

// Stage 2: sums and set bonuses.
export function gearStats(champion) {
	throw new Error("not implemented");
}

// Stage 3: geared stats.
export function gearedStats(champion) {
	throw new Error("not implemented");
}
export function applyGear(champion) {
	throw new Error("not implemented");
}
