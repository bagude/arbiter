# Apply SPE 162910's time-rate models to the real warehouse

This is a data task built on a paper. The workspace mounts the real production warehouse at `data/real/` and the text of SPE 162910 at `paper/` (Okouma et al., 2012). Read the workspace README first.

## The question

**Which of the paper's time-rate relations describe these wells, and what do the fits say?** The paper presents the modified hyperbolic (MH), power-law exponential (PLE), stretched exponential (SE), Duong (DNG) and logistic growth (LGM) models and warns that unconstrained hyperbolic extrapolation with b > 1 overstates reserves. The warehouse has monthly rates, months on production and cumulatives per well, no pressures. Your prompt carries a MEMORY section with a few earlier records (the study rounds' claims about the paper, and the warehouse's own findings); `memory_search` and `memory_get` reach the rest. Take the study's open questions and the warehouse's known quirks (TX has well and lease rows; OK is a master snapshot; NM water anomalies) as starting points.

## The deliverable

`src/exploration.json` and `src/exploration.md`, the explorer contract plus three fields per observation:

```json
{
  "scope": "one sentence: which wells and models, and why",
  "observations": [
    { "id": "O1", "title": "short, specific",
      "observation": "what the fit shows, with the numbers from compute.expect in the text",
      "why_it_matters": "what an analyst would do with this",
      "claim": "observed | interpreted | hypothesis",
      "settlement_criterion": "required unless observed",
      "evidence_refs": ["m_… memory ids you relied on (optional)"],
      "model": "MH | PLE | SE | DNG | LGM",
      "paper_refs": ["p59", "C4"],
      "query": "select months_on_production, total_oil_bbl from decline_curve_inputs where entity_key = '…' and months_on_production <= 48 order by 1",
      "result": [[1, 1410.0], [2, 1300.0]],
      "compute": { "code": "import json, sys, numpy as np\nrows = json.load(sys.stdin)\n… fit …\nprint(json.dumps({\"Di\": …, \"qi\": …}))", "expect": { "Di": 0.0412, "qi": 1398.2 } },
      "confidence": 0.8 }
  ],
  "next_questions": ["what to fit or check next, and why"]
}
```

Rules the host checks mechanically:
- every explorer rule (5–8 observations, unique ids, distinct titles, read-only query under 10 s returning at most 50 rows that reproduce, a number from the result in the text, claim structure, evidence_refs resolving);
- `model` is one of MH, PLE, SE, DNG, LGM; `paper_refs` is a non-empty list of page ids (`p59`) or study claim ids (`C4`);
- `compute.code` receives the observation's `result` rows as JSON on stdin (`json.load(sys.stdin)`), imports only `json`, `sys`, `math`, `numpy`, `scipy`, reads nothing from disk, runs in under 10 s host-side, and prints one JSON line equal to `compute.expect` (numbers within 1e-4 relative). Fix every random seed and initial guess so a re-run prints the same numbers.
- `observation` mentions at least one number from `compute.expect` or `result`.

An `observed` claim states what the fit produced; whether a model *describes* a well is `interpreted` unless the observation compares fits (say, residuals of two models on the same rows) inside the same compute.

## How verification works here

`kind="probe"`: `["query", "<sql>"]` runs the read-only query and returns the rows exactly as compared; `["observation", "O1"]` reproduces the observation's query and rows; `["compute", "O1"]` re-runs the observation's compute on its rows and shows what it printed against `expect`. Probe every observation before claiming `kind="done"`.
