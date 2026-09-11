`decline` — a five-stage Arps decline-curve analysis (DCA) pipeline: rate at a time, cumulative production to a time, the hand-off from hyperbolic to terminal exponential decline, a piecewise forecast sampled at caller-chosen times, and an estimated ultimate recovery (EUR) down to an economic rate limit. All five are `export function`s in `src/decline.mjs`, ordered by dependency; each is independently callable and testable. All numbers are IEEE doubles. Inputs are never mutated; every returned array/object is freshly allocated and has **exactly** the keys listed, no extras.

## Units (fixed, no conversion anywhere)
- `t` — time in **years**, measured from the start of decline (`t = 0`).
- `Di`, `Dmin` — **nominal** decline rates in **1/year** (so `b = 0` means `q = qi·e^(−Di·t)`, not an effective/annualised percentage).
- `qi`, `q`, `qLimit` — rate in **volume per year**.
- `Np`, `eur` — cumulative volume, same volume unit. So `Np` is exactly `∫₀ᵗ q dt` with no day/year factor.

## Errors
Exactly one error kind. Throw a `TypeError` whose message starts with `invalid argument` when any argument fails validation. Missing arguments count as invalid. Validate **all** arguments before computing anything; never return `NaN`, `null`, or `undefined` in place of throwing. `-0` counts as `0`.

## Validation vocabulary
- *finite number*: `typeof === "number"` and `Number.isFinite`. `NaN`, `±Infinity`, `"5"`, `null` are all invalid.
- *qi*: finite number `> 0`. *Di*: finite number `> 0`. *Dmin*: finite number `> 0`. *qLimit*: finite number `> 0`.
- *b*: finite number with `0 ≤ b ≤ 1`. `-0.1` and `1.5` are invalid; `0` and `1` are valid.
- *t*: finite number `≥ 0`. Negative time is invalid; `0` is valid.
- *times*: an `Array` of length `0..100` inclusive whose every element is a *t*. `101` entries, a non-array, or any bad element is invalid. Elements need not be sorted or distinct.
Every stage checks the curve parameters `(qi, Di, b)` this way, then its own extra arguments.

## Numerical branches (this is the crux)
Dispatch on `b` **by exact equality**, not by a tolerance:
- `b === 0` → exponential closed forms.
- `b === 1` → harmonic closed form (only cumulative needs its own branch; the rate formula below already covers it).
- otherwise → hyperbolic closed forms, which must be **numerically stable for any `b` in `(0, 1)`**, including `b = 1e-10` and `b = 1 − 1e-9`. Naive `Math.pow(1 + b·Di·t, −1/b)` loses ~1e-7 relative at `b = 1e-10`, and naive `(1 − (1+b·Di·t)^(1−1/b)) / (1−b)` loses ~1e-7 at `b = 1 − 1e-9`; both fail the 1e-9 relative tolerance below. Use `Math.log1p` / `Math.expm1`: `(1 + x)^p = exp(p · log1p(x))` and `1 − e^y = −expm1(y)`. Hint freely if asked.

Tolerance: unless a case says otherwise, results must agree with the values below to **1e-9 relative** (`|actual − expected| ≤ 1e-9 · |expected|`; for an expected `0`, absolute 1e-12). Any algebraically equivalent, equally stable evaluation is fine.

## Stage 1 — `declineRate(qi, Di, b, t)`
Rate at time `t`. Returns a finite number `> 0`.
```
b = 0 :  q = qi · exp(−Di·t)
b > 0 :  q = qi · (1 + b·Di·t)^(−1/b)          (b = 1 gives qi / (1 + Di·t))
```
- `declineRate(1000, 0.5, 0, 2)` → `367.87944117144235`
- `declineRate(1000, 0.5, 0.5, 2)` → `444.4444444444444` (= 1000 / 1.5²)
- `declineRate(1000, 0.5, 1, 2)` → `500`
- `declineRate(800, 1.2, 0.3, 3.5)` → `52.81150246596597`
- `declineRate(1000, 0.5, 0.9, 10)` → `150.4439714349996`
- `declineRate(1000, 0.5, 1e-10, 2)` → `367.8794411898363` (within 1e-9 relative of the `b = 0` value — the stability check)
- `declineRate(qi, Di, b, 0)` → exactly `qi` for every valid `b`.
- `declineRate(1000, 0.5, 0.5, -1)`, `declineRate(0, 0.5, 0.5, 1)`, `declineRate(1000, 0, 0.5, 1)`, `declineRate(1000, 0.5, 1.5, 1)`, `declineRate(1000, 0.5, -0.1, 1)`, `declineRate(1000, 0.5, 0.5, NaN)`, `declineRate("1000", 0.5, 0.5, 1)` → `TypeError` `invalid argument…`

## Stage 2 — `cumulativeProduction(qi, Di, b, t)`
`Np(t) = ∫₀ᵗ q(τ) dτ`, closed form:
```
b = 0     :  Np = qi/Di · (1 − exp(−Di·t))
0 < b < 1 :  Np = qi / ((1−b)·Di) · (1 − (1 + b·Di·t)^(1 − 1/b))
b = 1     :  Np = qi/Di · ln(1 + Di·t)
```
- `cumulativeProduction(1000, 0.5, 0, 2)` → `1264.2411176571154`
- `cumulativeProduction(1000, 0.5, 0.5, 2)` → `1333.3333333333335` (= 4000/3)
- `cumulativeProduction(1000, 0.5, 1, 2)` → `1386.2943611198905` (= 2000·ln 2)
- `cumulativeProduction(800, 1.2, 0.3, 3.5)` → `810.2928624129963`
- `cumulativeProduction(1000, 0.5, 1e-10, 2)` → `1264.2411176731757` (stability near 0)
- `cumulativeProduction(1000, 0.5, 1 − 1e-9, 2)` → `1386.294361025732` (stability near 1)
- `cumulativeProduction(1000, 0.5, 0, 1e-6)` → `0.0009999997500000416` (small `t`)
- `cumulativeProduction(1000, 0.5, 0, 60)` → `1999.9999999998129` (≈ `qi/Di`, the exponential asymptote)
- `cumulativeProduction(qi, Di, b, 0)` → exactly `0` for every valid `b`.
- Monotone: for `t2 > t1`, `Np(t2) > Np(t1)`.
- Same invalid inputs as stage 1.

## Stage 3 — `terminalSwitch(qi, Di, b, Dmin)`
The instantaneous nominal decline of a hyperbolic curve is `D(t) = Di / (1 + b·Di·t)`. The *terminal decline* `Dmin` is a floor on `D`: production follows the hyperbolic curve until `D(t) = Dmin`, then declines exponentially at `Dmin` forever. Return `{ tSwitch, qSwitch, NpSwitch }` — the switch time, the rate at the switch, and the cumulative at the switch:
```
Di ≤ Dmin          :  tSwitch = 0,        qSwitch = qi, NpSwitch = 0        (already at/below the floor; exponential at Dmin from t = 0)
Di > Dmin, b = 0   :  tSwitch = Infinity, qSwitch = 0,  NpSwitch = qi/Di    (exponential steeper than the floor never reaches it)
Di > Dmin, b > 0   :  tSwitch = (Di/Dmin − 1) / (b·Di)
                      qSwitch  = declineRate(qi, Di, b, tSwitch)
                      NpSwitch = cumulativeProduction(qi, Di, b, tSwitch)
```
`tSwitch` is a number in every case (`Infinity` is a number; never `null`). Precision: `tSwitch` to 1e-12 relative (it is one division), the other two to 1e-9 relative.
- `terminalSwitch(1000, 0.8, 0.5, 0.1)` → `{ tSwitch: 17.5, qSwitch: 15.625, NpSwitch: 2187.5 }` — the **canonical well** used below
- `terminalSwitch(1000, 0.8, 1, 0.1)` → `{ tSwitch: 8.75, qSwitch: 125, NpSwitch: 2599.3019270997947 }`
- `terminalSwitch(800, 1.2, 0.3, 0.06)` → `{ tSwitch: 52.77777777777778, qSwitch: 0.036840314986403874, NpSwitch: 951.5038020241333 }`
- `terminalSwitch(1000, 0.8, 0, 0.1)` → `{ tSwitch: Infinity, qSwitch: 0, NpSwitch: 1250 }`
- `terminalSwitch(1000, 0.05, 0.5, 0.1)`, `terminalSwitch(1000, 0.1, 0.5, 0.1)` (equal), `terminalSwitch(1000, 0.05, 0, 0.1)` → `{ tSwitch: 0, qSwitch: 1000, NpSwitch: 0 }`
- `Dmin = 0`, `Dmin = -0.1`, `Dmin = Infinity`, missing `Dmin`, or any bad curve parameter → `TypeError` `invalid argument…`

## Stage 4 — `forecastAt(qi, Di, b, Dmin, times)`
Sample the piecewise curve at each requested time. Let `S = terminalSwitch(qi, Di, b, Dmin)`. Return a new array, same length and order as `times`, of objects `{ t, q, Np }` with `t` the requested time (as given) and:
```
t ≤ S.tSwitch :  q  = declineRate(qi, Di, b, t)
                 Np = cumulativeProduction(qi, Di, b, t)
t > S.tSwitch :  q  = S.qSwitch · exp(−Dmin·(t − S.tSwitch))
                 Np = S.NpSwitch + S.qSwitch/Dmin · (1 − exp(−Dmin·(t − S.tSwitch)))
```
The curve is continuous in both `q` and `Np` at `tSwitch`. The length cap of 100 is deliberate: callers pick the points; the function never generates a schedule of its own.
- `forecastAt(1000, 0.8, 0.5, 0.1, [0, 5, 17.5, 20, 30, 50])` →
  `[{t:0, q:1000, Np:0}, {t:5, q:111.11111111111113, Np:1666.6666666666665}, {t:17.5, q:15.625, Np:2187.5}, {t:20, q:12.168762235490707, Np:2222.062377645093}, {t:30, q:4.476637450940472, Np:2298.9836254905954}, {t:50, q:0.6058469973706566, Np:2337.6915300262935}]`
  (note `t = 20` is *not* `1000/(1+0.4·20)²` = 12.35 — it is on the exponential tail)
- `forecastAt(1000, 0.8, 0, 0.1, [0, 1, 10])` → `q: [1000, 449.3289641172216, 0.33546262790251186]`, `Np: [0, 688.338794853473, 1249.5806717151218]` (pure exponential at `Di`, switch never happens)
- `forecastAt(1000, 0.05, 0.5, 0.1, [0, 2, 10])` → `q: [1000, 818.7307530779818, 367.87944117144235]`, `Np: [0, 1812.6924692201815, 6321.205588285577]` (exponential at `Dmin = 0.1` from `t = 0`; `Di` and `b` play no role)
- `forecastAt(800, 1.2, 0.3, 0.06, [1, 40, 60])` → `q: [287.05181183500923, 0.08804153061158296, 0.023885209742148063]`, `Np: [487.63039988617555, 950.7668576530734, 951.7197204448709]`
- `forecastAt(1000, 0.8, 0.5, 0.1, [])` → `[]`
- `forecastAt(1000, 0.8, 0.5, 0.1, [30, 5])` → same values as above in the order `[30, 5]`.
- `times` of 101 zeros, `times = 5`, `times = [1, -1]`, `times = [1, "2"]`, `times = [NaN]` → `TypeError` `invalid argument…` (and nothing is returned for the valid prefix).

## Stage 5 — `estimateEUR(qi, Di, b, Dmin, qLimit)`
Follow the stage-4 curve until the rate first equals the economic limit `qLimit`; report the cumulative at that moment. Return `{ eur, tLimit, tSwitch }` — three numbers, never a schedule. `tSwitch` is always `terminalSwitch(...).tSwitch` (reported even when unused). Let `S = terminalSwitch(qi, Di, b, Dmin)`:
```
qLimit ≥ qi          :  eur = 0, tLimit = 0                            (uneconomic from the start)
qLimit ≥ S.qSwitch   :  limit is hit on the hyperbolic segment (or exactly at the switch):
                        b = 0 : tLimit = ln(qi/qLimit) / Di
                        b > 0 : tLimit = ((qi/qLimit)^b − 1) / (b·Di)  (stable form: expm1(b·ln(qi/qLimit)) / (b·Di))
                        eur = cumulativeProduction(qi, Di, b, tLimit)
qLimit < S.qSwitch   :  limit is hit on the exponential tail:
                        tLimit = S.tSwitch + ln(S.qSwitch/qLimit) / Dmin
                        eur    = S.NpSwitch + (S.qSwitch − qLimit) / Dmin
```
Ordering of the checks matters: `qLimit ≥ qi` first. When `S.tSwitch = Infinity`, `S.qSwitch = 0 < qLimit` so the second branch always applies.

**Verifiable property** (the point of the stage): for every valid input with `qLimit < qi`, `forecastAt(qi, Di, b, Dmin, [tLimit])[0]` has `q ≈ qLimit` and `Np ≈ eur`, both within 1e-9 relative. CRITIC should check this on any suspicious case rather than asking for a series.

- `estimateEUR(1000, 0.8, 0.5, 0.1, 10)` → `{ eur: 2243.75, tLimit: 21.962871026284198, tSwitch: 17.5 }` (tail: `2187.5 + (15.625 − 10)/0.1`)
- `estimateEUR(1000, 0.8, 0.5, 0.1, 20)` → `{ eur: 2146.4466094067266, tLimit: 15.177669529663685, tSwitch: 17.5 }` (hyperbolic segment: `20 > 15.625`)
- `estimateEUR(1000, 0.8, 0.5, 0.1, 15.625)` → `{ eur: 2187.5, tLimit: 17.5, tSwitch: 17.5 }` (exactly at the switch; 1e-9 relative)
- `estimateEUR(1000, 0.8, 0.5, 0.1, 1000)` and `estimateEUR(1000, 0.8, 0.5, 0.1, 5000)` → `{ eur: 0, tLimit: 0, tSwitch: 17.5 }`
- `estimateEUR(1000, 0.8, 0, 0.1, 10)` → `{ eur: 1237.5, tLimit: 5.756462732485114, tSwitch: Infinity }`
- `estimateEUR(1000, 0.05, 0, 0.1, 10)` and `estimateEUR(1000, 0.05, 0.5, 0.1, 10)` → `{ eur: 9900, tLimit: 46.051701859880914, tSwitch: 0 }` (exponential at `Dmin` from `t = 0`: `(1000 − 10)/0.1`)
- `estimateEUR(1000, 0.8, 1, 0.1, 10)` → `{ eur: 3749.3019270997947, tLimit: 34.007286443082556, tSwitch: 8.75 }`
- `estimateEUR(800, 1.2, 0.3, 0.06, 5)` → `{ eur: 925.0957792977105, tLimit: 9.955302994401821, tSwitch: 52.77777777777778 }`
- `estimateEUR(1000, 0.8, 1e-10, 0.1, 10)` → `eur ≈ 1237.5000001179935`, `tLimit ≈ 5.756462733810588` (1e-9 relative; a `pow`-based `tLimit` fails this)
- `qLimit = 0`, `qLimit = -5`, `qLimit = NaN`, missing `qLimit`, or any bad curve / `Dmin` → `TypeError` `invalid argument…`

## Non-goals
No curve fitting to data, no effective-vs-nominal decline conversion, no day/month/year unit handling, no `b > 1`, no internally generated time series, no typed arrays, no extra keys on returned objects.
