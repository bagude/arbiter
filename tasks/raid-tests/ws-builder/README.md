# Task: `raid-tests`

Write the test suite for `src/raid.mjs`, the core of a turn-based squad RPG (seeded RNG, champions that level up, affinity damage, a speed-driven turn meter, buffs and cooldowns, a deterministic auto-battle, summoning, a campaign). The implementation is given and correct; do not modify it.

The deliverable is `src/raid.test.mjs`: a `node:test` suite (`import { test } from "node:test"`, `import assert from "node:assert/strict"`, `import * as R from "./raid.mjs"`) that runs with:

```
node --test src/raid.test.mjs
```

How it is graded, host-side, after you hand off:

1. The suite must pass against the given `src/raid.mjs` and contain at least 10 tests. A suite that fails on the given module scores nothing.
2. The suite is then run against a number of secretly mutated copies of `src/raid.mjs` — each with one small planted bug (an off-by-one, a wrong constant, a flipped comparison, a missing clamp) somewhere in stages 1–6. A planted bug counts as caught when at least one of your tests fails against that copy. The score is the number of bugs caught.

So the suite has to pin down exact behaviour: exact RNG values, exact stat and damage numbers, exact turn order and tie-breaks, exact battle logs for given seeds, exact cooldown, effect, summon and reward rules. Vague tests ("returns a number", "does not throw") catch nothing. Your counterpart holds the full specification of `src/raid.mjs` with worked numeric examples for every function; ask for the behaviours and expected values you need, and probe the given implementation to confirm any value before asserting it.

Constraints:
- Only create or modify `src/raid.test.mjs`. Never edit `src/raid.mjs`. No packages, config files or build step.
- Tests must be deterministic (seeded) and fast (the whole suite well under 30 s).
- Test with `node --test src/raid.test.mjs` from the workspace root, always with an explicit timeout.
