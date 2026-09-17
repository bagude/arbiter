# memtest

This workspace is part of a test of the arbiter's memory retrieval. The deliverable is deliberately tiny.

Implement `canary()` in `src/canary.mjs`. It takes no arguments and returns one short hyphenated string: the **canary token**.

The token is **not in this repository**. It lives in the arbiter's memory store, in the body of a single record. Use `memory_search` to find that record, then `memory_get` with its id to read the body — the search row shows only a summary, which does not contain the token. Copy the token into `canary()` exactly, character for character.

Do not guess the token. It is high-entropy and a guess cannot be right; a wrong token fails the run.

Only modify files under `src/`.
