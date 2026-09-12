# SCHEMA — how this wiki is organised

This wiki is compiled from `memory/records.jsonl` (the evidence log) and `runs/<id>/summary.json`.
Nobody edits these pages; edit the log through `tools/memory.mjs` (promote, tombstone, retain, consolidate) and re-render.

- `scopes/<scope>.md` — one page per memory scope: `global`, `task-<name>` (one task's runs), `repo-<name>` (every task on one external repository — the memory of the agent for that repo). Sections: **Facts** (promoted semantic and procedural records), **History** (promoted episodic records, newest first, with the run's digest), **Candidates** (unpromoted records: an agent's proposals or unverified retention).
- `runs/<id>.md` — one page per run referenced by any record: outcome, shape, oracle score, guard counts, what memory it was given.
- `guards/<name>.md` — one page per guard seen in run summaries: where it fired, how often.
- `LINT.md` — the last lint report: what a person should rule on.

Trust: a record is **promoted** only with oracle evidence (`oracle:<run>#n`) or by a human; agents' records stay **candidates** until a verdict (`tools/verdict.mjs`) or a confirming run. Tombstoned records never appear here. Recall gives an agent the scope pages it is running under (repo, task, global), Facts first, within a character budget.
