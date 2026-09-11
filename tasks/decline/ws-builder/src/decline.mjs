// Stage 1: production rate at time t.
export function declineRate(qi, Di, b, t) {
  throw new Error("not implemented");
}

// Stage 2: cumulative production from time 0 to t.
export function cumulativeProduction(qi, Di, b, t) {
  throw new Error("not implemented");
}

// Stage 3: hand-off from hyperbolic decline to terminal exponential decline.
export function terminalSwitch(qi, Di, b, Dmin) {
  throw new Error("not implemented");
}

// Stage 4: rate and cumulative of the piecewise curve at requested times.
export function forecastAt(qi, Di, b, Dmin, times) {
  throw new Error("not implemented");
}

// Stage 5: estimated ultimate recovery down to an economic rate limit.
export function estimateEUR(qi, Di, b, Dmin, qLimit) {
  throw new Error("not implemented");
}
