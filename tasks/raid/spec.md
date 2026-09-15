`raid` — the core of a turn-based squad RPG in the style of gacha "champion collector" games, plus a three.js scene of a battle. Seven stages, ordered by dependency; each is independently callable and testable. Stages 1–6 are `export function`s in `src/raid.mjs` (plain ESM, Node.js, no dependencies). Stage 7 is `src/scene.mjs` (imports three.js from `./vendor/three.module.js`, which is already in the workspace) and `src/index.html`. Nothing is ever mutated: every input object/array is left untouched and every returned array/object is freshly allocated. All numbers are IEEE doubles; integer arithmetic where the spec says so.

## Errors
Argument validation is checked first, before any computation.
- Throw a `TypeError` whose message starts with `invalid argument` when any argument fails validation (see each function). Missing arguments count as invalid.
- Throw a `RangeError` whose message starts with `no living units` (stage 3), `max level` (stage 1) or `empty pool` (stage 6) in the situations named there.
- Never return `NaN`, `null` or `undefined` in place of throwing.

## Vocabulary
- *integer*: `Number.isInteger(v)`. *finite number*: `typeof v === "number" && Number.isFinite(v)`. Numeric strings, `null`, `NaN`, `±Infinity` are never valid numbers.
- *affinity*: one of `"magic"`, `"force"`, `"spirit"`, `"void"` (export `AFFINITIES`, in that order). *rarity*: one of `"common"`, `"rare"`, `"epic"`, `"legendary"` (export `RARITIES`, in that order). *target kind*: one of `"enemy"`, `"allEnemies"`, `"self"`, `"allAllies"` (export `TARGETS`). *effect stat*: one of `"atk"`, `"def"`, `"spd"` (export `EFFECT_STATS`). Export `MAX_LEVEL = 60`.
- *base stats*: an object `{ hp, atk, def, spd, crit, critDmg }` — `hp`, `atk`, `spd` integers ≥ 1; `def` integer ≥ 0; `crit` finite number in `[0, 1]`; `critDmg` finite number ≥ 1.
- *effect*: `{ stat: <effect stat>, pct: <integer, percent, may be negative>, turns: <integer ≥ 1> }`.
- *skill*: `{ name: <non-empty string>, multiplier: <finite number ≥ 0>, cooldown: <integer ≥ 0>, target: <target kind>, effects?: <array of effects, default []> }`. A skill with `multiplier` `0` deals no damage (it only applies its effects).
- *champion def*: `{ id: <non-empty string>, name: <non-empty string>, affinity, rarity, base: <base stats>, skills: <non-empty array of skills> }`, and `skills[0].cooldown` must be `0` (the basic attack is always available).
- *champion*: what `makeChampion` returns: the def's fields copied (each skill normalised to have an `effects` array) plus `level` (integer 1..60), `xp` (integer ≥ 0), `stats` (from `statsAt`) and `hp` (current hit points, number ≥ 0).
- *unit*: a champion inside a battle, with `side` (0 or 1), `tm` (turn meter, number ≥ 0), `effects` (array of effects currently on it) and `cooldowns` (object mapping skill index → turns remaining).

`SAMPLE_CHAMPIONS` is an exported object of four champion defs; the workspace stub ships it verbatim and the examples below use it (`kael`, `vell`, `grim`, `nyx`):
```
kael: force, epic,      base { hp 1500, atk 130, def 90,  spd 104, crit 0.3,  critDmg 1.6 }
      skills [ Cinder Cut ×1.0 cd0 enemy | Flame Wall ×0.7 cd3 allEnemies | Ignite ×1.8 cd4 enemy, effects [{def -30 % for 2 turns}] ]
vell: spirit, rare,     base { hp 1250, atk 95,  def 120, spd 98,  crit 0.15, critDmg 1.5 }
      skills [ Censer Strike ×1.0 cd0 enemy | Litany ×0 cd3 allAllies, effects [{atk +25 % for 2 turns}] ]
grim: magic, rare,      base { hp 1800, atk 110, def 100, spd 91,  crit 0.2,  critDmg 1.5 }
      skills [ Maul ×1.1 cd0 enemy | Bellow ×0 cd4 self, effects [{def +40 % for 3 turns}] ]
nyx:  void, legendary,  base { hp 1400, atk 150, def 85,  spd 110, crit 0.35, critDmg 1.7 }
      skills [ Shade Lash ×1.0 cd0 enemy | Hollow Step ×0 cd4 self, effects [{spd +30 % for 2 turns}] | Oblivion ×2.2 cd5 enemy ]
```

## Stage 1 — RNG, champions, levelling
**`mulberry32(seed)`** — `seed` an integer (else *invalid argument*). Returns a function that yields a new number in `[0, 1)` on each call, exactly this algorithm (32-bit ops, `|0`, `>>>`, `Math.imul`):
```
a = seed | 0
next(): a = (a + 0x6D2B79F5) | 0
        t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
```
- `mulberry32(1)` → `0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849` (exact, `===`)
- `mulberry32(42)` → `0.6011037519201636, 0.44829055899754167`; `mulberry32(0)` → `0.26642920868471265, 0.0003297457005828619`; `mulberry32(-7)` → `0.43306733411736786`; `mulberry32(2**32 + 1)` → same first value as seed `1` (the `|0` wrap).
- `mulberry32(1.5)`, `mulberry32("1")`, `mulberry32()` → `TypeError invalid argument…`. Two generators with the same seed are independent and produce the same sequence.

**`statsAt(base, level)`** — `base` valid base stats, `level` integer in `1..60`. Growth `g = 100 + 4 * (level - 1)`; return **exactly** the keys `{ hp, atk, def, spd, crit, critDmg }` with `hp = Math.floor(base.hp * g / 100)` (computed as the integer product first, then divided, then floored), likewise `atk` and `def`; `spd`, `crit`, `critDmg` copied unchanged.
- `statsAt(kael.base, 1)` → `{ hp: 1500, atk: 130, def: 90, spd: 104, crit: 0.3, critDmg: 1.6 }`
- level 2 → `hp 1560, atk 135, def 93`; level 3 → `1620, 140, 97`; level 10 → `2040, 176, 122`; level 26 → `3000, 260, 180`; level 60 → `5040, 436, 302`.
- `statsAt(vell.base, 7)` → `{ hp: 1550, atk: 117, def: 148, spd: 98, crit: 0.15, critDmg: 1.5 }`
- `level` `0`, `61`, `1.5`, `"3"`; `base.hp` `0`; `base.crit` `1.5`; `base.critDmg` `0.9` → `TypeError invalid argument…`.

**`makeChampion(def, level = 1)`** — validates `def` as a champion def (every rule in the vocabulary, including `skills[0].cooldown === 0`, every skill's `target` and every effect's shape) and returns a champion: `{ id, name, affinity, rarity, base: <copy>, skills: <deep copy, each with effects: [] when absent>, level, xp: 0, stats: statsAt(base, level), hp: stats.hp }`. The def is not mutated and the result shares no objects with it.
- `makeChampion(grim)` → `level 1, xp 0, stats { hp: 1800, atk: 110, def: 100, spd: 91, crit: 0.2, critDmg: 1.5 }, hp 1800`, `skills[0].effects` is `[]`, `skills[1].effects[0]` is `{ stat: "def", pct: 40, turns: 3 }`.
- `makeChampion(nyx, 5)` → `level 5, stats { hp: 1624, atk: 174, def: 98, spd: 110, crit: 0.35, critDmg: 1.7 }, hp 1624`.
- Invalid: missing `id`, `affinity: "fire"`, `rarity: "mythic"`, `skills: []`, `skills[0].cooldown: 1`, `skills[1].target: "enemies"`, `skills[1].effects[0].stat: "hp"`, `effects[0].pct: 0.5` (not an integer), `effects[0].turns: 0` → `TypeError invalid argument…`.

**`xpForLevel(level)`** — XP needed to go from `level` to `level + 1`: `25 * level * level` for integer `level` in `1..59`. `xpForLevel(60)` throws `RangeError max level…`. Other values → `TypeError invalid argument…`.
- `xpForLevel(1)` → `25`, `(2)` → `100`, `(10)` → `2500`, `(59)` → `87025`.

**`addXp(champion, xp)`** — `champion` a champion (has integer `level` 1..60, integer `xp` ≥ 0, `stats`, `base`, `skills`, `hp`), `xp` integer ≥ 0. Returns a new champion: `pool = champion.xp + xp`; while `level < 60` and `pool >= xpForLevel(level)`: subtract and increment; at level 60 the remaining pool is discarded (`xp` becomes `0`). If the level changed, `stats = statsAt(base, level)` and `hp = stats.hp` (a level-up fully heals); otherwise `stats` and `hp` are unchanged.
- kael (level 1) `+24` → `level 1, xp 24, hp 1500`; `+25` → `level 2, xp 0, stats.hp 1560, hp 1560`; `+200` → `level 3, xp 75, hp 1620`; `+1000` then `+100` → `level 5, xp 350, hp 1740`.
- kael at level 59: `+87024` → `level 59, xp 87024`; `+100000` → `level 60, xp 0, hp 5040`.
- kael with `hp` `700`: `+10` → `hp` stays `700`; `+25` → `hp` `1560`.
- `xp` `-1`, `1.5`; `champion` `null` → `TypeError invalid argument…`.

## Stage 2 — damage
**`affinityMod(attacker, defender)`** — both affinities. `void` against anything, anything against `void`, and same-vs-same → `1`. `magic` beats `spirit`, `spirit` beats `force`, `force` beats `magic`: the winning direction → `1.25`, the losing direction → `0.8`.
- `affinityMod("magic", "spirit")` → `1.25`; `("spirit", "magic")` → `0.8`; `("force", "magic")` → `1.25`; `("spirit", "force")` → `1.25`; `("magic", "force")` → `0.8`; `("void", "magic")`, `("magic", "void")`, `("force", "force")` → `1`. Invalid names → `TypeError invalid argument…`.

**`mitigation(def)`** — `def` integer ≥ 0. Returns `1000 / (1000 + def)`: `mitigation(0)` → `1`, `(100)` → `0.9090909090909091`, `(250)` → `0.8`, `(1000)` → `0.5`.

**`computeDamage({ atk, def, multiplier, mod = 1, crit = false, critDmg = 1.5 })`** — one object argument. `atk` integer ≥ 1, `def` integer ≥ 0, `multiplier` finite ≥ 0, `mod` finite > 0, `crit` boolean, `critDmg` finite ≥ 1. Compute in **exactly** this order, then floor, then clamp to at least 1:
```
x = atk * multiplier
x = x * mod
x = x * 1000 / (1000 + def)        (as written: multiply by 1000, then divide)
if crit: x = x * critDmg
return Math.max(1, Math.floor(x))
```
- `{ atk: 130, def: 100, multiplier: 1 }` → `118`
- `{ atk: 130, def: 100, multiplier: 1.8, mod: 1.25 }` → `265`; the same with `crit: true, critDmg: 1.6` → `425`
- `{ atk: 95, def: 120, multiplier: 0.7, mod: 0.8 }` → `47`
- `{ atk: 150, def: 0, multiplier: 2.2, crit: true, critDmg: 1.7 }` → `561`
- `{ atk: 1, def: 5000, multiplier: 0.1 }` → `1`; `{ atk: 100, def: 100, multiplier: 0 }` → `1` (the floor of 1 applies even to zero-multiplier calls)
- `atk` `0`, `def` `-1`, `mod` `0`, `crit` `"yes"`, `critDmg` `0.5`, no argument → `TypeError invalid argument…`.

## Stage 3 — turn meter
**`nextActor(units)`** — `units` a non-empty array of `{ spd, tm, hp }` (each: `spd` finite > 0, `tm` finite ≥ 0, `hp` finite ≥ 0; extra keys allowed and passed through). A unit is *alive* iff `hp > 0`. If no unit is alive → `RangeError no living units…`. Otherwise, for each alive unit the time to fill its meter is `(100 - tm) / spd`; the actor is the alive unit with the **smallest** such time (compare the computed doubles with `<`; ties go to the **lowest index**). Let `dt` be that time. Return `{ index, elapsed: dt, units }` where `units` is a new array of new objects: every alive non-actor gets `tm + spd * dt` (no clamping), the actor gets `tm = 0`, dead units are copied unchanged.
- `[{spd 100, tm 0, hp 1}, {spd 120, tm 0, hp 1}]` → `index 1, elapsed 0.8333333333333334, units[0].tm 83.33333333333334, units[1].tm 0`
- `[{spd 100, tm 0}, {spd 100, tm 0}]` (both alive) → `index 0, elapsed 1, units[1].tm 100`
- `[{spd 100, tm 50, hp 1}, {spd 120, tm 0, hp 1}, {spd 200, tm 0, hp 0}]` → `index 0, elapsed 0.5`, `units[1].tm 60`, `units[2].tm 0` (dead, untouched)
- speeds `104, 98, 91, 110` all at `tm 0` → `index 3, elapsed 0.9090909090909091`, tms `94.54545454545455, 89.0909090909091, 82.72727272727272, 0`
- `[]`, `[{spd 0, tm 0, hp 1}]`, `[{spd 100, tm -1, hp 1}]`, `[{spd 100, tm "0", hp 1}]` → `TypeError invalid argument…`; `[{spd 100, tm 0, hp 0}]` → `RangeError no living units…`.

Tolerance for the floating values above: 1e-12.

## Stage 4 — effects, cooldowns, AI
**`effectiveStat(unit, stat)`** — `unit` has `stats` (with integer `stats[stat]`) and optional `effects` (array, default `[]`); `stat` an effect stat. `sum` = the sum of `pct` over the unit's effects whose `stat` matches. Return `Math.max(1, Math.floor(unit.stats[stat] * (100 + sum) / 100))` (integer product first).
- `stats { atk 130, def 90, spd 104 }`, effects `[{atk +25, 2 turns}, {atk -30, 1 turn}, {def -30, 2 turns}]` → `atk 123` (`130 * 95 / 100 = 123.5`), `def 63`, `spd 104`.
- `stats { atk 95 }` with `{atk +25}` → `118`; `stats { atk 50 }` with `{atk -100}` → `1`.
- `stat` `"hp"` or `"crit"` → `TypeError invalid argument…`.

**`tickEffects(unit)`** — returns a copy of `unit` whose `effects` each have `turns - 1`, dropping those that reach `0`. A unit without `effects` gets `effects: []`. The effects above → `[{atk +25, 1 turn}, {def -30, 1 turn}]`.

**`availableSkills(unit)`** — `unit.skills` non-empty; `unit.cooldowns` optional object `{ [skillIndex]: turnsRemaining }`. Return the skill indexes whose remaining cooldown is `0` or absent, ascending. kael with no cooldowns → `[0, 1, 2]`; with `cooldowns { 1: 2, 2: 0 }` → `[0, 2]`.

**`chooseSkill(unit)`** — the **highest** available index (the AI always fires its biggest ready skill): kael → `2`; `cooldowns { 1: 2, 2: 0 }` → `2`; `{ 1: 1, 2: 3 }` → `0`.

**`chooseTarget(units)`** — `units` an array of objects with numeric `hp`. Return the index of the alive unit with the **lowest** `hp`, ties to the lowest index; `-1` when none is alive (or the array is empty). `[{hp 5}, {hp 3}, {hp 3}]` → `1`; `[{hp 0}, {hp 9}]` → `1`; `[{hp 0}]` → `-1`; `[]` → `-1`.

**`rollHit(attacker, defender, skill, rng)`** — `attacker`/`defender` units (have `stats`, `affinity`, optional `effects`), `skill` with numeric `multiplier`, `rng` a function. Draw **exactly one** value `roll = rng()`; `crit = roll < attacker.stats.crit`; `damage = computeDamage({ atk: effectiveStat(attacker, "atk"), def: effectiveStat(defender, "def"), multiplier: skill.multiplier, mod: affinityMod(attacker.affinity, defender.affinity), crit, critDmg: attacker.stats.critDmg })`. Return `{ damage, crit, roll }`.
- kael (level 1) vs grim, Cinder Cut, `mulberry32(1)` → `{ damage: 147, crit: false, roll: 0.6270739405881613 }` (force beats magic: 130 × 1 × 1.25 × 1000/1100 = 147.7)
- kael vs grim, Ignite, `mulberry32(0)` → `{ damage: 425, crit: true, roll: 0.26642920868471265 }`
- kael with `{atk +25}` vs grim with `{def -30}`, Cinder Cut, `mulberry32(1)` → `damage 189` (atk 162, def 70)
- `rng` not a function → `TypeError invalid argument…`.

## Stage 5 — battle
**`runBattle(teamA, teamB, seed, maxTurns = 100)`** — `teamA`, `teamB` non-empty arrays of champions; `seed` integer; `maxTurns` integer ≥ 1. Neither team array nor any champion in it is mutated. Build the unit list `[...teamA, ...teamB]` in that order (global indexes 0..n−1): each champion copied with `side` (`0` for A, `1` for B), `hp` = the champion's current `hp`, `tm: 0`, `effects: []`, `cooldowns: {}`. One generator `rng = mulberry32(seed)` for the whole battle. Then for `turn = 1..maxTurns`:
1. If every unit on one side has `hp` `0`, stop (before choosing an actor).
2. Advance the turn meter with stage 3 using each unit's **effective** `spd` (`effectiveStat(unit, "spd")`) and current `tm`/`hp`; the returned `tm`s are written back; the actor is `nextActor`'s `index`.
3. At the start of the actor's turn every entry of its `cooldowns` is decremented by 1 (not below 0).
4. `si = chooseSkill(actor)`, `skill = actor.skills[si]`. Targets, as **global indexes in ascending order**: `enemy` → the single index that `chooseTarget` picks among the alive units of the other side (none alive → no targets); `allEnemies` → every alive unit of the other side; `self` → the actor; `allAllies` → every alive unit of the actor's side, including the actor.
5. For each target in that order: if `skill.multiplier > 0`, `rollHit(actor, target, skill, rng)` (so exactly one rng draw per damaging hit, in target order; a zero-multiplier skill draws nothing), `hp' = Math.max(0, hp - damage)`, record `{ target, damage, crit, killed }` where `killed` is `hp > 0 && hp' === 0`. Then, if the target is still alive after the hit, append a copy of each of `skill.effects` to the target's `effects`. Effects the actor applies to itself are on the actor from then on. The attacker's effective stats are read at each hit (a self-buff applied earlier in the same turn counts).
6. If `skill.cooldown > 0`, set `actor.cooldowns[si] = skill.cooldown`.
7. `tickEffects(actor)` — effects on a unit expire by **that unit's** turns, at the end of its turn.
8. Append `{ turn, actor: <index>, skill: si, hits: [...] }` to the log.

After the loop (by stop or by `maxTurns`), `winner` is `"A"` if side 1 is wiped out, `"B"` if side 0 is, else `"draw"`. Return **exactly** `{ winner, turns: log.length, log, units }` with `units` the final unit list (same order, with `hp`, `tm`, `effects`, `cooldowns`, `side`).

Examples (all champions at level 1 via `makeChampion`; `A = [kael, vell]`, `B = [grim, nyx]`):
- `runBattle(A, B, 1)` → `winner "A"`, `turns 35`, final `hp` `[1103, 0, 0, 0]`; `A[0].hp` is still `1500` afterwards. Log: turn 1 `{ actor: 3, skill: 2, hits: [{ target: 1, damage: 294, crit: false, killed: false }] }` (nyx is fastest, opens with Oblivion on vell, the lowest-hp enemy); turn 2 `{ actor: 0, skill: 2, hits: [{ target: 3, damage: 345, crit: true, killed: false }] }`; turn 3 `{ actor: 1, skill: 1, hits: [] }` (Litany, no damage); turn 4 `{ actor: 2, skill: 1, hits: [] }`; turn 5 `{ actor: 3, skill: 1, hits: [] }`; turn 6 `{ actor: 0, skill: 1, hits: [{ target: 2, damage: 124, … }, { target: 3, damage: 107, … }] }` (Flame Wall, both enemies in index order); last turn `35` `{ actor: 0, skill: 2, hits: [{ target: 2, damage: 265, crit: false, killed: true }] }`.
- `runBattle(A, B, 1, 3)` → `winner "draw"`, `turns 3`, `hp [1500, 956, 1800, 1055]`, `cooldowns [{2: 4}, {1: 3}, {}, {2: 5}]`, `effects [[{atk +25, 2 turns}], [{atk +25, 1 turn}], [], [{def -30, 2 turns}]]` (vell's own Litany buff has already ticked once because she applied it on her own turn).
- `runBattle([kael], [grim], 7)` → `winner "A"`, `turns 14`, `hp [1148, 0]`; hits in order: turn 1 `425 crit`, turn 3 `163 crit`, turn 4 `88`, turn 5 `142`, turn 6 `88`, turn 7 `147`, turn 8 `88`, turn 9 `425 crit`, turn 11 `102`, turn 12 `88`, turn 13 `228 crit`, turn 14 `228 crit killed`; turns 2 and 10 are grim's Bellow with `hits: []`.
- `runBattle([vell], [grim], 3, 5)` → `winner "draw"`, log actors `[0, 1, 0, 1, 0]`, skills `[1, 1, 0, 0, 0]`, damages `82` (turn 3), `202 crit` (turn 4), `66` (turn 5; grim's +40 % def is on); final `units[1].effects` `[{def +40, 1 turn}]`, `units[0].cooldowns {1: 1}`, `units[1].cooldowns {1: 3}`.
- Empty team, `seed 1.5`, `maxTurns 0` → `TypeError invalid argument…`.

## Stage 6 — summoning and campaign
**`summon(rng, pool)`** — `rng` a function; `pool` an object with an array under each of the four rarities. Draw `r1 = rng()`: `r1 < 0.005` → `legendary`; else `r1 < 0.06` → `epic`; else `r1 < 0.25` → `rare`; else `common`. If that rarity's array is empty → `RangeError empty pool: <rarity>` (thrown **before** the second draw). Then `r2 = rng()`, pick `list[Math.floor(r2 * list.length)]` and return `makeChampion` of it.
- `pool = { common: [vell, grim], rare: [vell], epic: [kael], legendary: [nyx] }`, one generator `mulberry32(1)` used for six summons in a row → ids `vell, grim, vell, grim, grim, vell`.
- Fresh `mulberry32(307)` (first draw `0.0022…`) → `nyx`; `mulberry32(7)` (`0.0117…`) → `kael`; `mulberry32(8)` (`0.156…`) → `vell` from `rare`; with `legendary: []`, `mulberry32(307)` → `RangeError empty pool: legendary`.

**`stageEnemies(stage)`** — `stage` integer ≥ 1. Three champions (`makeChampion(def, Math.min(60, stage))`) with, for `i = 0, 1, 2`: `id` `` `stage${stage}-enemy${i}` ``, `name` `` `Minion ${i + 1}` ``, `affinity = AFFINITIES[(stage + i) % 4]`, `rarity "common"`, `base { hp: 300 + 40 * stage, atk: 40 + 6 * stage, def: 30 + 5 * stage, spd: 90 + 5 * i, crit: 0.1, critDmg: 1.5 }`, one skill `{ name: "Strike", multiplier: 1, cooldown: 0, target: "enemy" }`.
- `stageEnemies(1)` → affinities `force, spirit, void`, level 1, `stats.hp 340, atk 46, def 35`, speeds `90, 95, 100`.
- `stageEnemies(5)` → level 5, `stats { hp: 580, atk: 81, def: 63 }`; `stageEnemies(61)` → level 60, `stats.hp 9206`.

**`resolveStage(team, stage, seed)`** — `team` non-empty array of champions, `stage` integer ≥ 1, `seed` integer. Every team member enters at full health (`hp = stats.hp`, the input is not mutated); `battle = runBattle(fresh, stageEnemies(stage), seed, 100)`; `won = battle.winner === "A"`; `rewards = won ? { silver: 100 * stage, xp: 50 * stage } : { silver: 0, xp: 0 }`; `team` in the result is every input champion put through `addXp(c, rewards.xp)` when won, else copies. Return **exactly** `{ won, battle, rewards, team }`.
- `resolveStage([kael, vell, grim, nyx], 1, 3)` → `won true`, `rewards { silver: 100, xp: 50 }`, `battle.turns 13`, result team all `level 2, xp 25`, hp `1560, 1300, 1872, 1456`; `battle.units` hp `[1500, 1066, 1800, 1400, 0, 0, 0]`.
- `resolveStage([vell], 9, 3)` → `won false`, `rewards { silver: 0, xp: 0 }`, `battle.turns 15`, team `[level 1, xp 0, hp 1250]`.
- The same four champions each with `hp: 1` → still `won true` (they were healed before the battle).

## Stage 7 — `src/scene.mjs` and `src/index.html`
`scene.mjs` does `import * as THREE from "./vendor/three.module.js"` (r186, already in `src/vendor/`; never edit or read those files) and exports:

**`AFFINITY_COLORS`** = `{ magic: 0x3b82f6, force: 0xef4444, spirit: 0x22c55e, void: 0x8b5cf6 }`.

**`unitPosition(side, i, n)`** — `side` 0 or 1, `n` integer ≥ 1, `i` integer in `0..n-1`. Returns `[x, 0, z]` with `x = -4` for side 0 and `4` for side 1, `z = (i - (n - 1) / 2) * 2.5`. `(0, 0, 1)` → `[-4, 0, 0]`; `(0, 0, 2)` → `[-4, 0, -1.25]`; `(0, 1, 2)` → `[-4, 0, 1.25]`; `(1, 0, 3)` → `[4, 0, -2.5]`; `(1, 2, 3)` → `[4, 0, 2.5]`; `(1, 1, 4)` → `[4, 0, -1.25]`.

**`makeCamera(aspect)`** — `aspect` finite > 0. A `THREE.PerspectiveCamera(50, aspect, 0.1, 100)` named `"camera"` at position `(0, 9, 13)` looking at the origin (`camera.lookAt(0, 0, 0)`; its `rotation.x` is then `-0.605545…`).

**`buildScene(units)`** — `units` a non-empty array of battle units (each with `side` 0/1, numeric `hp` ≥ 0, `stats.hp` integer ≥ 1, an affinity, and an `id`). Returns a `THREE.Scene` named `"raid"` with `background` a `THREE.Color` of `0x0b1020`, whose direct children are, in order:
1. a `Group` named `"arena"` containing a `Mesh` named `"floor"` (`PlaneGeometry(20, 20)`, `rotation.x = -Math.PI / 2`);
2. an `AmbientLight` named `"ambient"`;
3. a `DirectionalLight` named `"sun"` at position `(5, 10, 5)`;
4. a `Group` named `"side-0"`; 5. a `Group` named `"side-1"`.

Each unit, in input order with global index `k`, becomes a `Group` named `` `unit-${k}` `` inside its side's group, with `userData { id, index: k, side }`, positioned by `unitPosition(side, <its ordinal within its side, counting from 0 in input order>, <number of units on that side>)`, and `visible = hp > 0`. The group has exactly two children: a `Mesh` named `"body"` (`BoxGeometry(1, 1.8, 1)`, `MeshStandardMaterial` whose `color` is `AFFINITY_COLORS[affinity]`, `position.y = 0.9`) and a `Mesh` named `"hpbar"` (`BoxGeometry(1.2, 0.12, 0.12)`, `position.y = 2.2`, `scale.x = hp / stats.hp`).
- For the four-unit draw battle above (`runBattle(A, B, 1, 3).units`): `unit-0` at `(-4, 0, -1.25)`, `unit-1` at `(-4, 0, 1.25)` with hpbar `scale.x 0.7648`, `unit-2` at `(4, 0, -1.25)`, `unit-3` at `(4, 0, 1.25)` with hpbar `scale.x 0.7535714285714286`; `unit-0`'s body colour `0xef4444` (force), `unit-3`'s `0x8b5cf6` (void).
- `[]`, a unit with `side 2`, `hp -1`, or an unknown affinity → `TypeError invalid argument…`.

**`updateScene(scene, units)`** — for each unit `k`, finds `` `unit-${k}` `` via `scene.getObjectByName`, sets its `"hpbar"` child's `scale.x = hp / stats.hp` and the group's `visible = hp > 0`; returns the same scene object (this one mutates the scene, by design). A missing group → `TypeError invalid argument…`.

**`src/index.html`** — a page that shows a battle: a `<script type="module">` that imports from `./raid.mjs` and `./scene.mjs`, builds two teams from `SAMPLE_CHAMPIONS` (A = kael, vell; B = grim, nyx), runs `runBattle` with a seed, creates a `THREE.WebGLRenderer` sized to the window with `makeCamera` and `buildScene`, and then replays the log one turn per ~600 ms — applying each turn's hits to a live copy of the units and calling `updateScene` — with the turn's text (actor, skill name, damage per target) written into an element on the page. It must reference both modules by those relative paths, must not load three.js from a CDN (only `./vendor/three.module.js`, via `scene.mjs` or directly), and must contain no `<script src=...>` other than module scripts under `src/`. Checked structurally (the file exists, has a module script, imports both modules, mentions `WebGLRenderer`, `runBattle`, `updateScene`, `requestAnimationFrame`, and no `http://`/`https://` script sources).

## Non-goals
No real-time input, no equipment/artifacts, no multi-hit skills, no healing skills, no resistance/accuracy, no typed arrays, no extra keys on objects the spec says are exact, no build step, no npm packages beyond the vendored three.js.
