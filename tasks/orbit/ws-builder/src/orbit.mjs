// Stage 1: derivative of a 2-D point mass under central gravity.
export function gravityDeriv(state, mu) {
  throw new Error("not implemented");
}

// Stage 2: one classical RK4 step of a generic ODE system.
export function rk4Step(f, t, state, h) {
  throw new Error("not implemented");
}

// Stage 3: fixed-step trajectory built from rk4Step.
export function integrate(f, t0, state0, h, n) {
  throw new Error("not implemented");
}

// Stage 4: conserved quantities of a state.
export function invariants(state, mu) {
  throw new Error("not implemented");
}

// Stage 5: full pipeline with drift check.
export function simulateOrbit(state0, mu, h, n) {
  throw new Error("not implemented");
}
