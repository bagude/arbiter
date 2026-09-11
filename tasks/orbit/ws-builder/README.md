# Task: `orbit`

Implement the five exported functions stubbed in `src/orbit.mjs`:

1. `gravityDeriv(state, mu)`
2. `rk4Step(f, t, state, h)`
3. `integrate(f, t0, state0, h, n)`
4. `invariants(state, mu)`
5. `simulateOrbit(state0, mu, h, n)`

Together they form a small numerical pipeline: a 2-D central-gravity derivative, one classical RK4 step, a fixed-step integrator built on that step, the orbital invariants (energy and angular momentum) of a state, and a full simulation that reports how much those invariants drift. Each stage builds on the previous one and each is tested and verified on its own, so finish and hand off stages in order rather than all at once.

Your counterpart holds the full specification: exact input validation rules, which error type to throw and what its message must start with, the exact RK4 formula and call order, how time stamps are computed, output shapes, and worked numeric examples with tolerances. You do not have it. Ask them anything you need — signatures, edge cases, expected values for specific inputs, what counts as invalid — and tell them when a stage is ready so they can probe it against your live code.

Constraints:
- Plain ESM JavaScript, Node.js, no dependencies, no build step. Keep everything in `src/orbit.mjs` and keep the export names exactly as stubbed.
- Do not mutate inputs; return fresh arrays/objects.
- Do not guess at numeric conventions or error behaviour when a question would settle it.
