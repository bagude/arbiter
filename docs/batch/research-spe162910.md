# Research spe162910 — study → apply → synthesis

5 round(s), 2.05 h. Phases: study ×2 (orch-dw-paper-study-27b.json), apply ×3 (orch-dw-paper-apply-27b.json), synthesis ×1 (orch-dw-paper-synthesis-27b.json). Brake per phase: oracle failure, or novelty < 0.5 (same query, identical rows, or title Jaccard ≥ 0.4 against everything found before).

| phase | round | run | outcome | wall s | probes | mem search/get/refused | compactions | peak ctx | findings | novel | novelty |
|---|---|---|---|---|---|---|---|---|---|---|---|
| study | 1 | 2026-09-13T15-13-04 | SUCCESS: oracle passed | 1530.9 | 6 | 0/0/0 | 0 | 41576 | 8 | 8 | 1.00 |
| study | 2 | 2026-09-13T15-38-36 | SUCCESS: oracle passed | 1680 | 12 | 1/2/1 | 0 | 58975 | 8 | 3 | 0.38 |
| apply | 1 | 2026-09-13T16-06-37 | SUCCESS: oracle passed | 2111.9 | 4 | 4/2/1 | 1 | 80439 | 7 | 7 | 1.00 |
| apply | 2 | 2026-09-13T16-41-50 | SUCCESS: oracle passed | 1635.7 | 3 | 0/3/1 | 1 | 62640 | 7 | 0 | 0.00 |
| synthesis | 1 | 2026-09-13T17-09-06 | SUCCESS: oracle passed | 419.7 | 2 | 5/4/1 | 0 | 25222 | 9 | 6 | 0.67 |

## study round 1 — 2026-09-13T15-13-04

- C1 [observed] The paper's central claim: misapplication of the Arps relations to unconventional production data exhibiting long-term transient flow 'generally result s in sig
- C2 [interpreted] Reconstruction of why the Arps hyperbolic relation mimics transient flow: for q(t) = qi (1 + b Di t)^(-1/b) with b Di t >> 1, the relation reduces to a power la
- C3 [observed] The paper classifies all four newer time-rate relations (power-law exponential, stretched exponential, logistic growth, Duong) as essentially empirical, with no
- C4 [observed] The paper's workflow has three steps: (i) apply the 'Db', '!-derivative' and 'q/Gp' diagnostic plots to each data set; (ii) calibrate each time-rate model again
- C5 [interpreted] Reconstruction of the garbled 'beta'/'!-derivative' diagnostic: !(t) = t D(t) = -(1/q) dq/d(ln t), the instantaneous log-log slope of the rate. It equals a exac
- C6 [interpreted] Reconstruction of the power-law exponential relation (Eq. 7 / A.11, garbled in the extraction): q(t) = qhat exp[-Dhat t^n / (1 + Dhat t^n) - D! t] with D(t) = n
- C7 [observed] Across all 18 tabulated wells (East Texas Table 1, Field A Table 2, Field B Table 3, Field C Table 4), the highest EUR in every well comes from the Duong model 
- C8 [hypothesis] The paper suggests that a terminal exponential decline could be added to constrain the Duong model but explicitly declines to recommend it; since the unconstrai

Left open:

- Resolve the exact equation forms of PLE, Duong, and LGM from the original PDF (Eq. 7/9/10 and A.11-A.30) to settle the two reconstructions: the b(t) candidate in C5 and the (1 + Dhat t^n) denominator in C6 — the extracted glyphs are unrecoverable.
- Reproduce the EUR tables (Tables 1-4) from raw production data: the paper publishes no rate data, so none of the 90 EUR values can currently be recomputed independently; a data request or an Ilk et al. (2008) re-fit is the only route.
- Pin down the units of the 'five percent terminal decline' (per year? per day?) — the paper never states units; then quantify the stated sensitivity (higher terminal decline lowers modified-hyperbolic EUR) on one well.
- Investigate the outlier Well A.5, where LGM (4.39 BSCF) is roughly 30% below PLE (6.18 BSCF) while in every other well LGM is within a few percent of PLE — the paper flags it only in passing ('with the exception of a single case (Well A.5)').
- Quantify how far Field B's q/Gp trends deviate from the full linearity the Duong method requires: the paper calls the linearity expectation 'optimistic' and notes Field B may never be fully linear, but Fig. 6 is an image-only page in this extraction.

## study round 2 — 2026-09-13T15-38-36

- C1 [observed] (similar title) The paper's stated workflow is three steps: (1) apply the D-b, !-derivative (beta), and q/Gp diagnostic plots to each data set; (2) apply each of the five tabul
- C2 [observed] (similar title) The paper claims that misapplication of the Arps relations to production data exhibiting long-term transient flow generally results in significant overestimates
- C3 [observed] (similar title) The paper states that the four recently developed time-rate relations (power-law exponential, stretched exponential, logistic growth, Duong) are, at this time, 
- C4 [interpreted] (similar title) Reconstruction of the garbled PLE equation (Eq. 7 / A.11): the power-law exponential time-rate relation is q(t) = qhat exp[-Dhat t^n/(1 + Dhat t^n) - D! t], wit
- C5 [interpreted] Reconstruction of the garbled diagnostic functions: the decline parameter is D(t) = -(1/q) dq/dt (Eq. 1 / A.31-A.32), the 'beta' function (Eq. 4 / A.34) is beta
- C6 [observed] (similar title) Across the 17 tabulated shale wells (Field A, Table 2; Field B, Table 3; Field C, Table 4) and the East Texas tight-gas well (Table 1), the highest EUR in every
- C7 [observed] The Duong model is the most aggressive EUR extrapolator in every case: in the East Texas example it yields the highest EUR (3.17 BSCF) and the logistic growth m
- C8 [interpreted] The paper concludes that PLE and SE give essentially identical EURs because the relations have essentially the same mathematical formulation (PLE carries the ex

Left open:

- Pin down the units of the 'five percent terminal decline' (per year? per day?) — the paper never states units — then quantify on one well the stated sensitivity that a higher terminal decline lowers the modified-hyperbolic EUR.
- Quantify how far Field B's log[q/Gp] vs log[t] trends deviate from the full linearity the Duong method requires, and check whether that deviation tracks the largest Duong/PLE ratio (Field B, 1.478 in check K2).
- Reproduce Tables 1-4 from raw production data: the paper publishes no rate data, so the EUR values are currently only checkable against the printed tables, not against the underlying production.
- Resolve the exact glyph forms of the PLE (Eq. 7 / A.11), Duong (Eq. 9 / A.20), and LGM (Eq. 10 / A.26) equations from the original PDF to settle the C4 and C5 reconstructions.
- Test the suggested-but-declined terminal-exponential cap on the Duong model for one well (e.g., Well C.2): the cap hypothesis holds if the capped EUR falls below the unconstrained Duong EUR (11.34 BSCF) and toward the PLE/SE/LGM cluster.

## apply round 1 — 2026-09-13T16-06-37

- O1 [observed] PLE fit, TX 42-329-41743, first 48 producing months
- O2 [observed] SE fit, TX 42-329-41743, first 48 producing months
- O3 [observed] MH fit, TX 42-329-41743, first 48 producing months, Dlim fixed at 0.05 1/month
- O4 [observed] DNG fit, TX 42-329-41743, first 48 producing months
- O5 [observed] LGM fit, TX 42-329-41743, first 48 producing months
- O6 [observed] PLE fit, NM 30-015-45249, first 48 producing months
- O7 [observed] PLE vs DNG on the same 48 rows, TX 42-329-41743: SSE and max residual

Left open:

- Extend the fit windows beyond 48 months for both wells once feed staleness is repaired (TX 2026 volumes zero, NM stopped after 2026-01, m_0d7945720518), and check whether the anchored PLE exponents n ~ 0.59 and MH's b > 1 persist or drift at late time (p06 expects late-time D(t) artifacts from numerical differentiation).
- Compute the paper's D(t) and b(t) diagnostic curves (A.2-A.4, Figs. 13-16 style) for both wells and test whether log D(t) vs log t is as linear as the anchored PLE fits (R-squared 0.909838 / 0.928932) suggest before locking in a model.
- Quantify how the above-initial-rate subset (8.7-10.8% of producing well-months, m_6cb052ce94f7) shifts Dhat_i/Dhat_inf when included: refit the anchored PLE on windows that contain month-2 ramp or restimulation months and compare parameters against the first-48-months fits here.
- Compute 30-year EURs for all five models in the paper's Table 1 style (p06-p07) and verify that the unconstrained hyperbolic with the fitted b = 1.454016 overstates the Dlim-constrained MH EUR, as the paper warns.
- Plot q/Gp vs t on log-log for both wells to test the Duong base concept (A.24) directly, since the DNG fit collapsed m to its 0.01 lower bound on the TX well.

## apply round 2 — 2026-09-13T16-41-50

- O1 [observed] (same result) PLE fit, TX 42-329-41743, months 1-48 (qhat_i anchored to month-1 rate)
- O2 [observed] (same result) PLE fit, NM 30-015-45249, months 1-48 (qhat_i anchored to month-1 rate)
- O3 [observed] (same result) SE (stretched exponential) fit, TX 42-329-41743, months 1-48
- O4 [observed] (same result) DNG (Duong) fit, TX 42-329-41743, months 1-48, m pinned at lower bound
- O5 [observed] (same result) MH (modified hyperbolic) two-stage fit, TX 42-329-41743, months 1-48, t_exp = 24, b > 1
- O6 [observed] (same result) LGM (logistic growth, S-shaped cumulative) fit, NM 30-015-45249, months 1-48
- O7 [observed] (same result) Five-model SSE comparison on the same 48 TX rows (PLE as reference model)

Left open:

- Extend the fit windows beyond 48 months for both wells (TX has 83 producing months) and check whether PLE n and Dhat_inf drift once the staleness/ramp period is included; the (Dhat_i, Dhat_inf) ridge found in O1/O2 means parameter splits are not comparable across windows without an anchoring convention.
- Compute the paper's D(t) and b(t) diagnostic curves (A.2-A.4, A.31) for both wells to test which flow regimes the data actually support instead of relying on in-sample SSE alone, since O7 shows MH/DNG winning in-sample while the paper warns regression alone is non-unique (p05).
- Plot q/Gp vs t on log-log for both wells to test the Duong linearity assumption (A.24) directly, now that m pinned at its 0.01 lower bound in O4 - check whether the linearity the DNG fit requires is absent on both wells as in the paper's depletion-dominated Field B (p07).
- Quantify the above-initial-rate subset (8.7-10.8% of producing well-months sit above their initial rate) and whether excluding ramp months changes the fitted parameters, in particular whether the O5 MH b > 1 (b = 1.281246) and the O4 DNG m pinning persist.
- Compute 30-year EURs for all five models in the paper's Table 1 fashion (with the 5% terminal decline for MH) to reproduce the paper's EUR ranking on these real wells and quantify how much the unconstrained b = 1.281246 > 1 hyperbolic extrapolation would overstate reserves (p06-p07).

## synthesis round 1 — 2026-09-13T17-09-06

- R1 [observed] The paper's central claim: unconstrained extrapolation of the Arps relations (hyperbolic with b-values greater than 1) to unconventional production data exhibit
- R2 [observed] (similar title) The paper prescribes a three-step workflow: (1) apply the 'Db', '!-derivative', and 'q/Gp' diagnostic plots to each data set to guide the analysis and obtain mo
- R3 [observed] (similar title) Across all 18 tabulated wells (East Texas Table 1; Field A Table 2, Field B Table 3, Field C Table 4), the highest EUR in every well comes from the Duong model;
- R4 [observed] The paper accordingly concludes that the Duong model 'may be the least appropriate model' for Field B, where the q/Gp linearity the method requires is not clear
- R5 [observed] Warehouse fit, TX 42-329-41743: on the same 48 first-producing months (PLE as reference model), in-sample SSE by model is MH 44,255,058.78 (R2 = 0.986255), DNG 
- R6 [observed] (similar title) Individual model fits on warehouse wells: the MH fit to the first 48 producing months of TX 42-329-41743 (Dlim fixed at 0.05 1/month) gives qi = 79,621.36345 bb
- R7 [interpreted] Why the Arps hyperbolic relation misleads: it can represent the early-time power-law (transient) flow regime, so a hyperbolic curve fitted to early transient da
- R8 [interpreted] PLE and SE give essentially identical EURs in the paper's comparisons, so the decisive split in the paper's data is between the power-law-type models and the Du
- R9 [hypothesis] Field B's q/Gp trends deviate from the full linearity the Duong method assumes, and that deviation is the main reason Field B's Duong EUR inflation (mean Duong/

Left open:

- How far do Field B's q/Gp and log[q/Gp]-versus-log[t] trends deviate from the full linearity the Duong method requires? (records m_0f5f12714fbe, m_19ad52637175)
- Would the suggested-but-declined terminal-exponential cap bring the Duong EUR estimates down to a defensible range? (record m_2df204a56c99)
- What are the units of the 'five percent terminal decline' the paper uses — per year or per day? (record m_ccb239fd515e)
- Can the paper's EUR tables (Tables 1-4) be reproduced from raw production data? (record m_805366cfe85e)
- What are the exact equation forms of the PLE, Duong, and LGM models in the original paper (OCR-garbled in the working text)? (record m_36a9dcf5ce01)

## The report (synthesis, verbatim)

# Synthesis report — SPE 162910 and the warehouse's real wells

**Question.** What does SPE 162910 claim, which of its five time-rate decline methods held on the warehouse's real wells, and what remains unresolved?

**Method.** Every claim below rests on memory records from the study and apply rounds (ids `m_…`, each marked observed / interpreted / hypothesis and, where verified, reproduced by the citation oracle on a named snapshot), plus verbatim page quotes from the working text of SPE 162910 (`paper/pages/pNN.txt`). Claims are grouped by how well they are known: **observed** (verified records only), **interpreted** (a reading of the paper, with a stated settlement criterion), and **hypothesis** (an open reading, with a stated settlement criterion).

## Observed

### R1 (observed)
The paper's central claim: unconstrained extrapolation of the Arps relations (hyperbolic with b-values greater than 1) to unconventional production data exhibiting long-term transient flow generally results in significant overestimates of EUR; the hyperbolic relation can represent early-time power-law flow regimes (linear, bilinear, multi-fracture), which is why its unconstrained use "can and almost always does yield significant overestimates of reserves".

Citations: m_1d9105d1cc31, m_ce7fe195460e

> "the unconstrained use Arps' hyperbolic rate relation (particularly for cases where the b-values are greater than 1) can and almost always does yield significant overestimates of reserves." — p. 2

### R2 (observed)
The paper prescribes a three-step workflow: (1) apply the "Db", "!-derivative", and "q/Gp" diagnostic plots to each data set to guide the analysis and obtain model parameters; (2) apply each of the five time-rate models (modified hyperbolic, power-law exponential, stretched exponential, Duong, logistic growth) to the data set, providing EUR predictions and production projections; (3) compare the EUR predictions obtained from each model by investigating model behavior, extrapolating the production profile to a time limit or abandonment rate.

Citations: m_b92d27c7e9d6, m_fd59e090bbc9

> "Our workflow for this paper is as follow: ! To apply the \"Db,\" \"!-derivative,\" and \"q/Gp\" diagnostic plots to eac h data. ! To apply each model to a given data set and provide:" — p. 3

### R3 (observed)
Across all 18 tabulated wells (East Texas Table 1; Field A Table 2, Field B Table 3, Field C Table 4), the highest EUR in every well comes from the Duong model; in the East Texas example Duong yields the highest EUR (3.17 BSCF) and the logistic growth model the lowest (2.84 BSCF), a 0.946 percent spread; the mean Duong/PLE EUR ratio is 1.1166 (Field A), 1.4776 (Field B), and 1.2780 (Field C); the modified hyperbolic falls below Duong in 12 of the 17 shale wells and above in 4 (all Field A), tying in 1 (Well A.4).

Citations: m_af2df27b8668, m_01112a02733f, m_7a2d49cf7c93

> "In Table 1 we summarize the EUR values computed at 30 years as obtained from the models. For this case, Duong's model yields the highest EUR and the logistic growth model yields the lowest EUR values." — p. 6

### R4 (observed)
The paper accordingly concludes that the Duong model "may be the least appropriate model" for Field B, where the q/Gp linearity the method requires is not clearly observed (the Duong model and the observed data do not seem to agree in general, most evident in the log[D(t)] and log[!(t)] versus log[t] plots), and that additional constraints might be required to prevent over-estimation, since the Duong model lacks the terms that limit EUR over-estimation in the modified-hyperbolic and power-law-exponential relations.

Citations: m_7a2d49cf7c93

> "In p articular, we suggest that the Duong model may be the least appropriate model for this specific play due to observation that the Duong model and the observed data do not seem to agree in general" — p. 7

### R5 (observed)
Warehouse fit, TX 42-329-41743: on the same 48 first-producing months (PLE as reference model), in-sample SSE by model is MH 44,255,058.78 (R² = 0.986255), DNG 101,120,330.04 (R² = 0.968593), LGM 234,302,292.18 (R² = 0.999694), PLE 290,290,515.79 (R² = 0.909838), and SE 290,290,515.79 (R² = 0.909838), so the best-to-worst SSE ranking is MH, DNG, LGM, then PLE and SE tied (identical R² and SSE, matching the paper's finding that PLE and SE behave nearly identically); LGM's SSE is measured on cumulative production, so the ranking mixes observation spaces and is an in-sample comparison only, and the in-sample lead of MH and DNG does not by itself establish that those models describe the well.

Citations: m_34a8c66448da (record-only citation; no page quote)

### R6 (observed)
Individual model fits on warehouse wells: the MH fit to the first 48 producing months of TX 42-329-41743 (Dlim fixed at 0.05 1/month) gives qi = 79,621.36345 bbl, Di = 0.812595 1/month, b = 1.454016, texp = 47.0 pinned at its upper bound, R² = 0.98831 (SSE = 37,637,254.805154 bbl²), i.e., a pure b > 1 hyperbolic branch inside the fitted window; the two-stage MH fit (t_exp = 24) gives stage 1 qi = 66,446.224765 bbl, Di = 0.5 1/month (at the upper fit bound), b = 1.281246 and stage 2 Dlim = 0.020306 1/month, with overall R² = 0.986255 and SSE = 44,255,058.78 bbl² (b > 1); the LGM fit to the same 48 TX months gives K = 1,762,819.188681 bbl, a = 0.050857, n = 0.582043, R² = 0.985868 (SSE = 45,500,524.135949 bbl²), with the carrying capacity K about 3.4× the 48-month cumulative Gp of 517,859.0 bbl; and the LGM fit to NM 30-015-45249 (months 1–48) gives K = 1,151,385.499994 bbl, a = 0.035865, n = 0.753355, R² = 0.999903 on the cumulative (SSE = 80,815,484.50 bbl²), with the implied month-48 rate of 4,499.153059 bbl at 85.5% of the observed 5,262.0 bbl.

Citations: m_0773ea42dac9, m_89a768874357, m_adc79b2d93a2, m_7d967f5e5267 (record-only citations; no page quotes)

## Interpreted

### R7 (interpreted)
Why the Arps hyperbolic relation misleads: it can represent the early-time power-law (transient) flow regime, so a hyperbolic curve fitted to early transient data is a poor long-term extrapolator — the EUR overestimation follows from the model's early-time flexibility, not from a data error.

Citations: m_1e855abbd278

Settlement criterion: settled by re-deriving the power-law correspondence from the original equation forms (record m_36a9dcf5ce01) or the paper's original typeset equations, since the OCR text garbles the diagnostic equations.

### R8 (interpreted)
PLE and SE give essentially identical EURs in the paper's comparisons, so the decisive split in the paper's data is between the power-law-type models and the Duong model, not between PLE and SE.

Citations: m_deb8a16c5e42

Settlement criterion: settled by reproducing the paper's EUR tables (Tables 1–4, record m_805366cfe85e) from raw production data and checking the PLE-versus-SE column differences.

## Hypothesis

### R9 (hypothesis)
Field B's q/Gp trends deviate from the full linearity the Duong method assumes, and that deviation is the main reason Field B's Duong EUR inflation (mean Duong/PLE ratio 1.4776, the largest of the three fields) is the worst.

Citations: m_7a2d49cf7c93, m_0f5f12714fbe, m_19ad52637175

Settlement criterion: settled by quantifying how far Field B's q/Gp and log[q/Gp]-versus-log[t] trends deviate from full linearity (records m_0f5f12714fbe, m_19ad52637175) against the paper's own EUR tables.

## Unresolved questions

1. How far do Field B's q/Gp and log[q/Gp]-versus-log[t] trends deviate from the full linearity the Duong method requires? (records m_0f5f12714fbe, m_19ad52637175)
2. Would the suggested-but-declined terminal-exponential cap bring the Duong EUR estimates down to a defensible range? (record m_2df204a56c99)
3. What are the units of the 'five percent terminal decline' the paper uses — per year or per day? (record m_ccb239fd515e)
4. Can the paper's EUR tables (Tables 1–4) be reproduced from raw production data? (record m_805366cfe85e)
5. What are the exact equation forms of the PLE, Duong, and LGM models in the original paper (OCR-garbled in the working text)? (record m_36a9dcf5ce01)
