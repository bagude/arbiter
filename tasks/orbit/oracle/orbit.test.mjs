import { test } from "node:test";
import assert from "node:assert/strict";
import { gravityDeriv, rk4Step, integrate, invariants, simulateOrbit } from "./src/orbit.mjs";

// ---- helpers ---------------------------------------------------------------

function near(actual, expected, tol, msg = "") {
  assert.ok(
    typeof actual === "number" && Number.isFinite(actual),
    `${msg} expected finite number, got ${String(actual)}`,
  );
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} |${actual} - ${expected}| = ${Math.abs(actual - expected)} > ${tol}`,
  );
}

function nearArray(actual, expected, tol, msg = "") {
  assert.ok(Array.isArray(actual), `${msg} expected array`);
  assert.equal(actual.length, expected.length, `${msg} length`);
  for (let i = 0; i < expected.length; i++) near(actual[i], expected[i], tol, `${msg}[${i}]`);
}

function throwsType(fn, prefix) {
  assert.throws(fn, (e) => e instanceof TypeError && e.message.startsWith(prefix), `expected TypeError "${prefix}..."`);
}

function throwsRange(fn, prefix) {
  assert.throws(fn, (e) => e instanceof RangeError && e.message.startsWith(prefix), `expected RangeError "${prefix}..."`);
}

const sho = (t, s) => [s[1], -s[0]]; // simple harmonic oscillator, omega = 1
const expo = (t, s) => [s[0]]; // y' = y

// ---- Stage 1: gravityDeriv -----------------------------------------------------

test("gravityDeriv: unit circular state", () => {
  nearArray(gravityDeriv([1, 0, 0, 1], 1), [0, 1, -1, 0], 1e-15);
});

test("gravityDeriv: 3-4-5 position, mu = 2", () => {
  nearArray(gravityDeriv([3, 4, 0.5, -0.25], 2), [0.5, -0.25, -0.048, -0.064], 1e-15);
});

test("gravityDeriv: negative quadrant, acceleration points toward origin", () => {
  const d = gravityDeriv([-2, -2, 0, 0], 1);
  const r3 = Math.pow(8, 1.5);
  nearArray(d, [0, 0, 2 / r3, 2 / r3], 1e-15);
});

test("gravityDeriv: returns a new array, does not mutate input", () => {
  const s = [1, 0, 0, 1];
  const d = gravityDeriv(s, 1);
  assert.notEqual(d, s);
  assert.deepEqual(s, [1, 0, 0, 1]);
});

test("gravityDeriv: origin is a singularity (RangeError)", () => {
  throwsRange(() => gravityDeriv([0, 0, 1, 1], 1), "singularity");
});

test("gravityDeriv: bad state shapes throw TypeError 'invalid argument'", () => {
  throwsType(() => gravityDeriv([1, 0, 0], 1), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, 1, 0], 1), "invalid argument");
  throwsType(() => gravityDeriv("1,0,0,1", 1), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, NaN], 1), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, Infinity], 1), "invalid argument");
  throwsType(() => gravityDeriv([1, "0", 0, 1], 1), "invalid argument");
});

test("gravityDeriv: bad mu throws TypeError 'invalid argument'", () => {
  throwsType(() => gravityDeriv([1, 0, 0, 1], 0), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, 1], -1), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, 1], NaN), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, 1], "1"), "invalid argument");
  throwsType(() => gravityDeriv([1, 0, 0, 1]), "invalid argument");
});

// ---- Stage 2: rk4Step ---------------------------------------------------------

test("rk4Step: y' = y, one step equals the degree-4 Taylor polynomial", () => {
  // 1 + h + h^2/2 + h^3/6 + h^4/24 at h = 0.1
  near(rk4Step(expo, 0, [1], 0.1)[0], 1.1051708333333333, 1e-15);
});

test("rk4Step: exact for y' = t^3", () => {
  // y(2) = 2^4 / 4 = 4; with f depending only on t, RK4 is Simpson's rule, exact through degree 3
  near(rk4Step((t) => [t * t * t], 0, [0], 2)[0], 4, 1e-14);
});

test("rk4Step: exact for y' = 3t^2 with nonzero t0", () => {
  // y(t) = t^3; from t=1 to t=1.5: delta = 3.375 - 1 = 2.375
  near(rk4Step((t) => [3 * t * t], 1, [1], 0.5)[0], 3.375, 1e-14);
});

test("rk4Step: harmonic oscillator, h = 0.5", () => {
  nearArray(rk4Step(sho, 0, [1, 0], 0.5), [0.8776041666666666, -0.47916666666666663], 1e-15);
});

test("rk4Step: gravity one step from unit circle", () => {
  const f = (t, s) => gravityDeriv(s, 1);
  nearArray(
    rk4Step(f, 0, [1, 0, 0, 1], 0.1),
    [0.9950041589614718, 0.09983333216634041, -0.09983348937979505, 0.9950041587863584],
    1e-14,
  );
});

test("rk4Step: negative h steps backward", () => {
  near(rk4Step(expo, 0, [1], -0.1)[0], 0.9048375, 1e-15);
});

test("rk4Step: h = 0 returns an equal copy, not the same array", () => {
  const s = [2, -3, 0.5];
  const out = rk4Step((t, x) => x.map((v) => v * 7), 0, s, 0);
  assert.deepEqual(out, [2, -3, 0.5]);
  assert.notEqual(out, s);
});

test("rk4Step: does not mutate state", () => {
  const s = [1, 0];
  rk4Step(sho, 0, s, 0.3);
  assert.deepEqual(s, [1, 0]);
});

test("rk4Step: f is called exactly 4 times at t, t+h/2, t+h/2, t+h", () => {
  const calls = [];
  const f = (t, s) => {
    calls.push(t);
    return s.map(() => 1);
  };
  rk4Step(f, 2, [0, 0], 0.5);
  assert.deepEqual(calls, [2, 2.25, 2.25, 2.5]);
});

test("rk4Step: works for 1-dimensional and 6-dimensional states", () => {
  near(rk4Step((t, s) => [1], 0, [0], 1)[0], 1, 1e-15);
  const out = rk4Step((t, s) => s.map((v, i) => i), 0, [0, 0, 0, 0, 0, 0], 2);
  nearArray(out, [0, 2, 4, 6, 8, 10], 1e-15);
});

test("rk4Step: invalid arguments throw TypeError 'invalid argument'", () => {
  throwsType(() => rk4Step("f", 0, [1], 0.1), "invalid argument");
  throwsType(() => rk4Step(expo, NaN, [1], 0.1), "invalid argument");
  throwsType(() => rk4Step(expo, 0, [], 0.1), "invalid argument");
  throwsType(() => rk4Step(expo, 0, [1, NaN], 0.1), "invalid argument");
  throwsType(() => rk4Step(expo, 0, 1, 0.1), "invalid argument");
  throwsType(() => rk4Step(expo, 0, [1], Infinity), "invalid argument");
  throwsType(() => rk4Step(expo, 0, [1], "0.1"), "invalid argument");
});

test("rk4Step: bad derivative output throws TypeError 'invalid derivative'", () => {
  throwsType(() => rk4Step((t, s) => [1, 2], 0, [1], 0.1), "invalid derivative");
  throwsType(() => rk4Step((t, s) => 1, 0, [1], 0.1), "invalid derivative");
  throwsType(() => rk4Step((t, s) => [NaN], 0, [1], 0.1), "invalid derivative");
  throwsType(() => rk4Step((t, s) => [Infinity], 0, [1], 0.1), "invalid derivative");
});

test("rk4Step: errors thrown by f propagate unchanged", () => {
  const boom = new Error("boom");
  assert.throws(() => rk4Step(() => { throw boom; }, 0, [1], 0.1), (e) => e === boom);
});

// ---- Stage 3: integrate ---------------------------------------------------------

test("integrate: n = 0 returns just the initial state as a copy", () => {
  const s0 = [1, 2];
  const r = integrate(sho, 5, s0, 0.1, 0);
  assert.deepEqual(r.t, [5]);
  assert.deepEqual(r.states, [[1, 2]]);
  assert.notEqual(r.states[0], s0);
});

test("integrate: does not mutate state0", () => {
  const s0 = [1, 0];
  integrate(sho, 0, s0, 0.1, 20);
  assert.deepEqual(s0, [1, 0]);
});

test("integrate: t[i] is t0 + i*h, not an accumulated sum", () => {
  const r = integrate((t, s) => [1], 0, [0], 0.1, 10);
  assert.equal(r.t.length, 11);
  assert.equal(r.t[3], 0.30000000000000004);
  assert.equal(r.t[8], 0.8); // accumulated summation would give 0.7999999999999999
  assert.equal(r.t[10], 1);
});

test("integrate: y' = y over 10 steps matches exp within RK4 error", () => {
  const r = integrate(expo, 0, [1], 0.1, 10);
  assert.equal(r.states.length, 11);
  near(r.states[10][0], Math.E, 1e-5); // RK4 global error at h = 0.1 is ~2e-6
  // each step multiplies by the same factor
  near(r.states[1][0], 1.1051708333333333, 1e-15);
  near(r.states[10][0], Math.pow(1.1051708333333333, 10), 1e-13);
});

test("integrate: harmonic oscillator, 100 steps of 0.1", () => {
  const r = integrate(sho, 0, [1, 0], 0.1, 100);
  near(r.states[100][0], Math.cos(10), 1e-5);
  near(r.states[100][1], -Math.sin(10), 1e-5);
  near(r.t[100], 10, 1e-12);
});

test("integrate: negative h integrates backward in time", () => {
  const r = integrate(sho, 0, [1, 0], -0.1, 10);
  near(r.t[10], -1, 1e-12);
  nearArray(r.states[10], [0.540302967116884, 0.8414704778002743], 1e-14);
});

test("integrate: f receives the running t, not t0", () => {
  const seen = [];
  const f = (t, s) => { seen.push(t); return [0]; };
  integrate(f, 1, [0], 0.5, 2);
  assert.deepEqual(seen, [1, 1.25, 1.25, 1.5, 1.5, 1.75, 1.75, 2]);
});

test("integrate: each state is a distinct array", () => {
  const r = integrate((t, s) => [0], 0, [1], 1, 3);
  const set = new Set(r.states);
  assert.equal(set.size, 4);
});

test("integrate: invalid arguments throw TypeError 'invalid argument'", () => {
  throwsType(() => integrate(null, 0, [1], 0.1, 1), "invalid argument");
  throwsType(() => integrate(expo, Infinity, [1], 0.1, 1), "invalid argument");
  throwsType(() => integrate(expo, 0, [], 0.1, 1), "invalid argument");
  throwsType(() => integrate(expo, 0, [1], NaN, 1), "invalid argument");
  throwsType(() => integrate(expo, 0, [1], 0.1, -1), "invalid argument");
  throwsType(() => integrate(expo, 0, [1], 0.1, 1.5), "invalid argument");
  throwsType(() => integrate(expo, 0, [1], 0.1, "3"), "invalid argument");
  throwsType(() => integrate(expo, 0, [1], 0.1), "invalid argument");
});

test("integrate: derivative errors propagate (singularity mid-trajectory)", () => {
  // Start exactly on the origin so the first derivative call throws RangeError.
  const f = (t, s) => gravityDeriv(s, 1);
  throwsRange(() => integrate(f, 0, [0, 0, 1, 0], 0.1, 5), "singularity");
});

// ---- Stage 4: invariants ---------------------------------------------------------

test("invariants: circular unit orbit", () => {
  const inv = invariants([1, 0, 0, 1], 1);
  near(inv.energy, -0.5, 1e-15);
  near(inv.angularMomentum, 1, 1e-15);
});

test("invariants: elliptical, mu = 1", () => {
  const inv = invariants([1, 0, 0, 1.2], 1);
  near(inv.energy, -0.28, 1e-15);
  near(inv.angularMomentum, 1.2, 1e-15);
});

test("invariants: retrograde orbit has negative angular momentum", () => {
  const inv = invariants([0, 2, 1, 0], 1);
  near(inv.angularMomentum, -2, 1e-15);
  near(inv.energy, 0.5 - 0.5, 1e-15);
});

test("invariants: hyperbolic (positive energy) state", () => {
  const inv = invariants([3, 4, 1, 1], 1);
  near(inv.energy, 1 - 0.2, 1e-15);
  near(inv.angularMomentum, 3 * 1 - 4 * 1, 1e-15);
});

test("invariants: Earth-like units", () => {
  const inv = invariants([7000, 0, 0, 7.5], 398600.4418);
  near(inv.energy, -28.817920257142852, 1e-12);
  near(inv.angularMomentum, 52500, 1e-9);
});

test("invariants: result has exactly the two keys", () => {
  assert.deepEqual(Object.keys(invariants([1, 0, 0, 1], 1)).sort(), ["angularMomentum", "energy"]);
});

test("invariants: origin throws RangeError, bad inputs throw TypeError", () => {
  throwsRange(() => invariants([0, 0, 0, 1], 1), "singularity");
  throwsType(() => invariants([1, 0, 0], 1), "invalid argument");
  throwsType(() => invariants([1, 0, 0, 1], 0), "invalid argument");
  throwsType(() => invariants([1, 0, 0, null], 1), "invalid argument");
});

// ---- Stage 5: simulateOrbit ---------------------------------------------------------

test("simulateOrbit: n = 0 has zero drift and one sample", () => {
  const r = simulateOrbit([1, 0, 0, 1], 1, 0.1, 0);
  assert.deepEqual(r.t, [0]);
  assert.deepEqual(r.states, [[1, 0, 0, 1]]);
  assert.equal(r.energy.length, 1);
  assert.equal(r.angularMomentum.length, 1);
  assert.equal(r.energyDrift, 0);
  assert.equal(r.angularMomentumDrift, 0);
});

test("simulateOrbit: result shape", () => {
  const r = simulateOrbit([1, 0, 0, 1], 1, 0.1, 5);
  assert.deepEqual(
    Object.keys(r).sort(),
    ["angularMomentum", "angularMomentumDrift", "energy", "energyDrift", "states", "t"],
  );
  assert.equal(r.t.length, 6);
  assert.equal(r.states.length, 6);
  assert.equal(r.energy.length, 6);
  assert.equal(r.angularMomentum.length, 6);
  near(r.energy[0], -0.5, 1e-15);
  near(r.angularMomentum[0], 1, 1e-15);
});

test("simulateOrbit: unit circular orbit returns to start after one period", () => {
  const n = 1000;
  const r = simulateOrbit([1, 0, 0, 1], 1, (2 * Math.PI) / n, n);
  nearArray(r.states[n], [1, 0, 0, 1], 1e-8);
  near(r.t[n], 2 * Math.PI, 1e-12);
  // radius stays 1 throughout
  for (const s of r.states) near(Math.hypot(s[0], s[1]), 1, 1e-9);
  assert.ok(r.energyDrift < 1e-10, `energyDrift ${r.energyDrift}`);
  assert.ok(r.angularMomentumDrift < 1e-10, `angularMomentumDrift ${r.angularMomentumDrift}`);
});

test("simulateOrbit: elliptical orbit, fine step", () => {
  const r = simulateOrbit([1, 0, 0, 1.2], 1, 0.01, 2000);
  nearArray(r.states[100], [0.5756971781027864, 1.0376962988039127, -0.7287029921568849, 0.770939339276758], 1e-12);
  nearArray(r.states[2000], [-2.0982268754850053, 1.0873140837623023, -0.3834154832594913, -0.3732231982461854], 1e-9);
  near(r.energyDrift, 4.676364850908499e-11, 5e-12);
  near(r.angularMomentumDrift, 4.8119286333303535e-12, 1e-12);
  // every energy sample is within drift of the initial energy
  for (const e of r.energy) assert.ok(Math.abs(e - r.energy[0]) <= r.energyDrift + 1e-18);
});

test("simulateOrbit: elliptical orbit, coarse step has larger but bounded drift", () => {
  const r = simulateOrbit([1, 0, 0, 1.2], 1, 0.1, 200);
  near(r.energyDrift, 1.0167779435632518e-6, 1e-10);
  near(r.angularMomentumDrift, 4.878266237628992e-7, 1e-10);
});

test("simulateOrbit: drift is the max absolute deviation from sample 0", () => {
  const r = simulateOrbit([1, 0, 0, 1.2], 1, 0.1, 200);
  let e = 0, l = 0;
  for (let i = 0; i <= 200; i++) {
    e = Math.max(e, Math.abs(r.energy[i] - r.energy[0]));
    l = Math.max(l, Math.abs(r.angularMomentum[i] - r.angularMomentum[0]));
  }
  assert.equal(r.energyDrift, e);
  assert.equal(r.angularMomentumDrift, l);
});

test("simulateOrbit: Earth-like units (km, km/s, mu in km^3/s^2)", () => {
  const r = simulateOrbit([7000, 0, 0, 7.5], 398600.4418, 10, 600);
  nearArray(r.states[600], [6691.752042925979, 2041.5570203251996, -2.2155151640110597, 7.169557263143043], 1e-6);
  near(r.t[600], 6000, 1e-9);
  assert.ok(r.energyDrift < 1e-8, `energyDrift ${r.energyDrift}`);
  assert.ok(r.angularMomentumDrift < 1e-5, `angularMomentumDrift ${r.angularMomentumDrift}`);
});

test("simulateOrbit: negative h runs the orbit backward", () => {
  const fwd = simulateOrbit([1, 0, 0, 1.2], 1, 0.01, 300);
  const back = simulateOrbit(fwd.states[300], 1, -0.01, 300);
  nearArray(back.states[300], [1, 0, 0, 1.2], 1e-9);
  near(back.t[300], -3, 1e-12);
});

test("simulateOrbit: does not mutate state0 and copies it into states[0]", () => {
  const s0 = [1, 0, 0, 1];
  const r = simulateOrbit(s0, 1, 0.1, 3);
  assert.deepEqual(s0, [1, 0, 0, 1]);
  assert.notEqual(r.states[0], s0);
});

test("simulateOrbit: invalid arguments throw TypeError 'invalid argument'", () => {
  throwsType(() => simulateOrbit([1, 0, 0], 1, 0.1, 1), "invalid argument");
  throwsType(() => simulateOrbit([1, 0, 0, 1], 0, 0.1, 1), "invalid argument");
  throwsType(() => simulateOrbit([1, 0, 0, 1], 1, NaN, 1), "invalid argument");
  throwsType(() => simulateOrbit([1, 0, 0, 1], 1, 0.1, -2), "invalid argument");
  throwsType(() => simulateOrbit([1, 0, 0, 1], 1, 0.1, 2.5), "invalid argument");
});

test("simulateOrbit: starting at the origin throws RangeError 'singularity'", () => {
  throwsRange(() => simulateOrbit([0, 0, 1, 0], 1, 0.1, 1), "singularity");
  throwsRange(() => simulateOrbit([0, 0, 1, 0], 1, 0.1, 0), "singularity");
});
