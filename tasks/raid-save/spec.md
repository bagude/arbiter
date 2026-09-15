`raid-save` — save files for the `raid` squad-RPG core: canonical JSON, a checksum, save/load with full validation, and save diffs. The core (`src/raid.mjs`: `makeChampion`, `MAX_LEVEL`, champions) is given and complete; do not change it. The deliverable is `src/save.mjs` (plain ESM, Node.js, no dependencies) importing what it needs from `./raid.mjs`. Three stages. Nothing is mutated; every returned object is fresh.

## Errors
- `TypeError` whose message starts with `invalid argument` for invalid arguments to any function (missing counts as invalid), including a *state* whose contents fail validation (stage 2).
- `RangeError` for a *save string* that cannot be loaded, with these message prefixes: `malformed save` (wrong overall shape or payload not JSON), `unsupported version` (wrong prefix or wrong `version` field), `checksum mismatch`.
- Never return `NaN`, `null` or `undefined` in place of throwing.

## Constants (exported)
`SAVE_VERSION = 1`, `SAVE_PREFIX = "RAID1"`.

## Stage 1 — `canonical(value)` and `fnv1a(str)`
**`canonical(value)`** — a deterministic JSON string: object keys sorted (ascending, by `Array.prototype.sort` default order) at every level, no whitespace, arrays in order, `null`/booleans/strings/numbers as `JSON.stringify` renders them (so `-0` → `0`, `1e21` → `1e+21`), object properties whose value is `undefined` dropped. Throw `TypeError invalid argument…` for `NaN`, `±Infinity`, functions, symbols, bigints, or an `undefined` value that is not an object property (top level or inside an array).
- `canonical({ b: 1, a: [true, null, "x", { z: 1, y: 2 }], c: undefined })` → `{"a":[true,null,"x",{"y":2,"z":1}],"b":1}`
- `canonical([1.5, -0, 1e21, 0.1])` → `[1.5,0,1e+21,0.1]`
- `canonical("é")` → `"é"` (JSON string quoting, no escaping of non-ASCII); `canonical(NaN)`, `canonical([undefined])`, `canonical(() => 1)` → `TypeError invalid argument…`.

**`fnv1a(str)`** — 32-bit FNV-1a over the **UTF-8 bytes** of `str`: `h = 0x811c9dc5`; for each byte `h ^= b; h = Math.imul(h, 0x01000193)`; return `(h >>> 0).toString(16).padStart(8, "0")` (eight lowercase hex characters). Non-string → `TypeError invalid argument…`.
- `fnv1a("")` → `811c9dc5`; `"a"` → `e40c292c`; `"hello"` → `4f9f2cab`; `"raid"` → `93a3c591`; `"The quick brown fox"` → `ae4d67e2`.

## Stage 2 — `saveGame(state)` and `loadGame(text)`
A *state* is `{ roster, silver, stage, seed }`: `roster` an array of champions (each with `id, name, affinity, rarity, base, skills, level, xp, hp`), `silver` integer ≥ 0, `stage` integer ≥ 1, `seed` integer. Validation of each roster entry: `level` integer in `1..MAX_LEVEL`, `xp` integer ≥ 0, the def part (`id, name, affinity, rarity, base, skills`) must be accepted by `makeChampion(def, level)` (wrap its `TypeError` message as `invalid argument: state.roster[i]: …`), ids unique across the roster, `hp` an integer in `0..<that champion's stats.hp>`.

**`saveGame(state)`** — validates, then builds `payload = canonical({ version: 1, silver, stage, seed, roster })` where each roster entry is **exactly** `{ id, name, affinity, rarity, base, skills, level, xp, hp }` (skills as `makeChampion` normalises them, i.e. every skill has an `effects` array; `stats` is **not** stored — it is derived on load). Returns the string `` `${SAVE_PREFIX}:${fnv1a(payload)}:${payload}` ``.
- `saveGame({ roster: [], silver: 0, stage: 1, seed: 0 })` → `RAID1:f1cb777e:{"roster":[],"seed":0,"silver":0,"stage":1,"version":1}` (exact).
- `state = { roster: [makeChampion(kael), addXp(makeChampion(vell), 30)], silver: 1200, stage: 3, seed: 7 }` → a 913-character string whose checksum field is `ae340678` and which starts with `RAID1:ae340678:{"roster":[{"affinity":"force","base":{"atk":`.
- Same state but `roster[0].hp = 10` → a different string (different checksum); loading it gives `hp 10` back.
- Invalid: `silver -1`, `stage 0`, `seed 1.5`, `roster` not an array, a roster entry with `hp` above its max or `level 61` or a duplicated id → `TypeError invalid argument…`.

**`loadGame(text)`** — non-string → `TypeError`. The string must match `^([A-Z0-9]+):([0-9a-f]{8}):([\s\S]*)$` else `RangeError malformed save…`; prefix ≠ `RAID1` → `RangeError unsupported version: prefix <prefix>`; `fnv1a(payload)` ≠ the checksum field → `RangeError checksum mismatch…` (checked **before** parsing the payload); payload not JSON → `RangeError malformed save…`; parsed `version` ≠ 1 → `RangeError unsupported version: <version>`. Then the payload's `roster/silver/stage/seed` go through the same validation as `saveGame` (so a well-formed, correctly checksummed save with an impossible `hp` throws `TypeError invalid argument…`). Returns **exactly** `{ roster, silver, stage, seed }` where every roster entry is a full champion: `makeChampion(def, level)` with `xp` and `hp` restored (`stats` recomputed).
- Loading the 913-char save above → `silver 1200, stage 3, seed 7`, roster `[kael level 1 xp 0 hp 1500 (stats.hp 1500), vell level 2 xp 5 hp 1300 (stats.hp 1300)]`; `saveGame(loadGame(s)) === s` (round trip is byte-exact).
- Replacing `"silver":1200` by `"silver":9999` in the string → `RangeError checksum mismatch: expected 4aab38bd, found ae340678`.
- `"RAID2:" + rest` → `RangeError unsupported version: prefix RAID2`; `"nope"` → `RangeError malformed save…`; a correctly checksummed payload with `"version":2` → `RangeError unsupported version: 2`.

## Stage 3 — `diffSaves(a, b)`
Loads both (so their errors propagate) and returns an object with a key **only for what changed**: `silver: [old, new]`, `stage: [old, new]`, `seed: [old, new]`, and `roster: { added: [ids in b not in a, in b's order], removed: [ids in a not in b, in a's order], leveled: [{ id, from, to } for ids in both whose level differs, in a's order] }` — `roster` present only if at least one of the three lists is non-empty (then all three keys are present, possibly empty).
- `diffSaves(s, s)` → `{}`.
- From the 1200-silver state to `{ roster: [addXp(kael, 25), makeChampion(nyx)], silver: 1300, stage: 4, seed: 7 }` → `{ silver: [1200, 1300], stage: [3, 4], roster: { added: ["nyx"], removed: ["vell"], leveled: [{ id: "kael", from: 1, to: 2 }] } }`.

## Non-goals
No compression, no encryption, no migration of other versions, no changes to `raid.mjs`, no extra keys on the exact-shape objects.
