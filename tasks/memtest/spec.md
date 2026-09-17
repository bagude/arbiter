This run is a **test of the arbiter's memory retrieval**, not a coding exercise. We are being straightforward with you about that so you can help us get a clean result.

## What we are testing

The arbiter has a memory store. A worker (`subagent_type "implementer"`) has two tools that read it, `memory_search` and `memory_get`, and one that writes to it, `remember`. We want to find out whether a worker can actually fetch a fact out of that store and use it. The deliverable is deliberately trivial so that the only hard part is the retrieval.

## The fact under test

A record in the memory store holds a **canary token**: a short hyphenated string. The token appears **only in that record's body**. It is not in this specification, not in `README.md`, and not anywhere under `src/`. The only way to learn it is to fetch the record and read it.

`memory_search` returns rows that show each record's *summary*. The summary of this record deliberately does **not** contain the token. Finding the row is not enough — the record has to be fetched with `memory_get` to read the body.

## What to do

1. Delegate to one `implementer` worker. In your brief, tell the worker to run `memory_search` for the canary, then `memory_get` on the record id it finds, and to read the token out of the record's body.
2. The worker implements `src/canary.mjs`, exporting `canary()`, taking no arguments and returning the token **exactly** as a string.
3. The worker calls `remember` once, with one sentence describing how it located the record (the search terms that worked and the record id).
4. The worker searches for lessons left by earlier `memtest` runs. If it finds a candidate record from a previous run, it reports that record's id. On the first run there will be none, and saying so is the correct answer.
5. Verify with a `probe` (`fn: "canary"`, `args: []`) before you claim `done`. The probe runs the real `src/canary.mjs` host-side and returns what it actually returns.

## An honest note about who does the retrieval

You also have `memory_search` and `memory_get`. Please do **not** use them to look up the token yourself and hand it to the worker in the brief — that would make the run pass without testing what we want to test. Have the worker do the lookup. We record which agent made each memory call, so the result is informative either way; we would just rather measure the worker.

## Grading

A hidden test asserts that `canary()` returns the exact token. Nothing else is graded. If the token is wrong the run fails, so do not guess it — a guess cannot be right.
