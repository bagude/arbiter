`raid-arena` — a campaign runner for the `raid` squad-RPG core: star ratings, an energy-budgeted run through the campaign stages, and a deterministic best-team search. The core (`src/raid.mjs`: `resolveStage`, `runBattle`, `addXp`, `stageEnemies`, champions) is given and complete; do not change it. The deliverable is `src/arena.mjs` (plain ESM, Node.js, no dependencies) importing from `./raid.mjs`. Three stages. Pure: inputs untouched, results fresh.

## Errors
`TypeError` whose message starts with `invalid argument` for any invalid argument (missing counts as invalid). Never return `NaN`, `null` or `undefined` in place of throwing (`bestTeam`'s `best: null` is a documented value).

## Constants (exported)
`ENERGY_PER_STAGE = 4`, `MAX_STAGE = 12`.

## Stage 1 — `stars(battle)`
`battle` a `runBattle`/`resolveStage(...).battle` result (object with string `winner` and array `units`; else *invalid argument*). Returns `0` unless `winner === "A"`; otherwise count the side-0 units with `hp <= 0`: none → `3`, exactly one → `2`, more → `1`.
- `resolveStage([kael, vell, grim, nyx], 1, 3).battle` (all level 1) → `3`; `resolveStage([vell], 9, 3).battle` → `0`.
- Hand-made: `{ winner: "A", units: [{side 0, hp 0}, {side 0, hp 5}, {side 1, hp 0}, {side 1, hp 0}] }` → `2`; all four `hp 0` with `winner "A"` → `1`; both side-0 alive → `3`; `winner "draw"` → `0`.

## Stage 2 — `runCampaign(team, seed, energy, startStage = 1)`
`team` non-empty array of champions (each has `stats`, integer `level`, `skills`), `seed` integer, `energy` integer ≥ 0, `startStage` integer in `1..MAX_STAGE`. Starting with copies of the team at `stage = startStage` and `left = energy`:
1. If `stage > MAX_STAGE` → stop with `stopped: "complete"`.
2. If `left < ENERGY_PER_STAGE` → stop with `stopped: "energy"`.
3. `left -= ENERGY_PER_STAGE`; `r = resolveStage(current, stage, seed + stage)` (the stage's seed is `seed + stage`); append `{ stage, won: r.won, stars: stars(r.battle), turns: r.battle.turns, rewards: r.rewards }` to the log.
4. If lost → stop with `stopped: "loss"` (energy for that attempt is spent). If won → add the rewards to `silver` and `xp`, `current = r.team` (the levelled-up team), `stage++`, repeat.

Return **exactly** `{ stagesCleared, nextStage, log, team, silver, xp, energyLeft, stopped }` — `stagesCleared` = number of won entries, `nextStage` = the stage that would be attempted next (`MAX_STAGE + 1` after a complete run), `team` = the current team (copies), `silver`/`xp` = totals of the rewards earned.
- `runCampaign([kael, vell, grim, nyx], 100, 40)` (level 1) → clears stages 1..10 with 3 stars each, `nextStage 11`, `silver 5500`, `xp 2750`, `energyLeft 0`, `stopped "energy"`; log turns `[12, 14, 12, 15, 16, 18, 20, 23, 23, 23]`; every champion ends at `level 7, xp 475` (hp `1860, 1550, 2232, 1736`).
- Same team, `energy 7` → one stage (`turns 12`), `energyLeft 3`, `stopped "energy"`, `nextStage 2`.
- `[vell]` alone, `seed 100`, `energy 100` → stage 1 won (`turns 42`, 3 stars), stage 2 lost (`turns 35`, `stars 0`, `rewards { silver: 0, xp: 0 }`), `stagesCleared 1`, `nextStage 2`, `silver 100`, `energyLeft 92`, `stopped "loss"`, team `[level 2, xp 25]`.
- The four at level 60 (`addXp(c, 100000)`), `seed 5`, `energy 100` → all 12 stages, 3 stars each, turns `[9, 9, 9, 11, 11, 14, 10, 17, 14, 18, 17, 22]`, `silver 7800`, `xp 3900`, `energyLeft 52`, `nextStage 13`, `stopped "complete"`; with `startStage 11` → log `[11 won 3 stars, 12 won 3 stars]`, `energyLeft 92`, `stopped "complete"`.
- `energy 3` → `{ stagesCleared: 0, nextStage: 1, log: [], team: <copies>, silver: 0, xp: 0, energyLeft: 3, stopped: "energy" }`. The input team is never mutated (levels stay 1).
- Invalid: empty team, `seed 1.5`, `energy -1`, `startStage 0` or `13` → `TypeError invalid argument…`.

## Stage 3 — `combinations(n, k)` and `bestTeam(roster, size, stage, seed)`
**`combinations(n, k)`** — every k-subset of `0..n-1` as an ascending index array, in lexicographic order. `(4, 2)` → `[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]]`; `(3, 3)` → `[[0,1,2]]`; `(3, 0)` → `[[]]`; `(2, 3)` → `[]`. Non-integer or negative → `TypeError`.

**`bestTeam(roster, size, stage, seed)`** — `roster` non-empty array of champions, `size` integer in `1..roster.length`, `stage` integer ≥ 1, `seed` integer. For every combination (in that order) run `resolveStage(<those champions>, stage, seed)` and record `{ indexes, won, stars, turns }`. `best` is the winning combination with the fewest `turns`; ties broken by more `stars`, then by the earlier combination. Return **exactly** `{ best, tried }` with `best` either `{ indexes, turns, stars }` or `null` when no combination wins.
- `bestTeam([kael, vell, grim, nyx], 2, 3, 9)` → `best { indexes: [0, 3], turns: 13, stars: 3 }`; `tried` turns in order `[16, 17, 13, 39, 17, 16]`, all won with 3 stars.
- `bestTeam(same, 1, 1, 2)` → `best { indexes: [0], turns: 21, stars: 3 }`; `tried` = `[0] won 21`, `[1] lost 43`, `[2] won 38`, `[3] won 22`.
- `bestTeam([vell, grim], 1, 9, 3)` → `best null`, `tried` `[0] lost 15`, `[1] lost 20`.
- `size 0`, `size 5` for four champions, `stage 0` → `TypeError invalid argument…`.

## Non-goals
No energy regeneration over time, no retries after a loss, no changes to `raid.mjs`, no extra keys on the exact-shape objects.
