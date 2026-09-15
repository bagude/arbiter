`raid-gear` — artifacts and equipment for the `raid` squad-RPG core. The core (`src/raid.mjs`: champions, `makeChampion`, `statsAt`, battles) is given and complete; do not change it. The deliverable is `src/gear.mjs` (plain ESM, Node.js, no dependencies) which imports what it needs from `./raid.mjs`. Three stages, ordered by dependency. Nothing is mutated: every input is left untouched and every returned object is freshly allocated (deep copies of gear and skills).

## Errors
Validation first. `TypeError` whose message starts with `invalid argument` for any invalid argument (missing counts as invalid). `RangeError` whose message starts with `nothing equipped` in the one situation named below. Never return `NaN`, `null` or `undefined` in place of throwing.

## Vocabulary and constants (all exported)
- `SLOTS = ["weapon", "helmet", "shield", "gloves", "chest", "boots"]` (in that order).
- `FLAT_STATS = ["hp", "atk", "def", "spd"]`; `PCT_STATS = ["hp%", "atk%", "def%", "spd%"]`. A *stat line* is `{ stat: <one of those eight>, value: <integer ≥ 1> }`; a percent line's `value` is an integer percent.
- `SETS = { swift: { pieces: 2, bonus: { stat: "spd%", value: 12 } }, sturdy: { pieces: 2, bonus: { stat: "def%", value: 15 } }, fierce: { pieces: 2, bonus: { stat: "atk%", value: 15 } }, vital: { pieces: 2, bonus: { stat: "hp%", value: 15 } }, relentless: { pieces: 4, bonus: { stat: "atk%", value: 30 } } }`.
- `MAX_SUBS = 4`.
- *artifact*: `{ id: <non-empty string>, slot: <one of SLOTS>, set: <one of the SETS keys>, main: <stat line>, subs?: <array of at most MAX_SUBS stat lines, default []> }`.
- *champion*: a `raid.mjs` champion (`stats`, `base`, `level`, `skills`, …), optionally with `gear`: an object mapping slot → artifact (only slots from `SLOTS`; an unknown key is invalid).

`sampleArtifacts()` (exported, returns a fresh array each call) is the six-piece sample set used in the examples:
```
ember-blade   weapon  fierce  main atk 40      subs [atk% 5, spd 3]
ember-gloves  gloves  fierce  main atk% 10     subs [def 20]
wind-boots    boots   swift   main spd 12      subs []
wind-helm     helmet  swift   main hp 300      subs [hp% 6, def% 4]
oak-shield    shield  sturdy  main def 50      subs [hp 150]
oak-chest     chest   sturdy  main def% 12     subs []
```

## Stage 1 — validation and equipping
**`validateArtifact(a)`** — returns a normalised deep copy `{ id, slot, set, main: { stat, value }, subs: [...] }` (missing `subs` → `[]`), or throws `TypeError invalid argument…`. Invalid: non-object, empty `id`, `slot: "ring"`, `set: "mystic"`, `main.stat: "crit"`, `main.value: 0`, `main.value: 2.5`, five subs, a sub with `value: -1`.
- `validateArtifact({ id: "a", slot: "boots", set: "swift", main: { stat: "spd", value: 5 } })` → `{ id: "a", slot: "boots", set: "swift", main: { stat: "spd", value: 5 }, subs: [] }`.

**`equip(champion, artifact)`** — validates both; returns a new champion whose `gear` is a copy of the old gear with `artifact` (normalised) under its slot, replacing whatever was in that slot. Everything else is copied unchanged (including `stats` and `hp` — equipping does not recompute stats; see stage 3). The input champion and artifact are untouched, and the result's `gear[slot]` is not the same object as the artifact passed in.
- kael (level 1) equipped with ember-gloves re-slotted as `{ ...gloves, slot: "weapon", id: "x" }` → `Object.keys(gear)` is `["weapon"]`, `gear.weapon.id` is `"x"`; equipping ember-blade afterwards → `gear.weapon.id` is `"ember-blade"` and still one key.
- Equipping all six sample artifacts in order → `Object.keys(gear)` in equip order: `["weapon", "gloves", "boots", "helmet", "shield", "chest"]`.

**`unequip(champion, slot)`** — `slot` must be in `SLOTS` (else *invalid argument*); if nothing is in that slot (or the champion has no `gear`) → `RangeError nothing equipped: <slot>`. Otherwise a new champion with that slot removed from a copied `gear` (the key is deleted, not set to `undefined`).
- Fully geared kael, `unequip(k, "boots")` → keys `["weapon", "gloves", "helmet", "shield", "chest"]`.

## Stage 2 — `gearStats(champion)`
Sums the champion's gear. Returns **exactly** `{ flat, pct, sets }`:
- `flat = { hp, atk, def, spd }` — the sum of `value` over every flat main/sub line (missing → 0);
- `pct = { hp, atk, def, spd }` — the sum over every percent line **plus set bonuses**;
- `sets` — an object with a key only for each set that is completed at least once: `count(pieces of that set among equipped artifacts) / SETS[set].pieces`, floored. Each completed copy adds its bonus once (four `swift` pieces = two bonuses = +24 `spd%`). Keys in `SETS` order.
Slots are visited in `SLOTS` order (the sums do not depend on it, but iterate that way).
- No gear → `{ flat: { hp: 0, atk: 0, def: 0, spd: 0 }, pct: { hp: 0, atk: 0, def: 0, spd: 0 }, sets: {} }`.
- All six samples → `flat { hp: 450, atk: 40, def: 70, spd: 15 }`, `pct { hp: 6, atk: 30, def: 31, spd: 12 }`, `sets { swift: 1, sturdy: 1, fierce: 1 }` (atk% = 5 + 10 + 15 fierce; def% = 4 + 12 + 15 sturdy; spd% = 12 swift).
- ember-blade + wind-boots only → `flat { hp: 0, atk: 40, def: 0, spd: 15 }`, `pct { hp: 0, atk: 5, def: 0, spd: 0 }`, `sets {}`.
- Four `relentless` pieces (weapon, helmet, shield, gloves; each `main atk 10`) → `flat.atk 40`, `pct.atk 30`, `sets { relentless: 1 }`; six such pieces → still `{ relentless: 1 }` (6 / 4 floors to 1).
- Four `swift` pieces (each `main spd 1`) → `flat.spd 4`, `pct.spd 24`, `sets { swift: 2 }`.
- After `unequip(k, "boots")` on the fully geared kael → `sets { sturdy: 1, fierce: 1 }` (swift broken).

## Stage 3 — geared stats
**`gearedStats(champion)`** — for each of `hp`, `atk`, `def`, `spd`: `Math.floor((stats[k] + flat[k]) * (100 + pct[k]) / 100)` (integer arithmetic: add the flat bonus to the champion's current `stats[k]`, multiply by `(100 + pct)`, divide by 100, floor). `crit`, `critDmg` copied. Returns exactly `{ hp, atk, def, spd, crit, critDmg }`.
- kael no gear → `{ hp: 1500, atk: 130, def: 90, spd: 104, crit: 0.3, critDmg: 1.6 }`.
- kael + all six → `{ hp: 2067, atk: 221, def: 209, spd: 133, crit: 0.3, critDmg: 1.6 }` (hp: (1500+450)×106/100 = 2067; atk: 170×130/100 = 221; def: 160×131/100 = 209.6 → 209; spd: 119×112/100 = 133.28 → 133).
- kael + ember-blade + wind-boots → `atk 178` (170 × 105 / 100 = 178.5), `spd 119`, `hp 1500`, `def 90`.
- kael + four relentless (atk 10 each) → `atk 221`; six → `atk 247` (190 × 130 / 100).
- kael + four swift (spd 1 each) → `spd 133` (108 × 124 / 100 = 133.92).

**`applyGear(champion)`** — a new champion whose `stats` is `gearedStats(champion)` and whose `hp` is that new `stats.hp` (re-gearing happens outside battle and restores full health); `base`, `level`, `xp`, `skills`, `gear` copied. kael + all six → `stats.hp 2067`, `hp 2067`, `level 1`, gear keys unchanged. Putting the result through `gearedStats` again would stack the gear a second time — that is expected and not the caller's concern (the tests never do it).

## Non-goals
No artifact levels or upgrades, no rank/rarity on artifacts, no changes to `raid.mjs`, no extra keys on the exact-shape objects above.
