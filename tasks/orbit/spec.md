`orbit` — a five-stage numerical pipeline: 2-D point-mass gravity, classical RK4, a fixed-step integrator, orbital invariants, and a full simulation that reports how well the integrator conserves them. All five are `export function`s in `src/orbit.mjs`. Stages are ordered by dependency; each is independently callable and testable. All numbers are IEEE doubles. Nothing is ever mutated: every input array is left untouched and every returned array/object is freshly allocated.

A **state** is a plain array of finite numbers. For stages 1, 4, 5 it is exactly `[x, y, vx, vy]` (position, velocity). For stages 2, 3 it is any non-empty length.

## Errors
Exactly two error kinds, checked in this order: argument validation first, then singularity.
- Throw a `TypeError` whose message starts with `invalid argument` when any argument fails validation (see each stage). Missing arguments count as invalid.
- Throw a `TypeError` whose message starts with `invalid derivative` when a caller-supplied derivative function returns something other than an array of finite numbers with the same length as the state.
- Throw a `RangeError` whose message starts with `singularity` when a 4-vector state has `x === 0 && y === 0` (position exactly at the origin). Only stages 1, 4 (and 5 through them) raise this.
- Any other error thrown by a caller-supplied derivative function propagates unchanged.
Never return `NaN`, `null`, or `undefined` in place of throwing. `-0` counts as `0`.

## Validation vocabulary
- *finite number*: `typeof === "number"` and `Number.isFinite`. `NaN`, `±Infinity`, numeric strings, `null` are all invalid.
- *state*: an `Array`, non-empty, every element a finite number. `[1, "0", 0, 1]` is invalid; `[]` is invalid.
- *state4*: a state of length exactly 4.
- *mu*: a finite number `> 0`. `0` is invalid.
- *count*: `Number.isInteger(n) && n >= 0`. `1.5`, `-1`, `"3"` are invalid; `0` is valid.
- *h*: a finite number. **Negative and zero are valid.**

## Stage 1 — `gravityDeriv(state, mu)`
`state` is a *state4*, `mu` is a *mu*. Return `[vx, vy, ax, ay]` where with `r = Math.hypot(x, y)`:
```
ax = -mu * x / r^3
ay = -mu * y / r^3
```
- `gravityDeriv([1, 0, 0, 1], 1)` → `[0, 1, -1, 0]`
- `gravityDeriv([3, 4, 0.5, -0.25], 2)` → `[0.5, -0.25, -0.048, -0.064]`
- `gravityDeriv([-2, -2, 0, 0], 1)` → `[0, 0, 2/8^1.5, 2/8^1.5]` (acceleration points toward the origin)
- `gravityDeriv([0, 0, 1, 1], 1)` → throws `RangeError` `singularity…`
- `gravityDeriv([1, 0, 0], 1)`, `gravityDeriv([1, 0, 0, NaN], 1)`, `gravityDeriv([1, 0, 0, 1], 0)` → throw `TypeError` `invalid argument…`

Tolerance expected: results agree with the formula to 1e-14 relative. Any algebraically equivalent evaluation order is fine.

## Stage 2 — `rk4Step(f, t, state, h)`
Generic classical fourth-order Runge–Kutta, one step. `f` must be a function (else *invalid argument*), `t` and `h` finite numbers, `state` a *state* of any length `N ≥ 1`. `f(t, s)` is called with a time and a state and must return a derivative array of length `N` of finite numbers (else *invalid derivative*). Return a **new** array of length `N`:
```
k1 = f(t,       state)
k2 = f(t + h/2, state + (h/2)·k1)
k3 = f(t + h/2, state + (h/2)·k2)
k4 = f(t + h,   state + h·k3)
out = state + (h/6)·(k1 + 2·k2 + 2·k3 + k4)
```
Vector expressions are elementwise. `f` is called **exactly four times**, in that order, with exactly those `t` values (`t`, `t + h/2`, `t + h/2`, `t + h`, computed as written). Passing `state` itself as the first call's argument is fine; `state` must not be modified.
- `rk4Step((t, s) => [s[0]], 0, [1], 0.1)` → `[1.1051708333333333]` (= 1 + h + h²/2 + h³/6 + h⁴/24, exact to 1e-15)
- `rk4Step((t) => [t*t*t], 0, [0], 2)` → `[4]` (RK4 is exact for polynomial derivatives of degree ≤ 3 in `t`)
- `rk4Step((t) => [3*t*t], 1, [1], 0.5)` → `[3.375]`
- `rk4Step((t, s) => [s[1], -s[0]], 0, [1, 0], 0.5)` → `[0.8776041666666666, -0.47916666666666663]`
- `rk4Step(f, 0, [1], -0.1)` with `f = (t, s) => [s[0]]` → `[0.9048375]` (negative `h` steps backward)
- `rk4Step(f, 0, s, 0)` → an array equal to `s` but `!== s`
- `rk4Step((t, s) => [1, 2], 0, [1], 0.1)`, `f` returning `1`, `[NaN]`, `[Infinity]` → throw `TypeError` `invalid derivative…`
- `rk4Step("f", 0, [1], 0.1)`, `rk4Step(f, NaN, [1], 0.1)`, `rk4Step(f, 0, [], 0.1)`, `rk4Step(f, 0, [1], "0.1")` → throw `TypeError` `invalid argument…`
- If `f` throws, that error propagates as-is (same object).

Tolerance expected: 1e-14 absolute on the examples above. No adaptive stepping, no other tableau.

## Stage 3 — `integrate(f, t0, state0, h, n)`
Fixed-step trajectory. `f` a function, `t0` and `h` finite numbers, `state0` a *state*, `n` a *count*. Return `{ t, states }`:
- `t` is an array of length `n + 1` with `t[i] = t0 + i * h` computed **exactly as that product** (not by repeated addition). So `integrate(f, 0, [0], 0.1, 10).t[8] === 0.8` and `.t[3] === 0.30000000000000004`.
- `states` is an array of length `n + 1`. `states[0]` is a copy of `state0` (deep-equal, `!== state0`). `states[i+1] = rk4Step(f, t[i], states[i], h)`. Every entry is a distinct array.
- `n = 0` → `{ t: [t0], states: [copy of state0] }`; `f` is never called.
- `f` receives the running time: for `integrate(f, 1, [0], 0.5, 2)` the sequence of `t` seen by `f` is `[1, 1.25, 1.25, 1.5, 1.5, 1.75, 1.75, 2]`.
- `integrate((t, s) => [s[0]], 0, [1], 0.1, 10).states[10][0]` ≈ `Math.E` within 1e-5 and equals `1.1051708333333333 ** 10` within 1e-13.
- `integrate((t, s) => [s[1], -s[0]], 0, [1, 0], -0.1, 10)` → `t[10] = -1`, `states[10]` ≈ `[0.540302967116884, 0.8414704778002743]` (1e-14).
- Invalid: `f` not a function, `t0`/`h` not finite, `state0` not a state, `n` = `-1`, `1.5`, `"3"`, or missing → `TypeError` `invalid argument…`.
- Errors from `f` (including `RangeError singularity…` from a wrapped `gravityDeriv`) propagate unchanged.

## Stage 4 — `invariants(state, mu)`
`state` a *state4*, `mu` a *mu*. Return an object with **exactly** the keys `energy` and `angularMomentum`:
```
energy          = (vx² + vy²) / 2 − mu / r        (specific orbital energy)
angularMomentum = x·vy − y·vx                     (specific angular momentum, z-component, signed)
```
- `invariants([1, 0, 0, 1], 1)` → `{ energy: -0.5, angularMomentum: 1 }`
- `invariants([1, 0, 0, 1.2], 1)` → `{ energy: -0.28, angularMomentum: 1.2 }`
- `invariants([0, 2, 1, 0], 1)` → `{ energy: 0, angularMomentum: -2 }` (retrograde is negative)
- `invariants([3, 4, 1, 1], 1)` → `{ energy: 0.8, angularMomentum: -1 }` (positive energy = unbound)
- `invariants([7000, 0, 0, 7.5], 398600.4418)` → `{ energy: -28.817920257142852, angularMomentum: 52500 }` (1e-12 / 1e-9)
- `invariants([0, 0, 0, 1], 1)` → throws `RangeError` `singularity…`; shape/`mu` failures → `TypeError` `invalid argument…`.

## Stage 5 — `simulateOrbit(state0, mu, h, n)`
`state0` a *state4*, `mu` a *mu*, `h` a finite number, `n` a *count*. Integrate `state0` under `gravityDeriv(·, mu)` from `t0 = 0` for `n` steps of `h` using stage 3, then evaluate stage 4 at every sample. Return an object with **exactly** these six keys:
- `t`, `states` — exactly the arrays stage 3 returns (length `n + 1`).
- `energy`, `angularMomentum` — arrays of length `n + 1`, `energy[i]` / `angularMomentum[i]` = `invariants(states[i], mu)`.
- `energyDrift = max over i in 0..n of |energy[i] − energy[0]|`
- `angularMomentumDrift = max over i in 0..n of |angularMomentum[i] − angularMomentum[0]|`
Both drifts are **absolute** (not relative), non-negative, and exactly `0` when `n = 0`. They must equal the max computed from the returned arrays bit-for-bit (`===`).

Examples (`mu = 1` unless noted):
- `simulateOrbit([1, 0, 0, 1], 1, 0.1, 0)` → `{ t: [0], states: [[1,0,0,1]], energy: [-0.5], angularMomentum: [1], energyDrift: 0, angularMomentumDrift: 0 }`
- `simulateOrbit([1, 0, 0, 1], 1, 2π/1000, 1000)` — one full circular period: `states[1000]` ≈ `[1, 0, 0, 1]` within 1e-8; `t[1000]` ≈ `2π` within 1e-12; `hypot(x, y)` ≈ 1 within 1e-9 at every sample; both drifts `< 1e-10`.
- `simulateOrbit([1, 0, 0, 1.2], 1, 0.01, 2000)` — ellipse: `states[100]` ≈ `[0.5756971781027864, 1.0376962988039127, -0.7287029921568849, 0.770939339276758]` (1e-12); `states[2000]` ≈ `[-2.0982268754850053, 1.0873140837623023, -0.3834154832594913, -0.3732231982461854]` (1e-9); `energyDrift` ≈ `4.676e-11` (±5e-12); `angularMomentumDrift` ≈ `4.81e-12` (±1e-12).
- Same ellipse with `h = 0.1, n = 200` → `energyDrift` ≈ `1.0167779e-6`, `angularMomentumDrift` ≈ `4.878266e-7` (±1e-10). Coarser step, larger drift — this is the point of the check.
- `simulateOrbit([7000, 0, 0, 7.5], 398600.4418, 10, 600)` → `states[600]` ≈ `[6691.752042925979, 2041.5570203251996, -2.2155151640110597, 7.169557263143043]` (1e-6); `t[600]` = 6000; `energyDrift < 1e-8`; `angularMomentumDrift < 1e-5`.
- Reversibility: running the ellipse forward 300 steps of `0.01`, then `simulateOrbit(final, 1, -0.01, 300)` returns to `[1, 0, 0, 1.2]` within 1e-9, with `t[300] = -3`.
- `state0` at the origin → `RangeError` `singularity…` even when `n = 0`. Invalid shapes / `mu ≤ 0` / non-finite `h` / bad `n` → `TypeError` `invalid argument…`.

## Non-goals
No adaptive step size, no 3-D, no units conversion, no symplectic integrators, no typed arrays (return plain `Array`s), no extra keys on returned objects.
