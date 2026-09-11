# Task: `decline`

Implement the five exported functions stubbed in `src/decline.mjs`:

1. `declineRate(qi, Di, b, t)`
2. `cumulativeProduction(qi, Di, b, t)`
3. `terminalSwitch(qi, Di, b, Dmin)`
4. `forecastAt(qi, Di, b, Dmin, times)`
5. `estimateEUR(qi, Di, b, Dmin, qLimit)`

Together they form a petroleum decline-curve-analysis (Arps) pipeline: the production rate of a well at a time, the cumulative volume produced up to a time, the point at which a hyperbolic decline hands off to a terminal exponential decline, a forecast of rate and cumulative sampled at caller-chosen times, and the estimated ultimate recovery (total volume and time) down to an economic rate limit. Each stage builds on the previous ones and each is tested and verified on its own, so finish and hand off stages in order rather than all at once.

Your counterpart holds the full specification: units, exact closed-form formulas for each branch of the decline exponent `b`, input validation rules, which error type to throw and what its message must start with, how edge cases such as `b = 0`, `b = 1`, `t = 0`, a decline already below the terminal rate, or an economic limit above the initial rate are handled, the required numerical accuracy, and worked numeric examples with tolerances. You do not have it. Ask them anything you need — signatures, edge cases, expected values for specific inputs, what counts as invalid — and tell them when a stage is ready so they can probe it against your live code.

Constraints:
- Plain ESM JavaScript, Node.js, no dependencies, no build step. Keep everything in `src/decline.mjs` and keep the export names exactly as stubbed.
- Do not mutate inputs; return fresh arrays/objects.
- Do not guess at numeric conventions, formulas, or error behaviour when a question would settle it.
