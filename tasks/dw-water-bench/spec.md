# TX water_bbl is NULL: missing at the source, or dropped by the loader?

Answer that question for the data-warehousers warehouse using memory and the two files under `data/tx/`. Memory holds earlier findings: some observed and verified, some interpretations, some made against other data snapshots. Search it (`memory_search`), fetch what matters (`memory_get`), and inspect the files. Rows in a search result are references, not evidence; a record marked verified had its query reproduced on the named snapshot; an interpreted or hypothesis record is not a fact, and its settlement_criterion says what would settle it.

## Deliverable

`src/finding.json`:

```json
{
  "question": "Is TX water_bbl NULL because the source carries no water column, or because the loader drops it?",
  "claim": "observed | interpreted | hypothesis",
  "conclusion": "one paragraph",
  "settlement_criterion": "required unless observed: what evidence would settle it",
  "evidence_refs": ["m_… memory ids you relied on"],
  "checks": [
    { "kind": "header", "file": "data/tx/OG_LEASE_CYCLE.header.csv", "columns": ["…the header's columns, in order…"], "has_water_column": false }
  ]
}
```

## Rules the host checks

- `evidence_refs` resolve in this run's memory and were made on this data snapshot; a record from another snapshot must not be cited as support.
- The record that inspects the loader mapping against the source header must be among the refs: the answer is not settled by NULL counts alone.
- Each `checks` entry of kind `header` is re-read by the host: `columns` must equal the file's header row and `has_water_column` must be right.
- `claim` may be `observed` for the cause only when a header check that reproduces is present; otherwise it is `interpreted` or `hypothesis` with a non-empty `settlement_criterion`.
- A worker must fetch at least one memory record itself (delegate the file inspection and the write-up to a worker and name the ids it should fetch).
- Memory delivery stays within the run's character budget; the tools tell you what remains.

Use `kind="probe"` with `{ "id": "h", "args": ["header", "data/tx/OG_LEASE_CYCLE.header.csv"] }` to see the header as the host reads it, and `{ "id": "f", "args": ["finding"] }` to check the current `src/finding.json` against every rule before claiming `kind="done"`.
