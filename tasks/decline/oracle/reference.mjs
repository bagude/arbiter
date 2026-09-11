// Reference implementation for the `decline` task (Arps decline-curve analysis).
// Units: t in years, Di / Dmin nominal per-year, q in volume per year, Np in volume.
// Never shown to any agent.

function isFinite_(x) {
  return typeof x === "number" && Number.isFinite(x);
}
function bad(what) {
  throw new TypeError(`invalid argument: ${what}`);
}
function checkCurve(qi, Di, b) {
  if (!isFinite_(qi) || qi <= 0) bad("qi must be a finite number > 0");
  if (!isFinite_(Di) || Di <= 0) bad("Di must be a finite number > 0");
  if (!isFinite_(b) || b < 0 || b > 1) bad("b must be a finite number in [0, 1]");
}
function checkTime(t, name = "t") {
  if (!isFinite_(t) || t < 0) bad(`${name} must be a finite number >= 0`);
}
function checkPositive(x, name) {
  if (!isFinite_(x) || x <= 0) bad(`${name} must be a finite number > 0`);
}

// Stage 1: rate at time t.
export function declineRate(qi, Di, b, t) {
  checkCurve(qi, Di, b);
  checkTime(t);
  if (b === 0) return qi * Math.exp(-Di * t);
  // qi * (1 + b Di t)^(-1/b), evaluated stably via log1p for tiny b.
  return qi * Math.exp(-Math.log1p(b * Di * t) / b);
}

// Stage 2: cumulative production from 0 to t.
export function cumulativeProduction(qi, Di, b, t) {
  checkCurve(qi, Di, b);
  checkTime(t);
  if (b === 0) return (qi / Di) * -Math.expm1(-Di * t);
  if (b === 1) return (qi / Di) * Math.log1p(Di * t);
  // qi / ((1-b) Di) * (1 - (1 + b Di t)^(1 - 1/b)), stable near b -> 0 and b -> 1.
  return (qi / ((1 - b) * Di)) * -Math.expm1(((b - 1) / b) * Math.log1p(b * Di * t));
}

// Stage 3: hand-off from hyperbolic to terminal exponential decline.
export function terminalSwitch(qi, Di, b, Dmin) {
  checkCurve(qi, Di, b);
  checkPositive(Dmin, "Dmin");
  if (Di <= Dmin) {
    return { tSwitch: 0, qSwitch: qi, NpSwitch: 0 };
  }
  if (b === 0) {
    // Exponential at Di > Dmin: decline never drops to Dmin.
    return { tSwitch: Infinity, qSwitch: 0, NpSwitch: qi / Di };
  }
  const tSwitch = (Di / Dmin - 1) / (b * Di);
  return {
    tSwitch,
    qSwitch: declineRate(qi, Di, b, tSwitch),
    NpSwitch: cumulativeProduction(qi, Di, b, tSwitch),
  };
}

// Stage 4: piecewise forecast (hyperbolic, then exponential at Dmin) at requested times.
export function forecastAt(qi, Di, b, Dmin, times) {
  checkCurve(qi, Di, b);
  checkPositive(Dmin, "Dmin");
  if (!Array.isArray(times) || times.length > 100) bad("times must be an array of at most 100 entries");
  for (const t of times) checkTime(t, "times[i]");
  const s = terminalSwitch(qi, Di, b, Dmin);
  return times.map((t) => {
    if (t <= s.tSwitch) {
      return { t, q: declineRate(qi, Di, b, t), Np: cumulativeProduction(qi, Di, b, t) };
    }
    const dt = t - s.tSwitch;
    return {
      t,
      q: s.qSwitch * Math.exp(-Dmin * dt),
      Np: s.NpSwitch + (s.qSwitch / Dmin) * -Math.expm1(-Dmin * dt),
    };
  });
}

// Stage 5: estimated ultimate recovery down to an economic rate limit.
export function estimateEUR(qi, Di, b, Dmin, qLimit) {
  checkCurve(qi, Di, b);
  checkPositive(Dmin, "Dmin");
  checkPositive(qLimit, "qLimit");
  const s = terminalSwitch(qi, Di, b, Dmin);
  if (qLimit >= qi) return { eur: 0, tLimit: 0, tSwitch: s.tSwitch };
  if (qLimit >= s.qSwitch) {
    // Limit reached during the hyperbolic phase (or exactly at the switch).
    const L = Math.log(qi / qLimit);
    const tLimit = b === 0 ? L / Di : Math.expm1(b * L) / (b * Di);
    return { eur: cumulativeProduction(qi, Di, b, tLimit), tLimit, tSwitch: s.tSwitch };
  }
  // Limit reached during the terminal exponential phase.
  const tLimit = s.tSwitch + Math.log(s.qSwitch / qLimit) / Dmin;
  const eur = s.NpSwitch + (s.qSwitch - qLimit) / Dmin;
  return { eur, tLimit, tSwitch: s.tSwitch };
}
