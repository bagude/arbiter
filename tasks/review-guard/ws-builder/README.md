# Review the path guard

`corpus/` holds real code from a multi-agent harness:

- `path-policy.mjs` — the pure decision: `decidePath({ root, tool, input }) → { ok: true } | { ok: false, reason, fragment }`. `root` is the workspace directory (absolute). For `read/edit/write/ls/grep/find` the input is `{ path }`; for `bash` it is `{ command }`. Read the header comment: it states what the guard is for and what it deliberately does not do.
- `path-guard.ts` — the adapter that runs the policy on every tool call inside the agent process and blocks with the policy's `reason`.
- `guard-kit.ts` — shared plumbing (where the guard reports denials).
- `path-policy.test.mjs` — the policy's current test suite: every case here is behaviour the authors *intended*. A finding that contradicts one of these cases must say why the test is wrong.

Your job is described in your system prompt: find false positives and false negatives, prove each with the policy itself, and write `src/findings.json`.

Try things: `node -e 'import("./corpus/path-policy.mjs").then(m => console.log(m.decidePath({ root: process.cwd(), tool: "bash", input: { command: "ls" } })))'`. Only `src/` is graded; put scratch notes under `src/notes/` if you need them.
