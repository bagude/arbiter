// Reference implementation for the `orbit` task. Never shown to any agent.

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function checkState(state, what = "state") {
  if (!Array.isArray(state)) throw new TypeError(`invalid argument: ${what} must be an array`);
  if (state.length === 0) throw new TypeError(`invalid argument: ${what} must be non-empty`);
  for (let i = 0; i < state.length; i++) {
    if (!isFiniteNumber(state[i])) {
      throw new TypeError(`invalid argument: ${what}[${i}] must be a finite number`);
    }
  }
}

function checkState4(state, what = "state") {
  checkState(state, what);
  if (state.length !== 4) throw new TypeError(`invalid argument: ${what} must have length 4`);
}

function checkMu(mu) {
  if (!isFiniteNumber(mu) || mu <= 0) throw new TypeError("invalid argument: mu must be a finite number > 0");
}

function checkFinite(x, what) {
  if (!isFiniteNumber(x)) throw new TypeError(`invalid argument: ${what} must be a finite number`);
}

function checkCount(n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError("invalid argument: n must be a non-negative integer");
}

function callDeriv(f, t, s) {
  const d = f(t, s);
  if (!Array.isArray(d) || d.length !== s.length) {
    throw new TypeError("invalid derivative: f must return an array with the same length as state");
  }
  for (let i = 0; i < d.length; i++) {
    if (!isFiniteNumber(d[i])) throw new TypeError(`invalid derivative: element ${i} is not a finite number`);
  }
  return d;
}

// ---- Stage 1 -------------------------------------------------------------

export function gravityDeriv(state, mu) {
  checkState4(state);
  checkMu(mu);
  const [x, y, vx, vy] = state;
  const r2 = x * x + y * y;
  if (r2 === 0) throw new RangeError("singularity: position is at the origin");
  const r = Math.sqrt(r2);
  const k = -mu / (r2 * r);
  return [vx, vy, k * x, k * y];
}

// ---- Stage 2 -------------------------------------------------------------

export function rk4Step(f, t, state, h) {
  if (typeof f !== "function") throw new TypeError("invalid argument: f must be a function");
  checkFinite(t, "t");
  checkState(state);
  checkFinite(h, "h");
  const n = state.length;
  const k1 = callDeriv(f, t, state);
  const s2 = new Array(n);
  for (let i = 0; i < n; i++) s2[i] = state[i] + (h / 2) * k1[i];
  const k2 = callDeriv(f, t + h / 2, s2);
  const s3 = new Array(n);
  for (let i = 0; i < n; i++) s3[i] = state[i] + (h / 2) * k2[i];
  const k3 = callDeriv(f, t + h / 2, s3);
  const s4 = new Array(n);
  for (let i = 0; i < n; i++) s4[i] = state[i] + h * k3[i];
  const k4 = callDeriv(f, t + h, s4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = state[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return out;
}

// ---- Stage 3 -------------------------------------------------------------

export function integrate(f, t0, state0, h, n) {
  if (typeof f !== "function") throw new TypeError("invalid argument: f must be a function");
  checkFinite(t0, "t0");
  checkState(state0, "state0");
  checkFinite(h, "h");
  checkCount(n);
  const t = new Array(n + 1);
  const states = new Array(n + 1);
  t[0] = t0;
  states[0] = state0.slice();
  for (let i = 0; i < n; i++) {
    states[i + 1] = rk4Step(f, t[i], states[i], h);
    t[i + 1] = t0 + (i + 1) * h;
  }
  return { t, states };
}

// ---- Stage 4 -------------------------------------------------------------

export function invariants(state, mu) {
  checkState4(state);
  checkMu(mu);
  const [x, y, vx, vy] = state;
  const r2 = x * x + y * y;
  if (r2 === 0) throw new RangeError("singularity: position is at the origin");
  const r = Math.sqrt(r2);
  const energy = (vx * vx + vy * vy) / 2 - mu / r;
  const angularMomentum = x * vy - y * vx;
  return { energy, angularMomentum };
}

// ---- Stage 5 -------------------------------------------------------------

export function simulateOrbit(state0, mu, h, n) {
  checkState4(state0, "state0");
  checkMu(mu);
  checkFinite(h, "h");
  checkCount(n);
  const f = (t, s) => gravityDeriv(s, mu);
  const { t, states } = integrate(f, 0, state0, h, n);
  const energy = new Array(n + 1);
  const angularMomentum = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const inv = invariants(states[i], mu);
    energy[i] = inv.energy;
    angularMomentum[i] = inv.angularMomentum;
  }
  let energyDrift = 0;
  let angularMomentumDrift = 0;
  for (let i = 1; i <= n; i++) {
    energyDrift = Math.max(energyDrift, Math.abs(energy[i] - energy[0]));
    angularMomentumDrift = Math.max(angularMomentumDrift, Math.abs(angularMomentum[i] - angularMomentum[0]));
  }
  return { t, states, energy, angularMomentum, energyDrift, angularMomentumDrift };
}
