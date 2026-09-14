# social-investment-signals workspace — one week of discussion, supplied as exports

Everything under `data/` is a **supplied export** and is read-only. All of it is **fictional fixture data** — companies, tickers, authors, filings and URLs (`example.invalid`) are synthetic and exist to exercise the task; a real run swaps in real exports of the same shape.

- `data/exports/sources.json` — the collection time and the five source files.
- `data/exports/reddit/*.jsonl`, `data/exports/x/*.jsonl` — one post per line: `id`, `source`, `author`, `published` (ISO, UTC), `collected_at`, `title` (empty for X), `body`, `url`, `score`. Some posts predate the seven-day window; some are reposts with identical bodies; one addresses automated readers directly.
- `data/tickers.csv` — the symbol master: `symbol,name,exchange,aliases` (`;`-separated) and `ambiguous` (true where a bare word could name more than one company).
- `data/primary/<id>.txt` — primary-source documents (filings, press releases) with a header (`id`, `title`, `publisher`, `published`) and body text. Verification quotes must come from these files verbatim.
- `data/baseline/<source>.json` — prior-week mention counts per ticker for the sources that have one (currently r/stocks only), with the counting method stated in the file.

Deliverables: `src/watchlist.json`, `src/briefing.md`, `src/investigations/W<n>.json` (see the specification). Only `src/` is graded; scratch notes go under `src/notes/`. Node is available (`node -e`); no Python is needed.
