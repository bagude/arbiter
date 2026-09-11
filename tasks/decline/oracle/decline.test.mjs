import { test } from "node:test";
import assert from "node:assert/strict";
import { declineRate, cumulativeProduction, terminalSwitch, forecastAt, estimateEUR } from "./src/decline.mjs";

// ---- helpers ---------------------------------------------------------------

// Relative tolerance; absolute 1e-12 when expected is 0.
function rel(actual, expected, tol = 1e-9, msg = "") {
  assert.ok(typeof actual === "number", `${msg} expected number, got ${typeof actual}`);
  if (!Number.isFinite(expected)) {
    assert.equal(actual, expected, `${msg} expected ${expected}, got ${actual}`);
    return;
  }
  assert.ok(Number.isFinite(actual), `${msg} expected finite number, got ${String(actual)}`);
  const bound = expected === 0 ? 1e-12 : tol * Math.abs(expected);
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${msg} |${actual} - ${expected}| = ${Math.abs(actual - expected)} > ${bound}`,
  );
}

function relObj(actual, expected, tol = 1e-9, msg = "") {
  assert.ok(actual && typeof actual === "object" && !Array.isArray(actual), `${msg} expected object`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${msg} keys`);
  for (const k of Object.keys(expected)) rel(actual[k], expected[k], tol, `${msg}.${k}`);
}

function throwsInvalid(fn) {
  assert.throws(
    fn,
    (e) => e instanceof TypeError && e.message.startsWith("invalid argument"),
    'expected TypeError "invalid argument..."',
  );
}

// Canonical well: qi = 1000, Di = 0.8, b = 0.5, Dmin = 0.1 -> tSwitch 17.5, qSwitch 15.625, NpSwitch 2187.5
const W = [1000, 0.8, 0.5, 0.1];

// ---- Stage 1: declineRate ----------------------------------------------------

test("declineRate: exponential b = 0", () => {
  rel(declineRate(1000, 0.5, 0, 2), 367.87944117144235);
});

test("declineRate: hyperbolic b = 0.5", () => {
  rel(declineRate(1000, 0.5, 0.5, 2), 444.4444444444444);
});

test("declineRate: harmonic b = 1", () => {
  rel(declineRate(1000, 0.5, 1, 2), 500);
});

test("declineRate: hyperbolic b = 0.3 and b = 0.9", () => {
  rel(declineRate(800, 1.2, 0.3, 3.5), 52.81150246596597);
  rel(declineRate(1000, 0.5, 0.9, 10), 150.4439714349996);
});

test("declineRate: t = 0 returns qi exactly for every branch", () => {
  assert.equal(declineRate(1000, 0.5, 0, 0), 1000);
  assert.equal(declineRate(1000, 0.5, 0.5, 0), 1000);
  assert.equal(declineRate(1000, 0.5, 1, 0), 1000);
  assert.equal(declineRate(1000, 0.5, 0.5, -0), 1000);
});

test("declineRate: numerically stable for tiny b (log1p, not naive pow)", () => {
  rel(declineRate(1000, 0.5, 1e-10, 2), 367.8794411898363);
  rel(declineRate(1000, 0.5, 1e-10, 2), declineRate(1000, 0.5, 0, 2), 1e-9);
});

test("declineRate: strictly decreasing in t", () => {
  const a = declineRate(1000, 0.5, 0.7, 1);
  const c = declineRate(1000, 0.5, 0.7, 1.0001);
  assert.ok(c < a);
});

test("declineRate: invalid arguments throw TypeError", () => {
  throwsInvalid(() => declineRate(1000, 0.5, 0.5, -1));
  throwsInvalid(() => declineRate(0, 0.5, 0.5, 1));
  throwsInvalid(() => declineRate(1000, 0, 0.5, 1));
  throwsInvalid(() => declineRate(1000, 0.5, 1.5, 1));
  throwsInvalid(() => declineRate(1000, 0.5, -0.1, 1));
  throwsInvalid(() => declineRate(1000, 0.5, 0.5, NaN));
  throwsInvalid(() => declineRate(1000, 0.5, 0.5, Infinity));
  throwsInvalid(() => declineRate("1000", 0.5, 0.5, 1));
  throwsInvalid(() => declineRate(1000, 0.5, 0.5));
});

// ---- Stage 2: cumulativeProduction ------------------------------------------

test("cumulativeProduction: exponential b = 0", () => {
  rel(cumulativeProduction(1000, 0.5, 0, 2), 1264.2411176571154);
});

test("cumulativeProduction: hyperbolic b = 0.5 (= 4000/3)", () => {
  rel(cumulativeProduction(1000, 0.5, 0.5, 2), 1333.3333333333335);
});

test("cumulativeProduction: harmonic b = 1 (= 2000 ln 2)", () => {
  rel(cumulativeProduction(1000, 0.5, 1, 2), 1386.2943611198905);
});

test("cumulativeProduction: hyperbolic b = 0.3", () => {
  rel(cumulativeProduction(800, 1.2, 0.3, 3.5), 810.2928624129963);
});

test("cumulativeProduction: stable for b near 0", () => {
  rel(cumulativeProduction(1000, 0.5, 1e-10, 2), 1264.2411176731757);
});

test("cumulativeProduction: stable for b near 1", () => {
  rel(cumulativeProduction(1000, 0.5, 1 - 1e-9, 2), 1386.294361025732);
});

test("cumulativeProduction: small t and long t", () => {
  rel(cumulativeProduction(1000, 0.5, 0, 1e-6), 0.0009999997500000416);
  rel(cumulativeProduction(1000, 0.5, 0, 60), 1999.9999999998129);
});

test("cumulativeProduction: t = 0 is exactly 0 for every branch", () => {
  assert.equal(cumulativeProduction(1000, 0.5, 0, 0), 0);
  assert.equal(cumulativeProduction(1000, 0.5, 0.5, 0), 0);
  assert.equal(cumulativeProduction(1000, 0.5, 1, 0), 0);
});

test("cumulativeProduction: monotone increasing and consistent with the rate (finite difference)", () => {
  const n1 = cumulativeProduction(1000, 0.5, 0.6, 3);
  const n2 = cumulativeProduction(1000, 0.5, 0.6, 3.001);
  assert.ok(n2 > n1);
  const qMid = declineRate(1000, 0.5, 0.6, 3.0005);
  rel((n2 - n1) / 0.001, qMid, 1e-6);
});

test("cumulativeProduction: invalid arguments throw TypeError", () => {
  throwsInvalid(() => cumulativeProduction(1000, 0.5, 0.5, -0.001));
  throwsInvalid(() => cumulativeProduction(-1000, 0.5, 0.5, 1));
  throwsInvalid(() => cumulativeProduction(1000, -0.5, 0.5, 1));
  throwsInvalid(() => cumulativeProduction(1000, 0.5, 2, 1));
  throwsInvalid(() => cumulativeProduction(1000, 0.5, null, 1));
  throwsInvalid(() => cumulativeProduction(1000, Infinity, 0.5, 1));
});

// ---- Stage 3: terminalSwitch --------------------------------------------------

test("terminalSwitch: canonical well", () => {
  relObj(terminalSwitch(...W), { tSwitch: 17.5, qSwitch: 15.625, NpSwitch: 2187.5 });
  rel(terminalSwitch(...W).tSwitch, 17.5, 1e-12);
});

test("terminalSwitch: harmonic b = 1", () => {
  relObj(terminalSwitch(1000, 0.8, 1, 0.1), { tSwitch: 8.75, qSwitch: 125, NpSwitch: 2599.3019270997947 });
});

test("terminalSwitch: b = 0.3, low Dmin", () => {
  relObj(terminalSwitch(800, 1.2, 0.3, 0.06), {
    tSwitch: 52.77777777777778,
    qSwitch: 0.036840314986403874,
    NpSwitch: 951.5038020241333,
  });
});

test("terminalSwitch: b = 0 with Di > Dmin never switches (Infinity)", () => {
  const s = terminalSwitch(1000, 0.8, 0, 0.1);
  assert.deepEqual(Object.keys(s).sort(), ["NpSwitch", "qSwitch", "tSwitch"]);
  assert.equal(s.tSwitch, Infinity);
  assert.equal(s.qSwitch, 0);
  rel(s.NpSwitch, 1250);
});

test("terminalSwitch: Di <= Dmin switches at t = 0", () => {
  relObj(terminalSwitch(1000, 0.05, 0.5, 0.1), { tSwitch: 0, qSwitch: 1000, NpSwitch: 0 });
  relObj(terminalSwitch(1000, 0.1, 0.5, 0.1), { tSwitch: 0, qSwitch: 1000, NpSwitch: 0 });
  relObj(terminalSwitch(1000, 0.05, 0, 0.1), { tSwitch: 0, qSwitch: 1000, NpSwitch: 0 });
});

test("terminalSwitch: decline at the switch equals Dmin (self-consistency)", () => {
  const [qi, Di, b, Dmin] = [1500, 1.1, 0.7, 0.08];
  const s = terminalSwitch(qi, Di, b, Dmin);
  rel(Di / (1 + b * Di * s.tSwitch), Dmin, 1e-12);
  rel(s.qSwitch, declineRate(qi, Di, b, s.tSwitch));
  rel(s.NpSwitch, cumulativeProduction(qi, Di, b, s.tSwitch));
});

test("terminalSwitch: returns a fresh object each call", () => {
  assert.notEqual(terminalSwitch(...W), terminalSwitch(...W));
});

test("terminalSwitch: invalid arguments throw TypeError", () => {
  throwsInvalid(() => terminalSwitch(1000, 0.8, 0.5, 0));
  throwsInvalid(() => terminalSwitch(1000, 0.8, 0.5, -0.1));
  throwsInvalid(() => terminalSwitch(1000, 0.8, 0.5, Infinity));
  throwsInvalid(() => terminalSwitch(1000, 0.8, 0.5));
  throwsInvalid(() => terminalSwitch(1000, 0.8, 1.2, 0.1));
});

// ---- Stage 4: forecastAt -------------------------------------------------------

test("forecastAt: canonical well across the switch", () => {
  const f = forecastAt(...W, [0, 5, 17.5, 20, 30, 50]);
  assert.ok(Array.isArray(f));
  assert.equal(f.length, 6);
  const exp = [
    { t: 0, q: 1000, Np: 0 },
    { t: 5, q: 111.11111111111113, Np: 1666.6666666666665 },
    { t: 17.5, q: 15.625, Np: 2187.5 },
    { t: 20, q: 12.168762235490707, Np: 2222.062377645093 },
    { t: 30, q: 4.476637450940472, Np: 2298.9836254905954 },
    { t: 50, q: 0.6058469973706566, Np: 2337.6915300262935 },
  ];
  exp.forEach((e, i) => relObj(f[i], e, 1e-9, `[${i}]`));
});

test("forecastAt: past the switch is NOT the hyperbolic value", () => {
  const q20 = forecastAt(...W, [20])[0].q;
  const hyp20 = declineRate(1000, 0.8, 0.5, 20);
  assert.ok(Math.abs(q20 - hyp20) > 0.1, `q(20)=${q20} should differ from hyperbolic ${hyp20}`);
});

test("forecastAt: b = 0 with Di > Dmin is pure exponential at Di", () => {
  const f = forecastAt(1000, 0.8, 0, 0.1, [0, 1, 10]);
  relObj(f[0], { t: 0, q: 1000, Np: 0 });
  relObj(f[1], { t: 1, q: 449.3289641172216, Np: 688.338794853473 });
  relObj(f[2], { t: 10, q: 0.33546262790251186, Np: 1249.5806717151218 });
});

test("forecastAt: Di < Dmin is exponential at Dmin from t = 0", () => {
  const f = forecastAt(1000, 0.05, 0.5, 0.1, [0, 2, 10]);
  relObj(f[1], { t: 2, q: 818.7307530779818, Np: 1812.6924692201815 });
  relObj(f[2], { t: 10, q: 367.87944117144235, Np: 6321.205588285577 });
});

test("forecastAt: b = 0.3 well deep in the tail", () => {
  const f = forecastAt(800, 1.2, 0.3, 0.06, [1, 40, 60]);
  relObj(f[0], { t: 1, q: 287.05181183500923, Np: 487.63039988617555 });
  relObj(f[1], { t: 40, q: 0.08804153061158296, Np: 950.7668576530734 });
  relObj(f[2], { t: 60, q: 0.023885209742148063, Np: 951.7197204448709 });
});

test("forecastAt: continuous in q and Np across the switch", () => {
  // Over a 2e-9-year window the curve itself moves by ~1e-11 relative; a discontinuity would be O(1).
  const [lo, hi] = forecastAt(...W, [17.5 - 1e-9, 17.5 + 1e-9]);
  rel(hi.q, lo.q, 1e-7);
  rel(hi.Np, lo.Np, 1e-9);
});

test("forecastAt: empty times, unsorted times, input untouched", () => {
  assert.deepEqual(forecastAt(...W, []), []);
  const times = [30, 5];
  const f = forecastAt(...W, times);
  assert.equal(f[0].t, 30);
  assert.equal(f[1].t, 5);
  rel(f[1].q, 111.11111111111113);
  assert.deepEqual(times, [30, 5]);
});

test("forecastAt: accepts exactly 100 times", () => {
  const f = forecastAt(...W, Array.from({ length: 100 }, (_, i) => i * 0.5));
  assert.equal(f.length, 100);
  rel(f[99].Np, forecastAt(...W, [49.5])[0].Np, 1e-12);
});

test("forecastAt: invalid times throw TypeError", () => {
  throwsInvalid(() => forecastAt(...W, new Array(101).fill(0)));
  throwsInvalid(() => forecastAt(...W, 5));
  throwsInvalid(() => forecastAt(...W, [1, -1]));
  throwsInvalid(() => forecastAt(...W, [1, "2"]));
  throwsInvalid(() => forecastAt(...W, [NaN]));
  throwsInvalid(() => forecastAt(...W));
  throwsInvalid(() => forecastAt(1000, 0.8, 0.5, 0, [1]));
});

// ---- Stage 5: estimateEUR --------------------------------------------------------

test("estimateEUR: canonical well, limit hit on the exponential tail", () => {
  relObj(estimateEUR(...W, 10), { eur: 2243.75, tLimit: 21.962871026284198, tSwitch: 17.5 });
});

test("estimateEUR: canonical well, limit hit on the hyperbolic segment", () => {
  relObj(estimateEUR(...W, 20), { eur: 2146.4466094067266, tLimit: 15.177669529663685, tSwitch: 17.5 });
});

test("estimateEUR: limit exactly at the switch rate", () => {
  relObj(estimateEUR(...W, 15.625), { eur: 2187.5, tLimit: 17.5, tSwitch: 17.5 });
});

test("estimateEUR: economic limit at or above qi gives zero", () => {
  relObj(estimateEUR(...W, 1000), { eur: 0, tLimit: 0, tSwitch: 17.5 });
  relObj(estimateEUR(...W, 5000), { eur: 0, tLimit: 0, tSwitch: 17.5 });
});

test("estimateEUR: b = 0 with Di > Dmin (tSwitch Infinity)", () => {
  const e = estimateEUR(1000, 0.8, 0, 0.1, 10);
  assert.deepEqual(Object.keys(e).sort(), ["eur", "tLimit", "tSwitch"]);
  rel(e.eur, 1237.5);
  rel(e.tLimit, 5.756462732485114);
  assert.equal(e.tSwitch, Infinity);
});

test("estimateEUR: Di < Dmin is exponential at Dmin regardless of b", () => {
  relObj(estimateEUR(1000, 0.05, 0, 0.1, 10), { eur: 9900, tLimit: 46.051701859880914, tSwitch: 0 });
  relObj(estimateEUR(1000, 0.05, 0.5, 0.1, 10), { eur: 9900, tLimit: 46.051701859880914, tSwitch: 0 });
});

test("estimateEUR: harmonic and b = 0.3 wells", () => {
  relObj(estimateEUR(1000, 0.8, 1, 0.1, 10), { eur: 3749.3019270997947, tLimit: 34.007286443082556, tSwitch: 8.75 });
  relObj(estimateEUR(800, 1.2, 0.3, 0.06, 5), { eur: 925.0957792977105, tLimit: 9.955302994401821, tSwitch: 52.77777777777778 });
});

test("estimateEUR: tiny b stays stable (expm1 form of tLimit)", () => {
  const e = estimateEUR(1000, 0.8, 1e-10, 0.1, 10);
  rel(e.eur, 1237.5000001179935);
  rel(e.tLimit, 5.756462733810588);
});

test("estimateEUR: verifiable property - forecastAt(tLimit) reproduces qLimit and eur", () => {
  const cases = [
    [1000, 0.8, 0.5, 0.1, 10],
    [1000, 0.8, 0.5, 0.1, 20],
    [800, 1.2, 0.3, 0.06, 5],
    [1000, 0.8, 0, 0.1, 10],
    [1000, 0.8, 1, 0.1, 10],
    [2500, 0.6, 0.85, 0.07, 3],
  ];
  for (const c of cases) {
    const e = estimateEUR(...c);
    const f = forecastAt(c[0], c[1], c[2], c[3], [e.tLimit])[0];
    rel(f.q, c[4], 1e-9, `q ${JSON.stringify(c)}`);
    rel(f.Np, e.eur, 1e-9, `Np ${JSON.stringify(c)}`);
  }
});

test("estimateEUR: lower economic limit gives larger EUR and later tLimit", () => {
  const a = estimateEUR(...W, 10);
  const c = estimateEUR(...W, 1);
  assert.ok(c.eur > a.eur);
  assert.ok(c.tLimit > a.tLimit);
});

test("estimateEUR: invalid arguments throw TypeError", () => {
  throwsInvalid(() => estimateEUR(...W, 0));
  throwsInvalid(() => estimateEUR(...W, -5));
  throwsInvalid(() => estimateEUR(...W, NaN));
  throwsInvalid(() => estimateEUR(...W));
  throwsInvalid(() => estimateEUR(1000, 0.8, 0.5, 0, 10));
  throwsInvalid(() => estimateEUR(1000, 0.8, 0.5, 0.1, "10"));
});
