# task:orbit

4 fact(s), 1 run(s) in history, 31 candidate(s). Runs: [[runs/2026-09-11T21-35-14]], [[runs/2026-09-12T02-53-04]], [[runs/2026-09-14T15-45-09]], [[runs/2026-09-14T16-18-08]], [[runs/2026-09-14T16-40-08]].

## Facts

- [procedural] orbit: delegation that passed the oracle — worker 1: Implement the module `src/orbit.mjs` in the shared workspace (current directory). (m_76da95681541, conf 0.7, evidence: [[runs/2026-09-14T16-40-08]] oracle:2026-09-14T16-40-08#1)
- [procedural] orbit: delegation that passed the oracle — worker 1: You are implementing two functions in `src/orbit.mjs` (plain ESM, Node.js, no dependencies). | worker 2: You are continuing work on `src/orbit.mjs` (plain ESM, Node.js, no dependencies). | worker 3: You are finishing `src/orbit.mjs` (plain ESM, Node.js, no dependencies). (m_aabd196ee0a0, conf 0.7, evidence: [[runs/2026-09-14T16-18-08]] oracle:2026-09-14T16-18-08#1)
- [procedural] orbit: delegation that passed the oracle — worker 1: Implement stages 1–3 of the `orbit` pipeline in `src/orbit.mjs`. | worker 2: You are an INDEPENDENT VERIFIER. (m_8ff21193a152, conf 0.7, evidence: [[runs/2026-09-14T15-45-09]] oracle:2026-09-14T15-45-09#1)
- [procedural] orbit: delegation that passed the oracle — worker 1: Implement stages 1 and 2 of a numerical pipeline in `src/orbit.mjs` (plain ESM, Node.js, no dependencies, no build step) | worker 2: Implement stages 3 and 4 of the numerical pipeline in `src/orbit.mjs` (plain ESM, Node.js, no dependencies). | worker 3: Implement the final stage (stage 5) of the numerical pipeline in `src/orbit.mjs` (plain ESM, Node.js, no dependencies). (m_31dd17ae0bf3, conf 0.91, evidence: [[runs/2026-09-11T21-35-14]] oracle:2026-09-11T21-35-14#1 [[runs/2026-09-12T02-53-04]] oracle:2026-09-12T02-53-04#1)

## History

- orbit via orchestrator (orchestrator=llama.cpp/qwen3-27b, worker=llama.cpp/qwen3-27b): SUCCESS: oracle passed in 1086s; 3 workers, 12 probes, 1 done attempt. Oracle: 48/48. (m_b8f11b5a25a2, conf 0.99, evidence: [[runs/2026-09-11T21-35-14]] oracle:2026-09-11T21-35-14#1 [[runs/2026-09-12T02-53-04]] oracle:2026-09-12T02-53-04#1 [[runs/2026-09-14T15-45-09]] oracle:2026-09-14T15-45-09#1 [[runs/2026-09-14T16-18-08]] oracle:2026-09-14T16-18-08#1 [[runs/2026-09-14T16-40-08]] oracle:2026-09-14T16-40-08#1)

## Candidates

- [semantic, agent] All 265 self-checks in the scratch suite passed (node v26.3.0, run from workspace): every worked example for all 5 stages at the spec tolerances, all error cases (TypeError 'invalid argument…', TypeError 'invalid derivative…', RangeError 'singularity…'), -0 singularity, validation-before-singularity precedence, f called exactly 4x with exact t-values, f-throw identity propagation, n=0 never calling f, t[8]===0.8 / t[3]===0.30000000000000004, fresh/distinct arrays, exact key sets (2 and 6), drifts === recomputed max, exports surface exactly the five functions. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_81a658393557, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] Measured drifts vs spec: ellipse h=0.01 n=2000 → energyDrift 4.676431464289976e-11 (want 4.676e-11 ±5e-12), Ldrift 4.813260900959904e-12 (want 4.81e-12 ±1e-12); coarse h=0.1 n=200 → 1.0167779419534284e-6 (want 1.0167779e-6 ±1e-10) and 4.878266208763193e-7 (want 4.878266e-7 ±1e-10); circle 1000 steps → max radius deviation 4.956e-11 (<1e-9), both drifts 8.5598e-13 (<1e-10); LEO states[600] within 1.3e-8 of target, t[600]===6000, drifts 8.33e-10 (<1e-8) and 7.64e-7 (<1e-5); reversibility back to [1,0,0,1.2] within 1e-9 with t[300]===-3. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_35d6d8bed4ab, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] Testing caught a real implementation bug before handoff: the stage-5 wrapper was written (s) => gravityDeriv(s, mu) so rk4Step's first argument (time) was passed as the state; fixed to (time, s) => gravityDeriv(s, mu). Same mistake existed in one scratch test and was fixed there too. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_a80577bba321, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] Drift constants land within ~1% of the spec's reference values, so the literal evaluation orders chosen (r = Math.hypot(x,y); r3 = r*r*r; RK4 as written with (h/2), (h/6), left-to-right sums; t[i] = t0 + i*h) reproduce the reference implementation's arithmetic closely enough for every stated tolerance. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_515efff3e812, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] n = -0 is treated as a valid count because the spec's predicate Number.isInteger(n) && n >= 0 is true for -0 in JS; the spec's invalid examples (-1, 1.5, "3", missing) are all rejected. Settlement: if the reference rejects -0, checkCount needs n > 0 || Object.is(n, -0) removed — but the literal predicate says valid. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_a1fd6d4651b3, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] Workspace left clean: src/ contains only orbit.mjs; the scratch suite (src/_scratch_check.mjs) was deleted. git status entries under memory/ and configs/ belong to the parent arbiter repo's harness files, untouched by this work. (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_74dfd730a7a7, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 1/7 (section A):
A1	0.5756971781027864 1.037696298803913 -0.7287029921568849 0.7709393392767582
A2	-2.0982268754850026 1.0873140837623037 -0.3834154832594906 -0.3732231982461852
A3	20
A4	4.676431464289976e-11
A5	4.813260900959904e-12
A6	["t","states","energy","angularMomentum","energyDrift","angularMomentumDrift"] (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_782ad52c5692, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 2/7 (sections B-C):
B1	0.9999999999982858 2.324607988740679e-10 -2.3246245033081703e-10 1.0000000000008582
B2	6.283185307179586
B3	4.956079990847684e-11
B4	8.559819519859957e-13
B5	8.559819519859957e-13
C1	0.0000010167779419534284
C2	4.878266208763193e-7 (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_58aad8307e37, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 3/7 (sections D-E):
D1	6691.752042925992 2041.5570203251823 -2.215515164011029 7.169557263143051
D2	6000
D3	8.331717538112571e-10
D4	7.639901014044881e-7
E1	-1.004932141317763 1.5914382909037392 -0.7046114199036609 -0.0782683754671421
E2	1.0000000000004263 1.6713193329298548e-12 -2.63579089110344e-13 1.199999999996295
E3	-3
E4	true
E5	3.7050362777790724e-12 (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_ab28c107db5d, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 4/7 (section F, F1-F17):
F1	1.1051708333333332
F2	4
F3	3.375
F4	0.8776041666666666 -0.47916666666666663
F5	0.9048375
F6	true true true
F7	4 1.25 1.5 1.5 1.75
F8	0 0.1 0.2 0.30000000000000004 0.4 0.5 0.6000000000000001 0.7000000000000001 0.8 0.9 1
F9	true
F10	true
F11	0
F12	-2.718281828459045
F13	2.7182797441351627
F14	-2.7182797441351627
F15	1 1.25 1.25 1.5 1.5 1.75 1.75 2
F16	0 {"t":[0],"states":[[5]]}
F17	true (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_c18995d8f8df, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 5/7 (section F, F18-F19):
F18.1	TypeError invalid derivative: derivative must be an array of length 1 (the state length)
F18.2	TypeError invalid derivative: derivative must be an array of length 1 (the state length)
F18.3	TypeError invalid derivative: derivative must contain only finite numbers
F18.4	TypeError invalid derivative: derivative must contain only finite numbers
F19.1	TypeError invalid argument: f must be a function
F19.2	TypeError invalid argument: t must be a finite number
F19.3	TypeError invalid argument: state must be an array of finite numbers of length at least (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_a2d7bcc2bba7, conf 0.64, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 6/7 (section F, F20-F22):
F20.1	TypeError invalid argument: f must be a function
F20.2	TypeError invalid argument: t0 must be a finite number
F20.3	TypeError invalid argument: h must be a finite number
F20.4	TypeError invalid argument: state0 must be an array of finite numbers of length at least 1
F20.5	TypeError invalid argument: n must be an integer >= 0
F20.6	TypeError invalid argument: n must be an integer >= 0
F20.7	TypeError invalid argument: n must be an integer >= 0
F21	TypeError invalid argument: state must contain only finite numbers
F22	TypeError invalid argument: mu (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_aaeb327bf94b, conf 0.4, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 6/8 (section F, F19.3-F20.4):
F19.3	TypeError invalid argument: state must be an array of finite numbers of length at least 1
F19.4	TypeError invalid argument: h must be a finite number
F19.5	TypeError invalid argument: h must be a finite number
F20.1	TypeError invalid argument: f must be a function
F20.2	TypeError invalid argument: t0 must be a finite number
F20.3	TypeError invalid argument: h must be a finite number
F20.4	TypeError invalid argument: state0 must be an array of finite numbers of length at least 1 (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_bfa5cf596fd2, conf 0.4, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 7/8 (section F, F20.5-F23):
F20.5	TypeError invalid argument: n must be an integer >= 0
F20.6	TypeError invalid argument: n must be an integer >= 0
F20.7	TypeError invalid argument: n must be an integer >= 0
F21	TypeError invalid argument: state must contain only finite numbers
F22	TypeError invalid argument: mu must be a finite number > 0
F23	["energy","angularMomentum"] (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_c85be3ea6f45, conf 0.4, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT part 8/8 (section G):
G1	true true true
G2	true
G3	true true
G4	true true
G5	true (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_c2ef08a96c31, conf 0.4, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] RAW OUTPUT (all 10 lines, verbatim):
H1	2.718279744135166
H2	-0.0000020843238792700447
H3	2.7182797441351627
H4	3.1086244689504383e-15
H5	1
H6	0.540302967116884 0.8414704778002743
H7	-1
H8	0
H9	0
H10	1.1051708333333332 true true 0 (worker report, worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942) (m_4b607004d469, conf 0.4, evidence: [[runs/2026-09-14T16-40-08]] worker:2026-09-14T16-41-54-499Z_01a0a0cb-ee43-74dc-b60d-875ecff10942)
- [semantic, agent] All 66 self-test assertions passed (temp file src/_selftest.mjs, deleted after run): all 6 spec gravityDeriv examples (ex1 exact via deepStrictEqual [0,1,-1,0]; ex3 off by 1 ulp from 2/8**1.5, within the 1e-14 rel tolerance), all 6 spec rk4Step examples matching the spec literals bit-for-bit, f called exactly 4x with times [t, t+h/2, t+h/2, t+h], first call receives state itself, no mutation, fresh plain arrays, cross-checked against a naive reference implementation. (worker report, worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208) (m_6d6d354e7b38, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208)
- [semantic, agent] Error behavior verified: TypeError 'invalid argument…' for all invalid/missing f, t, h, state, mu cases (checked before any f call or math); TypeError 'invalid derivative…' for f returning wrong length, non-array, [NaN], [Infinity] — validated after each of the 4 calls (bad k1 → 1 f call then throw; bad k2 → 2 calls then throw); RangeError 'singularity…' for [0,0,1,1], [-0,0,1,1], [0,-0,1,1] only after arg validation; an error thrown by f propagates as the identical object. (worker report, worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208) (m_34291897bad3, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208)
- [semantic, agent] The three later-stage stubs are unchanged: each still throws Error('not implemented'); module exports exactly [gravityDeriv, integrate, invariants, rk4Step, simulateOrbit]; src/ contains only orbit.mjs. (worker report, worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208) (m_d6a4d1aa9dc3, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208)
- [semantic, agent] gravityDeriv normalizes -0 to +0 only in the computed accelerations (velocities pass through bit-exact, including -0). The raw formula -mu*y/r³ yields -0 for y=0, which would fail deepStrictEqual against the written example [0,1,-1,0]; normalization makes the written example hold under strict equality while remaining identical under any tolerance. (worker report, worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208) (m_21975e3a8c86, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208)
- [semantic, agent] The brief's example 'rk4Step((t,s)=>[s[0]], 0, [1,2], 0) → a new [1,2]' is internally inconsistent with the spec's derivative rule (f returns length 1 for a length-2 state → must be 'invalid derivative'). I followed the spec rule: f is called 4 times even for h=0, every return validated; with a length-consistent f the result is a fresh array elementwise equal to state. (worker report, worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208) (m_e27fd3106193, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-18-48-541Z_01a0a0b6-c85d-748f-a906-459442b35208)
- [semantic, agent] node selftest-stage34.mjs: all 11 groups passed, exit 0. Covers both integrate numeric examples (t[3]===0.30000000000000004, t[8]===0.8 bit-exact; states[10][0]=2.718279744135166 within 2.1e-6 of Math.E and 3.3e-15 of 1.1051708333333333**10; backward rotation states[10] within 1e-14), freshness/no-mutation/distinct-arrays, n=0 with f-never-called counter, exact t-sequence [1,1.25,1.25,1.5,1.5,1.75,1.75,2] with 8 calls, same-object error propagation, invalid-derivative via integrate, 8 invalid-argument cases with f never called, all invariants examples and 11 error cases. (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_0dfbea9c42d4, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] All five invariants spec examples match bit-exactly (===) with the literal formula energy=(vx*vx+vy*vy)/2 - mu/r, angularMomentum=x*vy - y*vx, r=Math.hypot(x,y), including Earth-scale energy === -28.817920257142852 and angularMomentum === 52500. Object.keys is exactly ['energy','angularMomentum'] in that order. (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_650fb0cec13a, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] t computed as t0 + i*h (i multiplied by h, then added to t0, loop i=0..n) yields the spec's bit-exact values: full t array for t0=0,h=0.1,n=10 is [0,0.1,0.2,0.30000000000000004,0.4,0.5,0.6000000000000001,0.7000000000000001,0.8,0.9,1]. (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_c2797a5cf493, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] states[0] = state0.slice() is a fresh deep-equal copy (!== state0); every states[i] is a distinct array; state0 is not mutated; n=0 returns {t:[t0], states:[copy]} with f never called (call counter 0); validation failure also leaves f uncalled (counter 0). (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_d9f52d085f91, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] An error thrown by f propagates through integrate->rk4Step as the SAME object (err === inst verified for a RangeError('singularity: boom')), and a RangeError from a wrapped gravityDeriv at the origin also propagates with 'singularity' prefix. (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_73145ff504f3, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] Stages 1-2, isFiniteNumber/isState, and the simulateOrbit stub are byte-identical to their pre-task state (full-file read before and after the single edit that replaced only the two stub bodies). (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_8de67f0a174b, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] Temp test file selftest-stage34.mjs was created in the project root and deleted after the run; final workspace listing shows only .pi/, README.md, src/ (git status noise under parent-repo memory/ and configs/ is pre-existing and outside this workspace). (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_8fd4d6cd91d2, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] Edge case t0 = -0 with h > 0: t[0] = t0 + 0*h yields +0 (0*h = +0, -0 + +0 = +0) rather than the literal t0 = -0, following the spec's emphasized 'computed exactly as that product' rule; indistinguishable via ===, only Object.is would differ. Not exercised by any spec example. (worker report, worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1) (m_148f9567df1d, conf 0.78, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-27-26-917Z_01a0a0be-b145-748f-a906-4599876a46c1)
- [semantic, agent] Full self-test run (temp file simulate-orbit.selftest.mjs at project root, deleted after run): 50 passed, 0 failed, exit=0. Verbatim output: PASS ex1: n=0 deep-equal / PASS ex1: states[0] is a copy, not the same reference / PASS ex1: exactly six keys / PASS ex2: states[1000] ~ [1,0,0,1] (1e-8) / PASS ex2: t[1000] ~ 2*pi (1e-12) / PASS ex2: radius ~ 1 at every sample (1e-9) / PASS ex2: drifts < 1e-10 / ex3 drifts: energyDrift=4.676431464289976e-11 angularMomentumDrift=4.813260900959904e-12 / PASS ex3: states[100] (1e-12) / PASS ex3: states[2000] (1e-9) / PASS ex3: energyDrift ~ 4.676e-11 (+/-5e (worker report, worker:2026-09-14T16-34-50-435Z_01a0a0c5-75c3-748f-a906-459da23e69fb) (m_a2dd3954ce64, conf 0.4, evidence: [[runs/2026-09-14T16-18-08]] worker:2026-09-14T16-34-50-435Z_01a0a0c5-75c3-748f-a906-459da23e69fb)
- [semantic, agent] Probe protocol for this workspace: body entries need an explicit "fn" field (one of the five exports) plus "args" (positional args, JSON only — functions cannot be passed, so stage-2/3 derivative-function paths must be verified via simulateOrbit or a worker-run script), and optional "expect" (literal value or {"throws":"ErrorName"}); large results are echo-truncated to ~1.2KB per case, so choose small n when you need to see tails like drifts. (m_32d4904375e7, conf 0.4, evidence: [[runs/2026-09-14T15-45-09]] mail:2026-09-14T15-45-09#6)
