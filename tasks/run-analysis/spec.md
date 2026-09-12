This is a research task, not a coding task. The workspace holds the complete record of 23 finished runs of a multi-agent harness ("arbiter") under `runs/<id>/`, plus the harness's own backlog at `docs/backlog.md`. README.md describes every file's format.

## The question

**What failure signatures recur across these runs, and which single guard (a model-free rule the harness could enforce on a tool call or a message) would remove the most wasted cost?**

A *signature* is a recurring, mechanically recognisable pattern in the logs — e.g. "the same probe case re-sent against unchanged code", "a turn that produced text but no tool call", "a bash call with no timeout", "a worker that read the same file in 30-line slices", "an approval rejected N times for the same reason". *Cost* means wall-clock seconds, tool calls, mails or tokens that the pattern consumed without moving the run toward success.

## The deliverable

`src/findings.json`:

```json
{
  "question": "<the question above, verbatim>",
  "findings": [
    {
      "id": "F1",
      "signature": "short name of the recurring pattern",
      "description": "what happens, mechanically, in the logs",
      "occurrences": 4,
      "runs": ["2026-09-10T17-51-01", "2026-09-10T18-51-34"],
      "evidence": [
        { "run": "2026-09-10T17-51-01", "file": "audit.jsonl", "quote": "an exact substring of at least 40 characters copied verbatim from that file" }
      ],
      "cost": "what it consumed, with numbers from the logs (seconds, calls, mails, tokens)",
      "proposed_guard": "the model-free rule, where it would sit (tool_call / tool_result / context / mail), and what it would say instead",
      "confidence": 0.8
    }
  ],
  "recommendation": "the ONE guard to build first, and why it removes the most cost"
}
```

Rules that the host checks mechanically:
- at least 5 findings, each with a unique `id` and a distinct `signature`;
- every `evidence` entry names a run that exists under `runs/`, a file that exists in that run, and a `quote` of at least 40 characters that appears **verbatim** in that file — copy, do not paraphrase;
- at least 2 evidence entries per finding, from at least 2 different runs;
- `occurrences` ≥ 2, `runs` non-empty, `cost` and `proposed_guard` non-empty, `confidence` in [0, 1];
- `recommendation` non-empty and naming one of the findings' ids.

## How verification works here

`kind="probe"` takes a JSON array of `{ "id": "<any label>", "args": ["F1"] }` — one entry per finding id — and returns, for each, whether that finding is grounded right now (every quote found verbatim in its cited file, runs and files exist) and exactly which check failed if not. Probe before you claim `kind="done"`: a worker's report that its quotes are verbatim is a claim, not a fact.

Only `src/findings.json` is graded. Workers may write scratch notes under `src/notes/`; nothing else outside `src/` is read.
