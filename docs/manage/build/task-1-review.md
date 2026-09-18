# Task 1 review — task state, ledger, packet assembler, CLI skeleton

Reviewed commits `6bf9083`, `eec8325` (range `2a4b514..eec8325`) against
`task-1-brief.md`, `task-1-report.md`, and spec §§1,2,5. `npm test` run: **508 pass, 0 fail**, matching the report.

## Verdict

- **Spec compliance: ❌ not clean.** The packet shape, task-state and ledger interfaces match the brief field-for-field, and the two isolation guarantees I was asked to re-check (manager never reads the oracle/workspace; `tail` reads only the orchestrator's own session, never a worker's) hold. But the "acceptance criteria are immutable" guarantee — stated three times in the material I was given (spec §1, spec §3, and the plan's own global constraint) — is not actually enforced by `saveTask`, and the redaction guarantee ("packets are redacted with `redact`... no packet contains ... a worker's raw transcript") has a real hole in `history.settledFindings` beyond the two the implementer already flagged.
- **Code quality: needs fixes**, not approved as-is. Two of the three below are small, mechanical fixes; none require redesign.

## Findings

### Critical — `saveTask`'s acceptance check is self-consistency, not immutability (`lib/manage/task-state.mjs:44-45`)

```js
export function saveTask(dir, task) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error(...);
```

This only checks that the hash on the object being saved matches that object's own criteria. It never compares against the criteria/hash already persisted at `dir/task.json`. So a caller that swaps in different criteria **and** recomputes a matching hash sails through untouched — no throw, no ledger trace, nothing.

Concrete repro:
```js
const dir = mk();
const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones, budget: {} });
const weaker = [{ id: "c1", text: "only 1 of 70 oracle cases must pass", check: "oracle:tasks/pathnorm/oracle" }];
saveTask(dir, { ...t, acceptance: { criteria: weaker, hash: acceptanceHash(weaker) } });
// succeeds — stateVersion bumps to 2, task.json now carries a silently weakened acceptance criterion.
```

This is exactly the constraint stated to me verbatim: "`acceptance.criteria` and `acceptance.hash` are never written by any instruction." The brief's own test (`manage-task-state.test.mjs`, "refuses a changed acceptance") only covers a *stale* hash relative to tampered criteria — it never tries a self-consistent tamper, so it passes today without exercising the gap. The brief's interface text — "throws if `acceptance.hash` changed" — reads naturally as "changed from what's persisted," which is the check that's actually missing.

**Minimal fix:** compare against the on-disk value when one exists:
```js
export function saveTask(dir, task) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error("...");
	const file = path.join(dir, "task.json");
	if (fs.existsSync(file)) {
		const prev = JSON.parse(fs.readFileSync(file, "utf8"));
		if (prev.acceptance.hash !== task.acceptance.hash) throw new Error("acceptance is immutable — hash differs from the persisted task; escalate instead");
	}
	...
```
Add a test that tampers with a self-consistent hash and expects the throw.

### Important — packet numbering breaks under gaps/non-numeric files, causing a silent overwrite (`lib/manage/packet.mjs:126-130, 153, 204-210`)

```js
function countPackets(taskDir) {
	...
	return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}
...
packetId: countPackets(taskDir) + 1,
```

`packetId` is `count(*.json in packets/) + 1`, not `max(numeric ids) + 1`. If `packets/` ever has a gap (a failed `writePacket`, a manually deleted packet, or any non-numeric `*.json` file dropped in — nothing filters for `/^\d+\.json$/`), the count undercounts and a later `assemblePacket`+`writePacket` will reuse an id that's already on disk. `writePacket` (`fs.writeFileSync(file, ...)`, no exclusive-create flag) then **silently overwrites** the existing packet.

Concrete repro: `packets/1.json` and `packets/5.json` exist (2 files) → `countPackets` returns 2 → next `packetId` is 3, written as `3.json`. Next call: 3 files on disk → `packetId` 4 → `4.json`. Next call: 4 files → `packetId` 5 → **overwrites `5.json`**, destroying a previously-recorded packet. This directly contradicts §7's "every packet is recorded verbatim" (the replay/audit trail this is built for) and the global constraint that packets are the durable record managers get evaluated against.

**Minimal fix:** derive the next id from the max numeric filename, ignoring non-numeric entries:
```js
function nextPacketId(taskDir) {
	const dir = path.join(taskDir, "packets");
	if (!fs.existsSync(dir)) return 1;
	const ids = fs.readdirSync(dir).map((f) => /^(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
	return (ids.length ? Math.max(...ids) : 0) + 1;
}
```
and use it in place of `countPackets(taskDir) + 1`. Worth a test with a pre-seeded gap (`1.json`, `5.json` present) asserting the next id is `6`, and one with a stray non-numeric `*.json` file asserting it's ignored.

### Important — redaction gap in `history.settledFindings`, beyond the two the implementer already flagged (`lib/manage/packet.mjs:150, 175`)

```js
const settledFindings = readFindings(taskDir).filter((f) => f.status === "verified" || f.status === "candidate");
...
history: { recentInstructions: ledgerTail, settledFindings },
```

`readFindings` rows are inserted into the packet whole — `claim`, `evidence` (a list of doc paths that could themselves be arbitrary strings), and `settlement_criterion` all reach the packet with no `redact()` call anywhere in this path. `claim` in particular is exactly the kind of free text (a hypothesis written from a `compare` outcome, which spec §5 says is meant to summarize transcript-derived evidence) that could carry something copied out of a run. The implementer's report names `trigger.detail` and `summary.reason` as the two unredacted fields; `settledFindings` is a third, and structurally the most clearly "model/human free text" of the three — it wasn't mentioned in the report or the deviations list, so it's not a documented, reviewed tradeoff, just a gap.

**Ruling on the implementer's question ("is blanket redaction of the rendered packet the right fix"): yes, apply it.** The implementer's stated worry — that `redact()`'s `KEY_WORDS` pattern would fire on a plain field like `"tokens": 157247` — doesn't hold up under the actual regex (`lib/jev.mjs:251-252`): `SECRETISH` requires a run with **both** a digit and a letter, 16+ chars, no separators, so a pure-digit value like `157247` never matches regardless of the preceding key; and the key-word branch requires `token`/`secret`/etc. to appear immediately before the quote/`:`/`=`, so `"tokens":` (trailing `s`) doesn't match it either — both by accident and by design. I did not find a plausible collision anywhere in the current packet shape (ids, hashes, and counters in this packet are either non-hex-mixed-case, too short, or preceded by key names outside `KEY_WORDS`). Given that, redacting the whole `JSON.stringify(packet)` once, right before `writePacket`/return, is lower-risk than continuing to hand-pick fields — it closes this gap and any new free-text field a later task adds (e.g. `correct`'s `message`, `escalate`'s `reason`) without a fourth field-by-field audit. Recommend adding it as a final pass in `assemblePacket`, in addition to (not instead of, for defense in depth and so `.slice()` truncation lengths stay meaningful) the existing targeted calls.

### Minor — `run.decodedTokens` sources `summary.tokens`, which is total tokens across every agent, not decode-only (`lib/manage/packet.mjs:163`, `supervisor.mjs:1589`)

`totals()` computes `tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0)` — summed across the orchestrator and all workers, not decoded/output tokens specifically. The field name promises something narrower than what's populated. Not a functional bug (no stricter figure exists yet to source instead), but worth a one-line comment or a field rename so a future manager doesn't read it as output-tokens-only when budgeting.

### Note, not a defect — zero-total budget means "unbounded," not "hard zero" (`lib/manage/task-state.mjs:65, 72`)

`spendBudget`'s guard (`if (b.total && ...)`) and `budgetLeft`'s `total ? total - used : null` both treat `total: 0` as "no cap for this resource," consistently on both sides. That's a reasonable reading of "a budget key a human never set," but it does mean there's no way to express "this resource is capped at exactly zero." Worth documenting as the deliberate convention (it already reads that way from the code, just not stated anywhere), not something to fix in this task.

## What checks out

- **Isolation.** `readTail` (`packet.mjs:106-124`) reads only `runDir/sessions/orchestrator/*.jsonl`, confirmed against `supervisor.mjs:1927` and `ext/guard-kit.ts:33-37` (worker sessions live under `tasks/*.jsonl`, a disjoint path) — the manager never sees a worker's raw transcript through this path. `readWorkers` (`packet.mjs:41-65`) never copies `workers.jsonl`'s `description` field (the orchestrator model's own free-text spawn description) into the packet at all — it's dropped entirely, not merely redacted, which is safe by omission.
- **`treeHash` extraction.** `lib/tree-hash.mjs` is byte-identical to the pre-extraction inline function in `ext/replay-capture.ts` at `2a4b514` (diffed directly, exit 0). The extension's dynamic-import line for it matches the existing `kit` import's pattern exactly, and `test/replay-capture-ext.test.mjs` (which exercises the extension end-to-end, not just the hash function in isolation) still passes, confirming the extension loads.
- **Bounding ladder.** Order is tail → chain → worker-summary truncation as specified, `packet.bounded` records exactly what was dropped, and the `eec8325` follow-up fix correctly accounts for `bounded`'s own contribution to the rendered size at each step (verified by re-reading `sizeWith`, `packet.mjs:180-200`, and its dedicated test in `test/manage-packet.test.mjs`).
- **Test quality.** Tests pin actual behaviour, not just presence: "no tmp file left behind" after a refused save, redaction verified by asserting the literal secret substring is absent (not that `redact` was called), and the bound is verified by fixture-forcing real drops and checking the final serialized size — not a mocked assertion.
- **Hygiene.** No `memory/`, `runs/`, `tasks-live/`, or `.env` paths appear in either commit's diff. `tasks-live/` was added to `.gitignore` right after `runs/`. Both commits carry `Co-Authored-By`/`Claude-Session` trailers. `npm test` reproduces 508/508 as claimed.

## Recommendation

Fix the three findings above (all localized, no redesign) before this lands as done: the acceptance-immutability check in `saveTask`, the packet-numbering scheme in `packet.mjs`, and the redaction pass (extend to `settledFindings`, and consider the blanket-redaction pass on the whole rendered packet as the more durable fix). The `decodedTokens` naming note is optional polish.

---

## Re-review: fix round 1 (`97d97a8`)

**Verdict: all three findings and the redaction ruling ADDRESSED; both minors ADDRESSED; no new Critical/Important breakage in the diff.** `npm test` reproduces **511/511** as claimed (508 prior + 3 new). Ran `test/manage-packet.test.mjs` and `test/manage-task-state.test.mjs` individually by name to confirm the new tests are the ones doing the pinning, not incidental passes.

### #1 Critical — acceptance immutability: **ADDRESSED**

`lib/manage/task-state.mjs:49-61`. `saveTask` now reads the persisted `task.json` (when one exists, `:52`) and throws if its `acceptance.hash` differs from the incoming one (`:53-54`), in addition to the pre-existing self-consistency check (`:50`). Re-ran my original repro against head by hand-tracing the new code: `createTask` writes hash `H0`; a subsequent `saveTask(dir, { ...t, acceptance: { criteria: weaker, hash: acceptanceHash(weaker) } })` now passes the self-consistency check (the weaker criteria's hash matches itself) but fails the new on-disk comparison (`H0 !== acceptanceHash(weaker)`) and throws before any write — `fs.writeFileSync(tmp, ...)` is never reached, so the tmp-file-atomicity property is preserved too. The new test at `test/manage-task-state.test.mjs:300-308` pins exactly this — self-consistent tamper, asserts both the throw and that the on-disk file is byte-unchanged — and passes. No remaining gap: the only way to legitimately change `acceptance` now is to hand-edit `task.json` directly on disk outside of `saveTask` (matching spec §1's "a human edits the file" path), which is exactly the escape hatch the spec calls for.

### #2 Important — packet numbering / silent overwrite: **ADDRESSED**

`lib/manage/packet.mjs:132-141, 226-234`. `nextPacketId` now parses `^(\d+)\.json$` filenames and takes `max + 1`, ignoring gaps and non-numeric names (`:135-140`); `writePacket` now writes with `{ flag: "wx" }`, Node's exclusive-create flag, which throws `EEXIST` rather than truncating an existing file (`:232`). Re-ran my original repro by hand-tracing: `packets/1.json` + `packets/5.json` present (a gap) → old code (`countPackets` = 2 → id 3) is gone; new code finds numeric ids `{1, 5}`, returns `6` — no collision, ever, regardless of gap size. Even in a residual edge case (two concurrent callers both compute `nextPacketId` before either writes, a scenario I flagged as a lesser, separate concern in the original review), the `wx` flag on `writePacket` now makes a collision fail loudly (`EEXIST`) instead of silently overwriting — so the actual harm (silent data loss) is closed even though the numbering function alone doesn't fully rule out a race. The new test (`test/manage-packet.test.mjs:239-255`) plants exactly the gap-plus-stray-file scenario from my review, asserts id `4`, and separately asserts `writePacket` throws `EEXIST` and leaves the existing `3.json` untouched. Confirmed by direct test run.

### #3 Important — redaction gap in `history.settledFindings`: **ADDRESSED**

`lib/manage/packet.mjs:216-223`. Ruling implemented as I recommended: one `redact()` pass over `JSON.stringify(packet)`, in addition to the existing targeted calls (tail/chain/worker-summary), returned via `JSON.parse(redact(JSON.stringify(packet)))`. The new test (`test/manage-packet.test.mjs:257-275`) plants a secret in a finding's `claim` (via `appendFinding`, landing in `history.settledFindings`) and a second in `trigger.detail`, and asserts both are absent from the rendered packet — covering exactly the gap I found plus the one the implementer had already named. Confirmed by direct test run.

### Ruling re-check — ordering and the `bounded` accounting: **confirmed correct**

The blanket `redact()` call is the last statement before `return` (`:223`), strictly after the bounding ladder's final `sizeWith(dropped)` call (`:214`) that fixes `packet.bounded`. So `.slice()` truncation lengths (tail's last 2000 chars, chain's ≤120-char lines, worker summaries' 100/300-char caps) are computed and locked in before redaction ever touches the string, meaning the size-accounting comments in the ladder still describe the actual pre-redaction shape.

On "cannot push the packet over maxChars": I checked this against `redact`'s own regex (`lib/jev.mjs:251-263`), not just the code comment's assertion. Every substitution branch replaces a matched run of ≥16 non-quote, non-comma, non-brace characters with a fixed literal no longer than the shortest possible match:
- `Bearer <token>` → `$1[REDACTED]` (drops everything after "Bearer " down to 10 chars)
- key-word assignment → `$1[REDACTED]` (drops a ≥16-char value to 10 chars)
- known prefixes (`sk-`, `AKIA`, `ghp_`, `apikey_`, …, each ≥16-20 chars minimum) → `[REDACTED]` (10 chars)
- JWT (≥32 chars minimum) → `[REDACTED JWT]` (14 chars)
- PEM block (at minimum `-----BEGIN X-----\n...\n-----END X-----`, far longer than 22 chars in practice) → `[REDACTED PRIVATE KEY]` (22 chars)

Every branch's replacement is shorter than its minimum possible match, so `redact()` can only shrink or leave a string unchanged, never grow it — confirmed by static reasoning over the regex, matching the code's own comment (`:221-222`). I did not find, and did not attempt to construct, a case where the blanket pass increases size. This also means the ladder's known, pre-existing limitation (documented in the report's Concerns section: if all three drops still leave the packet over `maxChars`, `assemblePacket` returns it oversized anyway) is unchanged by this fix — the blanket redact pass can only help that case, never hurt it, and does not paper over it either.

I also checked, by static analysis of `redact`'s character classes (not by running code, per the read-only constraint), that the packet's own structural fields — `acceptance.hash` (sha256 hex), `run.id` (timestamp-shaped), `run.config` (a `configs/...json` path) — don't collide with the redaction patterns: `KEY_WORDS` requires one of a fixed list of words (`token`, `secret`, `password`, …) immediately before the separator, none of which are `hash`, `id`, or `config`; and `SECRETISH`'s character class excludes `/`, so a path value can only ever match the tail segment after the last `/`, which still isn't preceded by a recognized key word. No new false-positive risk found from making the pass blanket rather than targeted.

### Minors

- **`run.decodedTokens` → `run.tokens` rename: ADDRESSED.** `lib/manage/packet.mjs:174-177` now uses `tokens` with a comment explaining it's the all-agent total, not decode-only. Matches my suggestion.
- **Zero-total budget convention: ADDRESSED (documented).** `lib/manage/task-state.mjs:69-73` now states the "0 total = unbounded" convention explicitly as deliberate, on both `spendBudget` and `budgetLeft`. This was a note, not a defect, in my original review; documenting it closes it.

### New breakage check

No new Critical or Important issues found in this diff. Scope was narrow (two files' worth of targeted fixes plus their tests) and every change is additive or defense-in-depth: the two new immutability/numbering checks only ever make `saveTask`/`writePacket` throw in cases that previously succeeded incorrectly (no legitimate call path is newly rejected — traced through both remaining brief-mandated call sites, `createTask` and `tools/manage.mjs`'s `cmdPacket`, neither of which reuses an id or resaves a task with a foreign acceptance object), and the redact pass is a pure post-processing step with no other consumers of `writePacket`/`assemblePacket` yet in the tree (`grep` for both names found only `packet.mjs` itself, its test, and `tools/manage.mjs`, which calls each once per invocation — no code path double-writes or depends on `writePacket` succeeding after a collision).
