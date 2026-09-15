`raid-timeline` — deterministic animation keyframes for a `raid` battle log, so a page can replay a battle without any logic of its own. The core (`src/raid.mjs`) is given and complete; do not change it (it is only needed to produce battles for testing — the timeline module itself takes plain data). The deliverable is `src/timeline.mjs` (plain ESM, Node.js, no dependencies). Four functions in three stages. Pure: inputs untouched, results fresh.

## Errors
`TypeError` whose message starts with `invalid argument` for any invalid argument (missing counts as invalid). Never return `NaN`, `null` or `undefined` in place of throwing (`turnAt` returns `null` by design after the end — that is a documented value, not an error).

## Constants (exported)
`TURN_MS = 600`, `LUNGE_MS = 150`, `HIT_GAP_MS = 100`, `FLASH_MS = 80`, `LUNGE_X = 0.6`.

## Vocabulary
- *units*: a non-empty array of `{ side: 0|1, hp: <integer ≥ 0> }` (extra keys ignored) — the state at the **start** of the turn/battle, global index order as in `runBattle`.
- *log entry*: `{ turn: <integer ≥ 1>, actor: <index into units>, skill: <integer ≥ 0>, hits: [{ target: <index>, damage: <integer ≥ 0>, crit: <boolean>, killed: <boolean> }, …] }` — exactly the shape `runBattle` logs.
- *frame*: `{ t: <ms>, unit: <index>, prop: "offsetX" | "flash" | "hp" | "visible", value }`. Values: `offsetX` a number; `flash` `"hit"`, `"crit"` or `null`; `hp` an integer; `visible` a boolean.

## Stage 1 — `turnTimeline(entry, units)`
Keyframes for one entry, times relative to the turn's start. Emit, in **this order**:
1. `{ t: 0, unit: actor, prop: "offsetX", value: +LUNGE_X if units[actor].side === 0 else -LUNGE_X }` (the actor lunges toward the other side), then `{ t: LUNGE_MS, unit: actor, prop: "offsetX", value: 0 }`.
2. For each hit `i` (0-based), with `at = LUNGE_MS + i * HIT_GAP_MS` and the target's running hp reduced by `damage` (floored at 0, carried across hits on the same target within the turn): `{ t: at, unit: target, prop: "flash", value: crit ? "crit" : "hit" }`, `{ t: at, unit: target, prop: "hp", value: <new hp> }`, `{ t: at + FLASH_MS, unit: target, prop: "flash", value: null }`, and if `killed`, `{ t: at + FLASH_MS, unit: target, prop: "visible", value: false }`.
Return **exactly** `{ frames, duration, hp }` with `duration = Math.max(TURN_MS, <t of the last frame> + HIT_GAP_MS)` and `hp` the array of every unit's hp after the turn.
- Battle `runBattle([kael, vell], [grim, nyx], 1)` (all level 1, `units` = `[{side 0, hp 1500}, {side 0, hp 1250}, {side 1, hp 1800}, {side 1, hp 1400}]`), turn 1 (`actor 3, skill 2, hits [{target 1, damage 294, crit false, killed false}]`) → frames `[{0, 3, offsetX, -0.6}, {150, 3, offsetX, 0}, {150, 1, flash, "hit"}, {150, 1, hp, 956}, {230, 1, flash, null}]`, `duration 600`, `hp [1500, 956, 1800, 1400]`.
- Turn 6 of that battle (`actor 0, skill 1, hits [{2, 124}, {3, 107}]` neither crit) with units hp `[1500, 956, 1800, 1055]` → 8 frames: lunge `+0.6`/`0`, then for target 2 at `150`: `flash "hit"`, `hp 1676`, `230: flash null`; for target 3 at `250`: `flash "hit"`, `hp 948`, `330: flash null`; `duration 600`, `hp [1500, 956, 1676, 948]`.
- Turn 3 (`actor 1, skill 1, hits []`) → just the two lunge frames (`+0.6` then `0` on unit 1), `duration 600`, `hp` unchanged.
- `{ turn: 9, actor: 2, skill: 0, hits: [{ target: 1, damage: 500, crit: true, killed: true }] }` with units hp `[1500, 120, 1800, 1055]` → frames `[{0, 2, offsetX, -0.6}, {150, 2, offsetX, 0}, {150, 1, flash, "crit"}, {150, 1, hp, 0}, {230, 1, flash, null}, {230, 1, visible, false}]`, `hp [1500, 0, 1800, 1055]`.
- Five hits alternating targets 2 and 3, `damage 1` each → 17 frames, the last `{ t: 630, unit: 2, prop: "flash", value: null }`, `duration 730`.
- Invalid: empty `units`, `side 2`, `hp -1`, `entry.actor` out of range, a hit whose `target` is out of range, `damage 1.5`, `crit "yes"` → `TypeError invalid argument…`.

## Stage 2 — `battleTimeline(battle, initialUnits)`
`battle` an object with a `log` array of entries (a `runBattle` result works as is); `initialUnits` the units before turn 1. Turns play back to back: turn k starts at the sum of the durations of turns before it. Returns **exactly** `{ frames, turns, total }`: `frames` = every turn's frames with `t` made absolute (`start + t`) and a `turn` field added, in turn order then emission order; `turns` = `[{ turn, start, duration }, …]`; `total` = the sum of all durations. The running hp carries from turn to turn (each turn's `hp` result feeds the next).
- The seed-1 battle (35 turns) → `total 21000`, `163` frames, `turns.length 35`, `turns[6]` = `{ turn: 7, start: 3600, duration: 600 }`; `frames[5]` = `{ t: 600, unit: 0, prop: "offsetX", value: 0.6, turn: 2 }`.
- `runBattle(A, B, 1, 3)` → `total 1800`, frames as `[t, turn, unit, prop, value]`: `[0,1,3,offsetX,-0.6] [150,1,3,offsetX,0] [150,1,1,flash,"hit"] [150,1,1,hp,956] [230,1,1,flash,null] [600,2,0,offsetX,0.6] [750,2,0,offsetX,0] [750,2,3,flash,"crit"] [750,2,3,hp,1055] [830,2,3,flash,null] [1200,3,1,offsetX,0.6] [1350,3,1,offsetX,0]`.
- `battle` without a `log` array → `TypeError invalid argument…`.

## Stage 3 — `stateAt(timeline, initialUnits, t)` and `turnAt(timeline, t)`
**`stateAt`** — `timeline` from stage 2 (needs `frames`), `t` a finite number ≥ 0. Start every unit at `{ offsetX: 0, flash: null, hp: <initial hp>, visible: <initial hp > 0> }`, then apply every frame with `frame.t <= t` **in array order** (`state[unit][prop] = value`). Return the array of the four-key objects (exactly those keys, in that order).
- Seed-1 battle at `t = 0` → unit 3 `{ offsetX: -0.6, flash: null, hp: 1400, visible: true }`, others at rest with initial hp; at `100` the same; at `750` → unit 1 `hp 956`, unit 3 `{ offsetX: 0, flash: "crit", hp: 1055, visible: true }`; at `1000` → unit 3 flash `null`; at `t = total` (21000) → hp `[1103, 0, 0, 0]`, visible `[true, false, false, false]`.
- `t` negative or `NaN`, `timeline` without `frames` → `TypeError invalid argument…`.

**`turnAt`** — the `turn` whose `[start, start + duration)` contains `t`, or `null` when `t` is at or past the end. Seed-1 battle: `t = 0 → 1`, `599 → 1`, `600 → 2`, `1199 → 2`, `1200 → 3`, `20999 → 35`, `21000 → null`, `99999 → null`.

## Non-goals
No easing, no camera keyframes, no rendering, no changes to `raid.mjs` or the page.
