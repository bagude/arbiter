# Study SPE 162910: what the paper claims, and what can be checked

This is a reading task, not a coding task. The workspace mounts the text of SPE 162910 (Okouma, Symmons, Hosseinpour-Zonoozi, Ilk, Blasingame, 2012: *Practical Considerations for Decline Curve Analysis in Unconventional Reservoirs — Application of Recently Developed Time-Rate Relations*) at `paper/`, one file per page. Read the workspace README first.

## The question

**What does this paper claim, on what basis, and which of it can be checked?** Build a cited reading: the time-rate relations it presents (modified hyperbolic, power-law exponential, stretched exponential, Duong, logistic growth), the diagnostic functions it uses, its workflow, and what it concludes from its field cases. Your prompt carries a MEMORY section listing a few earlier records; `memory_search` and `memory_get` reach the rest. Go where earlier claims did not, and take open questions as starting points; leave new ones for the run after you.

## The deliverable

`src/study.json` and `src/study.md`:

```json
{
  "paper": "SPE 162910",
  "claims": [
    { "id": "C1", "claim": "observed | interpreted | hypothesis",
      "text": "one specific statement about the paper",
      "quotes": [ { "page": 3, "text": "a verbatim span of at least 40 characters from that page" } ],
      "checks": [ { "id": "K1", "code": "python that prints one JSON line", "expect": { "q": 518.4 } } ],
      "settlement_criterion": "required unless observed: what evidence would settle it",
      "evidence_refs": ["m_… memory ids you relied on (optional)"] }
  ],
  "next_questions": ["what to read or check next, and why"]
}
```

Rules the host checks mechanically:
- between 4 and 8 claims, unique ids, non-empty `text`; `next_questions` non-empty; `src/study.md` present;
- every quote is found verbatim on its page (spacing and dash style ignored; at least 40 characters); a quote that is not found fails the claim;
- every check re-runs host-side with a 10 s limit and must print `expect` (numbers within 1e-4 relative); the code reads nothing from disk, imports only `json`, `sys`, `math`, `numpy`, `scipy`, and prints one JSON line;
- `claim`: `observed` = the paper says it (quote) or the computation shows it (check); `interpreted` = your reading of what it means, a reconstruction of a garbled equation, or a comparison the paper does not make itself; `hypothesis` = a conjecture worth checking on data. An observed claim needs at least one quote or check; interpreted and hypothesis claims need a non-empty `settlement_criterion`;
- across the round, claims cite at least three distinct pages;
- `evidence_refs` (optional) are memory ids that must resolve in this run's memory index.

Equations in the text are garbled. A claim about an equation's form is `observed` only if its quote carries the prose statement of it; a reconstruction from nomenclature and context is `interpreted`, and a check that evaluates your reconstruction at chosen values is what makes it usable in later rounds.

## How verification works here

`kind="probe"` takes a JSON array of `{ "id": "<label>", "args": ["quote", <page>, "<text>"] }` (does this span verify on that page?), `{ "id": "<label>", "args": ["check", "<code>", <expect>] }` (does this code print that value?), or `{ "id": "<label>", "args": ["claim", "C1"] }` (every rule against that claim of the current `src/study.json`). Probe every claim before claiming `kind="done"`.
