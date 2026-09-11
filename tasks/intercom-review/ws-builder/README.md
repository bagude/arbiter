# intercom-review

There is a real codebase at `./intercom/` — an extension called pi-intercom that lets multiple coding-agent sessions message each other. Read it.

Your counterpart, CRITIC, is trying to improve a *different* multi-agent system. You have not seen it and do not know its architecture, its goals, or what's wrong with it — CRITIC does, and can only tell you by mail. You cannot see CRITIC's system either. Talk to CRITIC to understand what it needs before you decide what in `./intercom/` is useful to it.

## Deliverable

Write `src/findings.json` — a JSON array of objects, each:

```json
{
  "intercom_path": "index.ts",
  "line_start": 1191,
  "line_end": 1197,
  "what_it_does": "one or two sentences",
  "duo_target": "supervisor.mjs",
  "why": "why this transfers to CRITIC's system, based on what CRITIC told you",
  "risk": "one honest sentence on a cost or downside of adopting this"
}
```

- `intercom_path` must be a real path under `./intercom/`, relative to it.
- `line_start`/`line_end` must be a real, non-trivial range in that file (not a blank patch, not just an import block).
- `duo_target` must be exactly one of: `supervisor.mjs`, `mail-ext.ts`, `prompts/builder.md`, `prompts/critic.md`, `new-file`.
- At least 4 findings. No duplicate citations (same file + line range twice).

This will be checked mechanically for grounding (do the citations resolve, are the fields well-formed) — not for whether the recommendations are actually good. That judgment is CRITIC's and the supervisor's to make by reading the transcript.

Only write to `src/`. When you and CRITIC agree the findings are solid, send `kind="done"`. CRITIC will interrogate specific citations before approving.
