# Synthesis: what SPE 162910 says, and what the warehouse showed

This is a writing task with a citation oracle. Earlier rounds built a cited reading of SPE 162910 and fitted its time-rate models to real wells; their findings are memory records. Read the workspace README first.

## The question

**What does the paper claim, which of its methods held on the warehouse's wells, and what remains unresolved?** Write it as a report a reservoir engineer would trust: every claim rests on memory records (ids `m_…`) or page quotes, labelled by how well it is known.

## The deliverable

`src/report.json` and `src/report.md`:

```json
{
  "question": "one sentence",
  "claims": [
    { "id": "R1", "claim": "observed | interpreted | hypothesis",
      "text": "one statement",
      "cites": ["m_0123456789ab"],
      "quotes": [ { "page": 3, "text": "a verbatim span of at least 40 characters" } ],
      "settlement_criterion": "required unless observed" }
  ],
  "unresolved": ["questions the rounds left open, one per line"]
}
```

Rules the host checks mechanically:
- at least 6 claims, at least 2 of them `observed`; unique ids; `unresolved` non-empty; `src/report.md` present;
- every claim cites at least one memory record or one quote;
- every cited id resolves in this run's memory index within the allowed scopes, and is neither tombstoned nor superseded;
- an `observed` claim cites only records that are themselves `observed` and verified (the oracle reproduced their quote, check or query); citing an interpreted or unverified record makes the claim `interpreted` at best;
- `interpreted` and `hypothesis` claims carry a non-empty `settlement_criterion`;
- every quote is found verbatim on its page (spacing ignored; at least 40 characters).

`src/report.md` is the same report for a person: the question, the claims grouped by how well they are known, the citations inline, and the unresolved questions at the end.

## How verification works here

`kind="probe"`: `["cite", "m_…"]` shows how a record resolves (claim, verified, status, snapshot); `["quote", <page>, "<text>"]` checks a span; `["claim", "R1"]` runs every rule against that claim of the current `src/report.json`. Probe every claim before claiming `kind="done"`.
