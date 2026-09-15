`raid-ai` — an alternative battle AI for the `raid` squad-RPG core, a battle runner that lets side A use it against the basic AI, and a seeded win-rate estimator. The core (`src/raid.mjs`) is given and complete; do not change it. The deliverable is `src/ai.mjs` (plain ESM, Node.js, no dependencies) importing from `./raid.mjs`: `affinityMod`, `availableSkills`, `chooseSkill`, `chooseTarget`, `effectiveStat`, `mulberry32`, `nextActor`, `rollHit`, `tickEffects`. Three stages. Pure: inputs untouched, results fresh. "Smart" is a name, not a promise — the estimator in stage 3 measures what it actually does.

## Errors
`TypeError` whose message starts with `invalid argument` for any invalid argument (missing counts as invalid). Never return `NaN`, `null` or `undefined` in place of throwing.

## Stage 1 — targeting and skill choice
**`chooseTargetSmart(actor, enemies)`** — `actor` a unit with a string `affinity`; `enemies` an array of units (each with numeric `hp` and string `affinity`). Among enemies with `hp > 0`, pick by this key, smallest first: `[ affinityMod(actor.affinity, enemy.affinity) >= 1.25 ? 0 : 1, enemy.hp ]` — i.e. first any enemy the actor is strong against, then the lowest hp, then the lowest index. `-1` when none is alive (or the array is empty).
- kael (force) vs `[grim 1800 hp, nyx 1400]` → `0` (grim is magic, force beats magic); vs `[nyx 100, grim 1800]` → `1`; vs `[grim 0, nyx 1400]` → `1`; vs `[vell 500, nyx 400]` → `1` (no strong match: lowest hp); vs `[grim 900, grim 800]` → `1`; vs `[]` → `-1`.
- vell (spirit) vs `[kael 100, grim 50, nyx 10]` → `0` (spirit beats force).
- `actor` without an affinity, `enemies` not an array, an enemy without `hp` → `TypeError invalid argument…`.

**`scoreSkills(actor, aliveEnemies)`** — `actor` a unit with `skills` (and optional `cooldowns`, `effects`); `aliveEnemies` integer ≥ 0. For each index in `availableSkills(actor)` (ascending) return `{ skill: <index>, score }` where a damaging skill (`multiplier > 0`) scores `multiplier * (target === "allEnemies" ? aliveEnemies : 1)`, and a pure-effect skill (`multiplier === 0`) scores `1.5` when the actor has **no** active effect whose `stat` equals the skill's first effect's `stat`, else `-1`.
- kael, 2 enemies → `[{0, 1}, {1, 1.4}, {2, 1.8}]`; 1 enemy → `[{0, 1}, {1, 0.7}, {2, 1.8}]`; `cooldowns { 2: 3 }`, 3 enemies → `[{0, 1}, {1, 2.0999999999999996}]` (plain double arithmetic, `0.7 * 3`).
- nyx, 2 enemies → `[{0, 1}, {1, 1.5}, {2, 2.2}]`; vell → `[{0, 1}, {1, 1.5}]`; vell with an active `atk` effect → `[{0, 1}, {1, -1}]`.

**`chooseSkillSmart(actor, aliveEnemies)`** — the index with the **highest** score; ties go to the **higher** index. kael 2 enemies → `2`; 1 enemy → `2`; `cooldowns { 2: 3 }`, 3 enemies → `1`; `cooldowns { 2: 1 }`, 1 enemy → `0`. nyx → `2`; nyx with `cooldowns { 2: 2 }` → `1`; the same with an active `spd` effect → `0`. vell → `1`; vell with an active `atk` effect → `0`. `aliveEnemies` `-1` or `1.5` → `TypeError`.

## Stage 2 — `runBattleSmart(teamA, teamB, seed, maxTurns = 100)`
Exactly `runBattle`'s loop (same validation, unit list, `mulberry32(seed)`, effective-speed turn meter, start-of-turn cooldown decrement, target lists in ascending global index, one rng draw per damaging hit in target order, effects applied to survivors, cooldown set, `tickEffects` on the actor, the same log entry and result shapes `{ winner, turns, log, units }`), with one difference: when the actor is on **side 0**, `chooseSkillSmart(actor, <number of alive enemies>)` picks the skill and, for `target: "enemy"`, `chooseTargetSmart(actor, <the other side's units in index order>)` picks the target; side 1 keeps `chooseSkill` / `chooseTarget`. Any other target kind resolves exactly as in `runBattle`.
- `A = [kael, vell]`, `B = [grim, nyx]` (level 1), seed 1 → `winner "A"`, `turns 37`, final hp `[321, 0, 0, 0]` (the basic `runBattle` gives `"A"`, 35 turns, `[1103, 0, 0, 0]`). Log: turn 1 `{ actor: 3, skill: 2, hits: [{ target: 1, damage: 294, crit: false, killed: false }] }`; turn 2 `{ actor: 0, skill: 2, hits: [{ target: 2, damage: 425, crit: true, killed: false }] }` (kael targets grim, not nyx); turns 3–5 `{1, skill 1, []}`, `{2, skill 1, []}`, `{3, skill 1, []}`; turn 6 `{ actor: 0, skill: 1, hits: [{ target: 2, damage: 127 }, { target: 3, damage: 104 }] }` (no crits); turn 7 `{ actor: 1, skill: 0, hits: [{ target: 2, damage: 85, crit: false, killed: false }] }`; last turn `37` `{ actor: 0, skill: 2, hits: [{ target: 3, damage: 345, crit: true, killed: true }] }`.
- Same, `maxTurns 3` → `winner "draw"`, hp `[1500, 956, 1375, 1400]`, `cooldowns [{2: 4}, {1: 3}, {}, {2: 5}]`, `effects [[{atk +25, 2 turns}], [{atk +25, 1 turn}], [{def -30, 2 turns}], []]`.
- Inputs are untouched (`A[0].hp` stays `1500`, no `tm` on the input). Empty team, `seed 1.5`, `maxTurns 0` → `TypeError invalid argument…`.

## Stage 3 — `winRate(teamA, teamB, seeds, runner = runBattleSmart)`
`seeds` a non-empty array of integers; `runner` a function `(teamA, teamB, seed) → battle`. Runs `runner(teamA, teamB, seed)` for every seed in order. Returns **exactly** `{ wins, draws, total, rate, avgTurns }`: `wins` = results with `winner "A"`, `draws` = `"draw"`, `total = seeds.length`, `rate = wins / total`, `avgTurns` = the mean of `turns` (plain division, not rounded).
- `A` vs `B`, seeds `1..10` → `{ wins: 3, draws: 0, total: 10, rate: 0.3, avgTurns: 37.2 }`; with `runner = runBattle` → `{ wins: 10, draws: 0, total: 10, rate: 1, avgTurns: 37.5 }`.
- `[kael]` vs `[grim]`, seeds `1..5` → `{ wins: 5, draws: 0, total: 5, rate: 1, avgTurns: 16.4 }`; with `runBattle` → `avgTurns 17.6`.
- `[vell]` vs `stageEnemies(9)`, seeds `[3, 4]` → `{ wins: 0, draws: 0, total: 2, rate: 0, avgTurns: 15.5 }`.
- `A` vs `stageEnemies(2)`, seeds `1..10` → `rate 1, avgTurns 16.4`; with `runBattle` → `avgTurns 17.6`.
- `seeds` `[]`, `[1.5]`, `"1"`; `runner` `5` → `TypeError invalid argument…`.

## Non-goals
No learning, no lookahead, no changes to `raid.mjs`, no extra keys on the exact-shape objects.
