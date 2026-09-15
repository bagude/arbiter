// Campaign runner for the raid core. See README.md.
// The constants below are given data: keep them as they are.

export const ENERGY_PER_STAGE = 4;
export const MAX_STAGE = 12;

// Stage 1: star rating of a battle result.
export function stars(battle) {
	throw new Error("not implemented");
}

// Stage 2: an energy-budgeted run through the campaign.
export function runCampaign(team, seed, energy, startStage = 1) {
	throw new Error("not implemented");
}

// Stage 3: team search.
export function combinations(n, k) {
	throw new Error("not implemented");
}
export function bestTeam(roster, size, stage, seed) {
	throw new Error("not implemented");
}
