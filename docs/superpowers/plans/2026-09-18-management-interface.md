# Management Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent management layer around arbiter runs: durable task state, observation packets at triggers, a six-verb instruction contract the harness executes with state-version and idempotency checks, evidence-tied milestone acceptance, and a manager driver with a packet-replay harness.

**Architecture:** A task directory `tasks-live/<taskId>/` outlives runs and holds `task.json` (state, versioned), `ledger.jsonl` (every trigger/instruction/outcome), `findings.jsonl` (claims from compares), `packets/`, `checkpoints/`. Pure modules under `lib/manage/` do state, packets, validation and evidence; `tools/manage.mjs` is the CLI and the executor; the supervisor gains a control-file tailer (grants, corrections, decisions) and trigger emission with pause semantics. The fork runner is the engine behind `restore` and `compare`. The manager is any process that reads a packet and writes an instruction; the first is a Claude model called through `tools/manage.mjs decide`.

**Tech Stack:** Node ESM (the repo's), `node:test`, `node:sqlite` already in use, `lib/jev.mjs redact`, `tools/fork.mjs`, the Anthropic Messages API over `fetch` for the manager.

**Spec:** `docs/superpowers/specs/2026-09-18-management-interface-design.md` — every section number below refers to it.

## Global Constraints

- Repo `C:\Users\user\open_harnessess\pi\arbiter`, branch `probe-match` (= `master`); `npm test` = `node --test "test/**/*.test.mjs"`, 497 pass today. Work on a branch `management` from probe-match, stage by explicit path, never stage `memory/`, `runs/`, `tasks-live/`, or `.env`. Files keep their line endings; write files with backslashes or non-ASCII through the file tools, never through shell strings (three mangling incidents on 2026-09-17).
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QNstRa6QzP2vS2hgeYGo3F`. A commit is made only on a green suite.
- The supervisor cannot be imported in tests (importing starts a run): every non-trivial piece lives in `lib/manage/*.mjs` and is unit-tested; supervisor changes are pinned by source assertions in `test/supervisor-guards.test.mjs` (pattern: `supervisorSource()`, block slicing).
- **The manager never touches the workspace, the oracle, or a transcript** (spec §"What it is"). `acceptance.criteria` and `acceptance.hash` are never written by any instruction (§1). No packet contains oracle case inputs, the hidden test, or a raw worker transcript (§2). Packets are redacted with `redact` from `lib/jev.mjs` and bounded at 120 000 characters.
- Every instruction carries `packetId`, `basedOnStateVersion`, `idempotencyKey`, `verb`, `args`, `rationale ≤ 500 chars` (§3). A stale version is refused with a fresh packet; a repeated key is acknowledged and not executed.
- Triggers and pause semantics are exactly §4's table; decision timeout default 120 s → `continue` with a zero grant, recorded as `defaulted: true`.
- Never run `supervisor.mjs` or `tools/fork.mjs` from a test. Live checks are named as steps and run by the controller when the llama server is up (`PRESET=router` via `serve.ps1`).
- `tasks-live/` is gitignored (add it in Task 1).

---

## File structure

| file | responsibility |
|---|---|
| `lib/manage/task-state.mjs` | create/load/save `task.json` atomically with `stateVersion`; acceptance hash; milestone/current/budget helpers; validation |
| `lib/manage/ledger.mjs` | append/read `ledger.jsonl`; idempotency lookup; findings append/read/settle |
| `lib/manage/packet.mjs` | assemble a bounded, redacted observation packet from a task dir + run dir + trigger |
| `lib/manage/instructions.mjs` | the six verbs: schema, `validateInstruction` (version, key, verbsAllowed, budget, preconditions) — pure |
| `lib/manage/evidence.mjs` | the four evidence kinds (§6): pure checks over a checkpoint dir + run records; `playthrough` shells out |
| `lib/manage/checkpoint.mjs` | snapshot a workspace into `checkpoints/ck-NNNN/` with a tree hash (hash extracted from `ext/replay-capture.ts`) |
| `lib/manage/triggers.mjs` | pure: given run counters/events, which trigger fires and whether it pauses (§4) |
| `lib/tree-hash.mjs` | `treeHash(dir)` shared by capture and checkpoints |
| `tools/manage.mjs` | CLI: `init`, `packet`, `execute`, `decide`, `replay`, `ledger`, `accept` |
| `supervisor.mjs` | control-file tailer (`runs/<id>/control.jsonl`), trigger emission to `lifecycle.jsonl` + packet request, pause with timeout, budget grants |
| `test/manage-*.test.mjs` | one file per lib module; `test/supervisor-guards.test.mjs` gains the control/trigger source assertions |

---

### Task 1: Task state, ledger, packet assembler, CLI skeleton (build order 1)

**Files:**
- Create: `lib/manage/task-state.mjs`, `lib/manage/ledger.mjs`, `lib/manage/packet.mjs`, `lib/tree-hash.mjs`, `tools/manage.mjs`
- Modify: `ext/replay-capture.ts` (import `treeHash` from `lib/tree-hash.mjs` instead of its local copy), `.gitignore` (+`tasks-live/`)
- Test: `test/manage-task-state.test.mjs`, `test/manage-ledger.test.mjs`, `test/manage-packet.test.mjs`, `test/tree-hash.test.mjs`

**Interfaces:**
- Produces: `createTask({ dir, taskId, goal, criteria, milestones, budget }) → task`, `loadTask(dir) → task`, `saveTask(dir, task) → task` (writes `task.json.tmp` then renames; increments `stateVersion`; throws if `acceptance.hash` changed), `acceptanceHash(criteria) → sha256 hex`, `setCurrent(task, patch)`, `spendBudget(task, { wallSec?, runs?, forkReplicates?, usd? })` (throws `BudgetExceeded`).
- `appendLedger(dir, row) → row` (adds `ts`, sequential `seq`), `readLedger(dir) → rows`, `findByKey(dir, idempotencyKey) → row | null`, `appendFinding(dir, finding)`, `readFindings(dir)`, `settleFinding(dir, id, { status, verifiedOn })`.
- `assemblePacket({ taskDir, runDir, trigger, verbsAllowed, maxChars = 120000 }) → packet` with the exact §2 shape; `writePacket(taskDir, packet) → path` (numbered `packets/<n>.json`).
- `treeHash(dir) → sha1 hex` (byte-identical to the capture's current function).

- [ ] **Step 1: Write the failing tests for task state**

`test/manage-task-state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask, loadTask, saveTask, acceptanceHash, spendBudget, setCurrent } from "../lib/manage/task-state.mjs";

const criteria = [{ id: "c1", text: "all 70 oracle cases pass", check: "oracle:tasks/pathnorm/oracle" }];
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "task-"));

test("createTask writes task.json with version 1, the acceptance hash, and pending milestones", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "pass pathnorm", criteria, milestones: [{ id: "m1", title: "pass", criteria: ["c1"] }], budget: { wallSec: 3600, runs: 4, forkReplicates: 12, usd: 5 } });
	assert.equal(t.stateVersion, 1);
	assert.equal(t.acceptance.hash, acceptanceHash(criteria));
	assert.equal(t.milestones[0].status, "active", "the first milestone is active, later ones pending");
	assert.equal(t.current.milestone, "m1");
	assert.deepEqual(loadTask(dir), t);
	assert.ok(fs.existsSync(path.join(dir, "task.json")));
});

test("saveTask increments the version atomically and refuses a changed acceptance", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: {} });
	const t2 = saveTask(dir, setCurrent(t, { activeRuns: ["r1"] }));
	assert.equal(t2.stateVersion, 2);
	assert.deepEqual(loadTask(dir).current.activeRuns, ["r1"]);
	const tampered = { ...loadTask(dir), acceptance: { criteria: [{ id: "c1", text: "weaker", check: "oracle:x" }], hash: acceptanceHash(criteria) } };
	assert.throws(() => saveTask(dir, tampered), /acceptance/);
	assert.ok(!fs.existsSync(path.join(dir, "task.json.tmp")), "no temp file left behind");
});

test("spendBudget charges and refuses past the total", () => {
	const dir = mk();
	const t = createTask({ dir, taskId: "t1", goal: "g", criteria, milestones: [{ id: "m1", title: "x", criteria: ["c1"] }], budget: { runs: 2 } });
	const t2 = spendBudget(t, { runs: 1 });
	assert.equal(t2.budget.runs.used, 1);
	assert.throws(() => spendBudget(t2, { runs: 2 }), /BudgetExceeded|budget/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/manage-task-state.test.mjs`
Expected: FAIL with "Cannot find module '../lib/manage/task-state.mjs'"

- [ ] **Step 3: Implement `lib/manage/task-state.mjs`**

```js
// task-state — the durable account of where a task stands (spec §1). task.json is rewritten
// atomically on every change and carries a stateVersion that every packet and instruction
// names; acceptance criteria are hashed at creation and can never be changed by a save.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const BUDGET_KEYS = ["wallSec", "runs", "forkReplicates", "usd"];

export function acceptanceHash(criteria) {
	return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

function budgetShape(budget = {}) {
	const out = {};
	for (const k of BUDGET_KEYS) out[k] = { total: Number(budget[k] ?? 0), used: 0 };
	return out;
}

export function createTask({ dir, taskId, goal, criteria, milestones, budget = {} }) {
	if (!Array.isArray(criteria) || !criteria.length) throw new Error("a task needs at least one acceptance criterion");
	for (const c of criteria) if (!c.id || !c.text || !/^(oracle|playthrough|artifact|review):/.test(c.check ?? "")) throw new Error(`criterion ${c.id ?? "?"}: needs id, text and a check of kind oracle:|playthrough:|artifact:|review:`);
	const ms = (milestones ?? []).map((m, i) => ({ id: m.id, title: m.title, criteria: m.criteria ?? [], status: i === 0 ? "active" : "pending" }));
	const task = {
		taskId, goal,
		acceptance: { criteria, hash: acceptanceHash(criteria) },
		milestones: ms,
		current: { milestone: ms[0]?.id ?? null, checkpoint: null, activeRuns: [], activeBranches: [] },
		blockers: [],
		budget: budgetShape(budget),
		status: "active",
		stateVersion: 0,
	};
	fs.mkdirSync(path.join(dir, "packets"), { recursive: true });
	fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
	return saveTask(dir, task);
}

export function loadTask(dir) {
	return JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
}

/** Atomic write; bumps stateVersion; refuses a task whose acceptance no longer matches its hash. */
export function saveTask(dir, task) {
	if (task.acceptance.hash !== acceptanceHash(task.acceptance.criteria)) throw new Error("acceptance criteria do not match their hash — criteria are immutable; escalate instead");
	const next = { ...task, stateVersion: (task.stateVersion ?? 0) + 1, updatedAt: Date.now() };
	const file = path.join(dir, "task.json");
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
	fs.renameSync(tmp, file);
	return next;
}

export function setCurrent(task, patch) {
	return { ...task, current: { ...task.current, ...patch } };
}

export class BudgetExceeded extends Error {}

export function spendBudget(task, spend) {
	const budget = { ...task.budget };
	for (const [k, v] of Object.entries(spend)) {
		if (!BUDGET_KEYS.includes(k)) throw new Error(`unknown budget ${k}`);
		const b = budget[k];
		if (b.total && b.used + v > b.total) throw new BudgetExceeded(`budget ${k}: ${b.used} + ${v} > ${b.total}`);
		budget[k] = { ...b, used: b.used + v };
	}
	return { ...task, budget };
}

export function budgetLeft(task) {
	return Object.fromEntries(BUDGET_KEYS.map((k) => [k, task.budget[k].total ? task.budget[k].total - task.budget[k].used : null]));
}
```

- [ ] **Step 4: Run the task-state tests**

Run: `node --test test/manage-task-state.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing ledger tests**

`test/manage-ledger.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLedger, readLedger, findByKey, appendFinding, readFindings, settleFinding } from "../lib/manage/ledger.mjs";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));

test("appendLedger numbers rows, stamps ts, and findByKey finds an idempotency key", () => {
	const dir = mk();
	const a = appendLedger(dir, { packetId: 1, stateVersion: 3, trigger: "run_ended", instruction: { idempotencyKey: "p1-v3", verb: "continue" } });
	const b = appendLedger(dir, { packetId: 2, stateVersion: 4, trigger: "budget_threshold", instruction: { idempotencyKey: "p2-v4", verb: "correct" } });
	assert.deepEqual([a.seq, b.seq], [1, 2]);
	assert.ok(a.ts <= b.ts);
	assert.equal(readLedger(dir).length, 2);
	assert.equal(findByKey(dir, "p2-v4").seq, 2);
	assert.equal(findByKey(dir, "nope"), null);
});

test("findings are claims with a settlement criterion; settleFinding updates status and verifiedOn", () => {
	const dir = mk();
	const f = appendFinding(dir, { id: "f1", scope: "harness:pathnorm", claim: "skipping ls at p≥.95 changes nothing", settlement_criterion: "same on a second run", evidence: ["docs/batch/x.md"] });
	assert.equal(f.status, "candidate");
	settleFinding(dir, "f1", { status: "verified", verifiedOn: ["run-a", "run-b"] });
	const [g] = readFindings(dir);
	assert.equal(g.status, "verified");
	assert.deepEqual(g.verifiedOn, ["run-a", "run-b"]);
	assert.throws(() => appendFinding(dir, { id: "f2", claim: "no criterion" }), /settlement_criterion/);
});
```

- [ ] **Step 6: Implement `lib/manage/ledger.mjs`**

```js
// ledger — append-only management record (spec §5): one row per trigger/instruction/outcome,
// plus findings (claims with settlement criteria) written from compares and read back into
// packets. Idempotency keys are looked up here BEFORE anything executes.
import fs from "node:fs";
import path from "node:path";

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

export function readLedger(dir) { return readJsonl(path.join(dir, "ledger.jsonl")); }

export function appendLedger(dir, row) {
	const rows = readLedger(dir);
	const out = { seq: rows.length + 1, ts: Date.now(), ...row };
	fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify(out) + "\n");
	return out;
}

export function findByKey(dir, idempotencyKey) {
	return readLedger(dir).find((r) => r.instruction?.idempotencyKey === idempotencyKey) ?? null;
}

/** Update the outcome of the row that executed `idempotencyKey` (appends an outcome row; the ledger stays append-only). */
export function recordOutcome(dir, idempotencyKey, outcome) {
	return appendLedger(dir, { kind: "outcome", forKey: idempotencyKey, outcome });
}

export function readFindings(dir) {
	// last row per id wins (settlements are appended, not rewritten)
	const byId = new Map();
	for (const f of readJsonl(path.join(dir, "findings.jsonl"))) byId.set(f.id, { ...(byId.get(f.id) ?? {}), ...f });
	return [...byId.values()];
}

export function appendFinding(dir, finding) {
	if (!finding.id || !finding.claim || !finding.settlement_criterion) throw new Error("a finding needs id, claim and settlement_criterion");
	const out = { status: "candidate", verifiedOn: [], evidence: [], ts: Date.now(), ...finding };
	fs.appendFileSync(path.join(dir, "findings.jsonl"), JSON.stringify(out) + "\n");
	return out;
}

export function settleFinding(dir, id, { status, verifiedOn = [] }) {
	if (!["candidate", "verified", "refuted"].includes(status)) throw new Error(`bad finding status ${status}`);
	fs.appendFileSync(path.join(dir, "findings.jsonl"), JSON.stringify({ id, status, verifiedOn, settledAt: Date.now() }) + "\n");
}
```

- [ ] **Step 7: Run the ledger tests** — `node --test test/manage-ledger.test.mjs` → PASS (2 tests)

- [ ] **Step 8: Extract `treeHash` and write its test**

Create `lib/tree-hash.mjs` with the function currently at `ext/replay-capture.ts:30-48` (sha1 over sorted relative paths and contents, `|` separators), exported as `treeHash(dir)`. In `ext/replay-capture.ts`, replace the local function with `const { treeHash } = await import(new URL(\`file:///${path.join(home, "lib", "tree-hash.mjs").replace(/\\/g, "/")}\`).href);` next to the existing `kit` import. `test/tree-hash.test.mjs`: two temp dirs with the same files hash equal; changing one byte changes the hash; an empty dir hashes to sha1 of "" (`da39a3ee5e6b4b0d3255bfef95601890afd80709`).

- [ ] **Step 9: Write the failing packet tests**

`test/manage-packet.test.mjs` builds a fake run dir under a temp root — `summary.json` with `{ reason, wallSec, task: "pathnorm", guards: {}, doneAttempts: 2 }`, `audit.jsonl` with two `Oracle run #n: 68/70` lines and a `MAIL … [done]` line, `decisions.jsonl` with three points (one `done`), `decisions-replay-substantive.jsonl` with a `head` row, `workers.jsonl` with one `started`+`completed`, a `sessions/…` transcript whose last message contains `TYPESAFE_API_KEY=apikey_29abc…` — and a task dir from `createTask`. Asserts:

```js
const p = assemblePacket({ taskDir, runDir, trigger: { kind: "oracle_failed_repeatedly", runId: "r1", detail: { attempts: 2 } }, verbsAllowed: ["continue","correct","restore","compare","accept","escalate"] });
assert.equal(p.packetId, 1);
assert.deepEqual(p.task, loadTask(taskDir), "the task state travels whole");
assert.equal(p.run.oracle.length, 2);
assert.equal(p.run.decisions.points, 3);
assert.equal(p.run.heads.local27b.confidentDisagreements.length, 1);
assert.ok(!JSON.stringify(p).includes("apikey_29abc"), "redacted");
assert.ok(JSON.stringify(p).length <= 120000);
assert.deepEqual(p.options.verbsAllowed, [...]);
assert.equal(writePacket(taskDir, p), path.join(taskDir, "packets", "1.json"));
const p2 = assemblePacket({ ... });  // second call numbers 2
assert.equal(p2.packetId, 2);
```

Plus: with `verbsAllowed` omitted, the assembler prunes `compare`/`restore` when `budgetLeft.forkReplicates === 0` and `runs === 0`, and prunes `accept` when the trigger is not `milestone_candidate` or `comparison_ready`.

- [ ] **Step 10: Implement `lib/manage/packet.mjs`**

Shape exactly §2. Sources: `summary.json` (run fields, guards, doneAttempts), `audit.jsonl` (oracle lines via `/Oracle run #(\d+): (\d+)\/(\d+)/`, worker summaries from `report {…}` tool lines truncated to 300 chars, `chain` = the last 40 audit lines of types `mail`, `oracle`, `guard`, `finish`, `jev` rendered `t · type · msg≤120`), `decisions.jsonl` (counts per substantive class), `decisions-replay-substantive.jsonl` (agreement and `confidentDisagreements` = rows with `head.confidence ≥ 0.9 && !head.agreeSubstantive`, each `{ call: i+1, recorded, head: pickClass, p }`), `decisions-jev-done.jsonl` or `jev/` files (the done-check answer if present), `tail` = last 2 000 chars of the orchestrator session file under `runs/<id>/sessions/orchestrator/*.jsonl` (assistant text only), everything passed through `redact`. History: last 5 ledger rows' `{ packetId, verb, outcome }` and `readFindings` with status verified or candidate. `options.budgetLeft` from `budgetLeft(task)`. If the rendered JSON exceeds `maxChars`, drop `tail` first, then `chain`, then truncate `workers` summaries to 100 chars, and record what was dropped in `packet.bounded`. `writePacket` numbers by counting `packets/*.json` + 1 and writes `packets/<n>.json`; `packetId` is assigned by `assemblePacket` the same way (read the directory).

- [ ] **Step 11: Run the packet tests** — `node --test test/manage-packet.test.mjs` → PASS

- [ ] **Step 12: CLI skeleton `tools/manage.mjs`**

Subcommands: `init <taskDir> --task pathnorm --goal "…" --criteria <json> --milestones <json> --budget <json>` (calls `createTask`), `packet <taskDir> <runId> --trigger <kind> [--detail <json>] [--runs <dir>]` (assemble + write, prints the path and size), `ledger <taskDir>` (prints rows and findings). Usage on no args, exit 2. No network.

- [ ] **Step 13: Full suite, gitignore, commit**

Add `tasks-live/` to `.gitignore`. Run `npm test` → all pass (497 + new). Commit: `feat(manage): task state, ledger and observation packets over existing run records; tree hash shared with capture`.

---

### Task 2: Instruction contract, control channel, triggers with pause (build order 2)

**Files:**
- Create: `lib/manage/instructions.mjs`, `lib/manage/triggers.mjs`
- Modify: `supervisor.mjs`, `tools/manage.mjs` (`execute`), `lib/messages.mjs` (a `manage.correction(message)` wrapper), `lib/routing.mjs` (`kind === "escalate"` → `{ action: "escalate" }`), `ext/mail-ext.ts` (mention `escalate` in the kind description for the orchestrator pattern)
- Test: `test/manage-instructions.test.mjs`, `test/manage-triggers.test.mjs`, `test/supervisor-guards.test.mjs`, `test/routing.test.mjs`

**Interfaces:**
- Consumes: Task 1's `loadTask/saveTask/spendBudget/budgetLeft`, `appendLedger/findByKey/recordOutcome`.
- Produces: `INSTRUCTION_VERBS`, `validateInstruction(instr, { task, packet }) → { ok: true } | { ok: false, refusal: string, code: "stale_version"|"duplicate_key"|"verb_not_allowed"|"budget"|"precondition" }`; `executeInstruction({ taskDir, instr, packet, runsDir }) → { executed, ledgerRow }` for `continue`, `correct`, `escalate` (restore/compare/accept throw `NotYetImplemented` until Tasks 3–4); `controlAppend(runDir, entry)` writes `runs/<id>/control.jsonl`; `decideTrigger(state) → { kind, pauses } | null` (pure, §4).
- Supervisor: tails `control.jsonl` every 2 s; entries `{ type: "grant", wallSec, toolCalls }` raise caps, `{ type: "correct", message }` delivers via `deliver(VERIFIER, M.manage.correction(message), "manager correction")`, `{ type: "decision", packetId, verb }` releases a pause; emits `lifecycle` events `manage:trigger {kind, packetRequest: {runId, detail}, pauses}` and, when pausing, holds the pending delivery until a decision arrives or `MANAGE_DECISION_TIMEOUT_MS` (120 000) elapses, then logs `manage:defaulted` and proceeds. Trigger kinds and thresholds per §4: `oracle_failed_repeatedly` (N = `CONFIG.manage?.failThreshold ?? 2`), `budget_threshold` (fraction `CONFIG.manage?.budgetFraction ?? 0.75` of any cap, once), `run_ended_without_acceptance`, `milestone_candidate` (oracle pass = total), `escalation` (mail kind `escalate`). All gated on `CONFIG.manage?.enabled === true` (pass `manage` through `lib/config.mjs` like `jev`); absent → byte-identical behaviour.

- [ ] **Step 1: Failing tests for `validateInstruction`** — a fixture task (version 4) and packet (`packetId 7`, `options.verbsAllowed` without `accept`, `budgetLeft.runs 1`), then: a well-formed `continue` passes; `basedOnStateVersion: 3` → `stale_version`; a key already in the ledger → `duplicate_key`; `accept` → `verb_not_allowed`; `restore` with `runs` budget 0 → `budget`; `correct` with a 3 000-char message → `precondition`; `continue` naming a run not in `current.activeRuns` → `precondition`; `rationale` over 500 chars → `precondition`; any instruction whose args mention `acceptance` → `precondition` ("criteria are immutable").
- [ ] **Step 2: Implement `lib/manage/instructions.mjs`** — `INSTRUCTION_VERBS = ["continue","correct","restore","compare","accept","escalate"]`, per-verb `ARGS` schema (required keys and limits from §3's table), `validateInstruction` in the order: shape → version → key → verb allowed → budget → per-verb preconditions. `executeInstruction`: validate; `appendLedger` with `verified: true` **before** acting; then per verb: `continue` → `spendBudget` by the grant and `controlAppend(runDir, { type: "grant", … })`; `correct` → `controlAppend({ type: "correct", message })`; `escalate` → `saveTask` with `status: "paused"` and a `blockers` entry; a refusal is also a ledger row (`verified: false, refused: code`). Every verb also appends `{ type: "decision", packetId, verb }` to the control file so a paused supervisor can release.
- [ ] **Step 3: Failing tests for `decideTrigger`** — pure over `{ oracleFails, failThreshold, capsUsedFraction, budgetThresholdFired, runEnded: { reason, accepted }, oraclePassed, escalateMail }` returning the first matching kind in §4's order with `pauses` true for `oracle_failed_repeatedly` and `escalation` only.
- [ ] **Step 4: Implement `lib/manage/triggers.mjs`** (pure, ~40 lines).
- [ ] **Step 5: Routing + messages + mail-ext** — `routeMail`: `kind === "escalate"` from the verifier → `{ action: "escalate" }`; test in `test/routing.test.mjs`. `M.manage.correction(msg)` = `[SUPERVISOR] From the manager: ${msg}`; pinned in `test/messages.test.mjs`. `ext/mail-ext.ts`: one clause in the orchestrator-pattern kind description: `kind="escalate" asks the manager for a decision you cannot make (a criterion looks wrong, you are blocked, you need budget); say what you need.`
- [ ] **Step 6: Supervisor wiring** — in `supervisor.mjs`: (a) `const MANAGE = CONFIG.manage?.enabled === true ? { failThreshold, budgetFraction, timeoutMs, taskDir } : null` next to `JEV`; (b) a `controlTail = new JsonlTailer(path.join(RUN, "control.jsonl"))` polled in the existing tick loop, dispatching grant/correct/decision; (c) `manageTrigger(kind, detail, pauses)` writing `lifecycle` `manage:trigger` and `audit` `type: "manage"`, and when `pauses` storing `{ kind, deliverFn, deadline }` in `managePause`; the two pause sites: the failed-verdict delivery in `runOracle` (wrap the `deliver(…failedBuilder…)` call: if `MANAGE` and `decideTrigger` says `oracle_failed_repeatedly`, defer the deliver into `managePause`), and the `escalate` mail route; (d) the tick loop releases `managePause` on a `decision` entry or at `deadline` with `manage:defaulted`; (e) `budget_threshold` from the existing cap counters, once. Source assertions in `test/supervisor-guards.test.mjs`: the `MANAGE` block; `if (!MANAGE) ` guards on every manage site; the pause wrapping the failed-verdict deliver; the deadline default `120_000`; the control tailer poll. Config pass-through test in `test/config.test.mjs` for `manage`.
- [ ] **Step 7: `tools/manage.mjs execute <taskDir> <instruction.json> [--runs dir]`** prints the ledger row or the refusal (exit 3 on refusal).
- [ ] **Step 8: Full suite; commit** `feat(manage): instruction contract with version and idempotency checks; control channel; triggers with pause and timeout`.
- [ ] **Step 9 (controller, server up): live check** — run pathnorm with `manage: { enabled: true, failThreshold: 1, taskDir }` on the failing-prone config; confirm `manage:trigger` fires on the first failed verdict, the delivery waits, `tools/manage.mjs execute` with a `correct` releases it with the message delivered, and a second run with no executor defaults after 120 s with `manage:defaulted`. Record both in `docs/batch/manage-1.md`.

---

### Task 3: `restore` and `compare` over the fork runner; findings from comparisons (build order 3)

**Files:**
- Create: `lib/manage/compare.mjs`
- Modify: `lib/manage/instructions.mjs` (the two verbs), `tools/manage.mjs` (`compare-ready <taskDir> <batchDir>`), `tools/fork.mjs` (export `runBatch(spec)` so the executor does not shell out per replicate; keep the CLI)
- Test: `test/manage-compare.test.mjs`, `test/manage-instructions.test.mjs` (+ restore/compare cases), `test/fork-runner.test.mjs` (+ `runBatch` plan shape)

**Interfaces:**
- `restore` args `{ checkpoint, approach: { config?, firstAction?, message? } }`: a checkpoint is either `ck-NNNN` (Task 4) or `run:<runId>#<call>` (a captured inference). For `run:` checkpoints the executor builds a fork spec `{ run, call, branch: firstAction ? "A-natural" : "G", action: firstAction, replicates: 1 }` and, when `message` is given, writes `runs/<newId>/control.jsonl` `{ type: "correct" }` before the fork's continue (the fork runner accepts `--control <file>` and copies it in). Spends `runs: 1`, `forkReplicates: 1`. Adds the new run to `current.activeRuns`.
- `compare` args `{ checkpoint, branches: [{ label, firstAction?, message? }], replicates }`: one `runBatch` per branch; spends `forkReplicates: branches × replicates`; writes `tasks-live/<id>/compares/<n>/` with the per-branch reports; then `assemblePacket` with trigger `comparison_ready` and `detail: { compareId, table }`.
- `findingsFromCompare({ compareId, branches, rows })` (pure) → candidate findings: one per pair (G vs each A) with the claim template `"At <checkpoint shape>, forcing <action> vs continuing: first-try oracle <a/n> vs <g/n>, mean wall <x> vs <y>"` and `settlement_criterion: "same direction on a second run of the same shape"`; `evidence` = the report paths.

- [ ] **Step 1: Failing tests** — `findingsFromCompare` on a synthetic table (two branches × 3 rows) yields one finding with the numbers in the claim; `validateInstruction` for `compare` with 1 branch → `precondition`, with `replicates 1` → `precondition`, with budget short → `budget`; `restore` with a `run:` checkpoint whose request file is missing → `precondition`.
- [ ] **Step 2: Export `runBatch` from `tools/fork.mjs`** (refactor `main` so the loop body is `runBatch({ runId, call, branch, action, replicates, config, nullMode, control })` returning `{ rows, report, logDir }`; `main` parses args and calls it). Pin with a test that `runBatch` is exported and `planForks` is called with the same spec `main` built before (existing tests continue to pass).
- [ ] **Step 3: Implement `lib/manage/compare.mjs`** and the two verbs in `instructions.mjs`; `tools/manage.mjs compare-ready` assembles the packet from a finished batch (so a compare can also be driven by hand).
- [ ] **Step 4: Full suite; commit** `feat(manage): restore and compare over the fork runner; candidate findings from comparisons`.
- [ ] **Step 5 (controller, server up): live check** — replay cycle 1's call-4 compare through `execute`: two branches × 2 replicates; confirm `compares/1/`, the `comparison_ready` packet, and a candidate finding whose numbers match the batch report.

---

### Task 4: Checkpoints and evidence-tied acceptance (build order 4)

**Files:**
- Create: `lib/manage/checkpoint.mjs`, `lib/manage/evidence.mjs`
- Modify: `lib/manage/instructions.mjs` (`accept`), `supervisor.mjs` (write a checkpoint candidate at `finish()` when `MANAGE`: `tasks-live/<id>/checkpoints/cand-<runId>/` = the final workspace minus `.pi`, with `manifest.json { runId, treeHash, oracle }`), `tools/manage.mjs` (`accept`, `checkpoint`)
- Test: `test/manage-checkpoint.test.mjs`, `test/manage-evidence.test.mjs`, `test/manage-instructions.test.mjs` (+ accept), `test/supervisor-guards.test.mjs` (+ the finish-time candidate)

**Interfaces:**
- `snapshotCheckpoint({ taskDir, fromDir, runId, oracle }) → { id: "ck-NNNN", dir, treeHash }` (copies with `fs.cpSync` filter `.pi`, writes `manifest.json`); `promoteCandidate(taskDir, "cand-<runId>") → ck id`.
- `checkEvidence(criterion, { taskDir, checkpoint, runsDir, evidence }) → { ok, reason, artefacts }` per kind (§6): `oracle:<dir>` — a run in `evidence` whose `summary.task` oracle dir matches, whose last oracle has `pass === total`, and whose final workspace tree hash equals the checkpoint's; `playthrough:<script>` — `spawnSync(process.execPath, [script, checkpointDir])`, exit 0, stdout captured to `checkpoints/<ck>/evidence/<criterion>.log`; `artifact:<path>[:<validator>]` — file exists under the checkpoint and the validator (`exists` | `nonempty` | `json` | `grep=<regex>`) passes; `review:human` — a ledger row `{ kind: "review", criterion, checkpoint, by: "<name>", signed: true }` exists.
- `accept` args `{ milestone, checkpoint, evidence: [runIds…] }`: every criterion of the milestone must pass `checkEvidence`; then `milestones[i].status = "accepted"`, `acceptedCheckpoint`, `acceptedAt`, `evidence`; `current.milestone` advances to the next `pending` (→ `active`), `current.checkpoint = checkpoint`; a refusal names the failing criterion and kind.

- [ ] **Step 1: Failing tests** — a temp checkpoint with `src/x.mjs`; `oracle:` passes only when the tree hash matches the run's final workspace; a mismatched hash → `reason` names it; `artifact:docs/a.md:nonempty` fails on an empty file; `review:human` requires the signed ledger row; `accept` with one failing criterion refuses and changes nothing; with all passing it advances `current.milestone` and bumps the version.
- [ ] **Step 2: Implement** `checkpoint.mjs`, `evidence.mjs`, the `accept` verb, the CLI subcommands, the supervisor's finish-time candidate (source assertion: inside `finish()`, gated on `MANAGE`, after `summary.json` is written).
- [ ] **Step 3: Full suite; commit** `feat(manage): checkpoints and evidence-tied acceptance (oracle, playthrough, artifact, human review)`.

---

### Task 5: The manager driver and the packet replay harness (build order 5)

**Files:**
- Create: `lib/manage/manager.mjs`, `tools/manage.mjs` (`decide`, `replay`), `docs/batch/manage-1.md` (live results from Tasks 2–5's checks)
- Test: `test/manage-manager.test.mjs`

**Interfaces:**
- `decide({ packet, model = "claude-opus-5", fetchImpl }) → instruction`: one Messages API call with a single tool `instruct` whose input schema is the §3 instruction (the six verbs as an enum, args per verb as `oneOf`), `tool_choice: { type: "tool", name: "instruct" }`, `max_tokens 1024`, the packet as the user message under a fixed system prompt (`docs/manage/manager-system.md`, created here: the four roles, the six verbs, "you cannot change acceptance criteria; escalate", "prefer the cheapest verb the evidence supports; `continue` is not free"). The key comes from `ANTHROPIC_API_KEY` or `.env`; never logged. The returned instruction gets `packetId`, `basedOnStateVersion` and `idempotencyKey = p<packetId>-v<version>` filled by the driver, never by the model. Timeout `MANAGE_DECISION_TIMEOUT_MS` → `{ verb: "continue", args: { runId, milestone, budgetGrant: { wallSec: 0, toolCalls: 0 } }, defaulted: true }`.
- `replay({ taskDir, packetIds, model, fetchImpl }) → rows`: for each recorded packet, call `decide` and compare the verb (and for `correct`/`restore`, the target) with the ledger's executed instruction and its recorded outcome; print agreement per trigger kind and a confusion table of verbs; write `tasks-live/<id>/replays/<model>-<ts>.jsonl`.
- `tools/manage.mjs decide <taskDir> <packetId> [--model m] [--execute]` and `replay <taskDir> --model m [--packets 1,2,3]`.

- [ ] **Step 1: Failing tests** with a fake `fetchImpl`: `decide` sends the packet, forces the tool, fills `packetId/basedOnStateVersion/idempotencyKey` from the packet, rejects a model answer with an unknown verb, and defaults to a zero-grant `continue` on timeout (fake fetch that never resolves + a 50 ms timeout); `replay` scores two packets against a two-row ledger (one agree, one disagree) and prints `agreement 1/2`.
- [ ] **Step 2: Implement** `manager.mjs`, the system prompt file, the CLI subcommands. Load the `claude-api` skill before writing the request body to confirm the current tool-use request shape and the model id for the most capable model.
- [ ] **Step 3: Full suite; commit** `feat(manage): manager driver over the Messages API with a forced instruct tool; packet replay harness`.
- [ ] **Step 4 (controller, server up): first live manager** — one pathnorm task with `manage.enabled`, the driver invoked by a small loop `tools/manage.mjs serve <taskDir>` (added here: watches `lifecycle.jsonl` of active runs for `manage:trigger`, assembles, decides, executes) on a config that fails at least once; record every packet and instruction; then `replay` the same packets with `claude-sonnet-5` and `claude-haiku-4-5-20251001` and write the agreement table into `docs/batch/manage-1.md` (§7).

---

## Self-review

- **Spec coverage.** §1 task state → Task 1; §2 packets → Task 1; §3 instructions (six verbs, version, idempotency, immutability, verbsAllowed pruning) → Tasks 1–4; §4 triggers, pause, timeout, default `continue` → Task 2; §5 ledger and findings, settlement → Tasks 1 and 3 (settlement across runs is `settleFinding`, invoked by `compare-ready` when a finding of the same shape exists — implementer note in Task 3); §6 acceptance kinds → Task 4; §7 manager selection by replay → Task 5; §8 experimentation as a capability → Task 3; non-goals respected (single task, no manager edits to prompts or code, nothing between triggers). Isolation: no module gives the manager a path into the workspace or oracle; the executor only writes the control file, the ledger and task state.
- **Placeholders.** None: every code step names files, functions and assertions; Tasks 3–5 give interfaces and test cases rather than full listings because they compose Task 1–2 code, and each names the exact assertions to write.
- **Type consistency.** `stateVersion`, `packetId`, `idempotencyKey = p<packetId>-v<version>`, `verbsAllowed`, `budgetLeft` keys (`wallSec, runs, forkReplicates, usd`) and the trigger kinds are spelled the same in every task and match the spec. `runBatch` (Task 3) is the fork runner's `main` loop with the same `planForks` spec. `treeHash` is the one function for capture, checkpoints and oracle evidence.
