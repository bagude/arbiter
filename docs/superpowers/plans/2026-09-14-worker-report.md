# Worker Report Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give workers a schema-checked `report` tool, refuse `done` while a completed worker has no report, optionally run a report's verify cases as a supervisor probe, and file report findings into memory as worker candidates.

**Architecture:** `ext/report-ext.ts` mirrors `ext/checkpoint-ext.ts` (TypeBox schema validated by pi, entry appended to `runs/<id>/reports.jsonl`, `worker:report` on the lifecycle file). The reducer in `lib/workers.mjs` tallies reports and answers "which completed workers have no report since their last start"; `lib/gate.mjs` gains that list as an input; the supervisor wires the env, the tool allowlist, the gate call, the opt-in auto-probe and the summary. Everything decides in `lib/`, tested; `supervisor.mjs` only wires.

**Tech Stack:** Node 26 (`node:test`), TypeScript pi extension loaded through tsx, `@gotgenes/pi-subagents` worker definitions, existing guard-kit (`roleFor`, `emit`).

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-borrowings-design.md` §3

## Global Constraints

- Work in `C:\Users\user\open_harnessess\pi\arbiter` on `master`. Never touch `C:\Users\user\open_harnessess\pi\pi` (the pi checkout).
- Precondition: `git status --short` must be clean before Task 1. The pre-spawn-compact work from 2026-09-14 is uncommitted at the time of writing; the user commits it first. If it is still there, stop and ask.
- Commit with `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"`; never write git config.
- Run tests with `npm test` (= `node --test "test/**/*.test.mjs"`) from the arbiter directory. All existing tests keep passing; the suite is 218 today.
- Bash heredocs on this Windows Git Bash mangle backslashes; write files that contain a backslash with the Write/Edit tools, not heredocs.
- The extension test pattern is `test/pre-spawn-compact-ext.test.mjs`: drive the `.ts` file through `C:/Users/user/open_harnessess/pi/pi/node_modules/tsx/dist/cli.mjs` with `NODE_PATH` pointing at pi's `node_modules`.
- `report` goes on the worker's `tools:` line only. `ORCHESTRATOR_TOOLS` in `lib/patterns.mjs` must not change.
- The feature is off unless the run config says `report: true` or `report: { autoProbe: true }`. With it off, nothing registers, the gate input is `[]`, and no summary field changes except `summary.reports.enabled: false`.
- Live runs need the local llama router up (`qwen-flash/serve.ps1` with `PRESET=router`, port 8080). Never print the key file `.llama-api-key`.
- While a batch runs, do not edit `supervisor.mjs`, `lib/` or `ext/` (runs must share code).

---

## File map

| File | Responsibility |
|---|---|
| `lib/config.mjs` (modify) | parse `report` (`null` \| `{ autoProbe }`) |
| `ext/report-ext.ts` (new) | the `report` tool: schema, append entry, emit `worker:report` |
| `lib/workers.mjs` (modify) | `tracker.reports`, `lastStartedTs` per worker, reducer branch, `reportsFor`, `unreportedWorkers` |
| `lib/gate.mjs` (modify) | `unreported` input, reason `unreported` |
| `lib/messages.mjs` (modify) | `gate.unreported(ids)`, `probe.autoResults(n, wid, parts)` |
| `lib/memory.mjs` (modify) | `retainFromRun({ reports })` → worker candidate records |
| `lib/compaction.mjs` (modify) | `ledgerLines({ reports })` line |
| `lib/worker-def.mjs` (modify) | `REPORT_INSTRUCTION`, `resolveWorkerPrompt({ report })` |
| `supervisor.mjs` (modify) | GUARDS entry, `REPORT_FILE`, env, worker tools, gate call, auto-probe, `runProbe` auto option, ledger inputs, `summary.reports`, retention input |
| `configs/orch-orbit-27b-report.json`, `configs/orch-orbit-27b-report-autoprobe.json` (new) | the paired treatments |
| `test/config.test.mjs`, `test/gate.test.mjs`, `test/messages.test.mjs`, `test/memory.test.mjs`, `test/compaction.test.mjs`, `test/worker-def.test.mjs` (modify); `test/report-ext.test.mjs`, `test/workers-reports.test.mjs` (new) | tests |
| `docs/batch/worker-report.md` (new), `docs/backlog.md` (modify) | the measurement and the backlog note |

---

### Task 1: Config key `report`

**Files:**
- Modify: `lib/config.mjs` (the block before `if (!task)`, and the returned object)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `CONFIG.report` is `null` or `{ autoProbe: boolean }`.

- [ ] **Step 1: Write the failing test** — append to `test/config.test.mjs`:

```js
test("report: off by default, `true` means the tool with no auto-probe, an object sets autoProbe, junk is rejected", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } };
	const base = { task: "orbit", pattern: "orchestrator", roles };
	assert.equal(loadConfig({ configPath: tmpConfig(base), env: {} }).report, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, report: true }), env: {} }).report, { autoProbe: false });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, report: { autoProbe: true } }), env: {} }).report, { autoProbe: true });
	assert.equal(loadConfig({ configPath: tmpConfig({ ...base, report: false }), env: {} }).report, null);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ ...base, report: "yes" }), env: {} }), /report must be true, false or \{ autoProbe \}/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: the new test fails (`report` is `undefined`, not `null`).

- [ ] **Step 3: Implement** — in `lib/config.mjs`, directly above `if (!task) throw new Error(...)`, add:

```js
	// Worker reports (ext/report-ext.ts). Off by default so paired runs stay comparable.
	// `true`: workers get the `report` tool and the approval gate refuses `done` while a
	// completed worker has no report. `{ autoProbe: true }`: additionally, each report's
	// verify cases are run as a supervisor probe the moment the report lands.
	let report = null;
	if (raw.report === true) report = { autoProbe: false };
	else if (raw.report && typeof raw.report === "object" && !Array.isArray(raw.report)) report = { autoProbe: Boolean(raw.report.autoProbe ?? false) };
	else if (raw.report != null && raw.report !== false) throw new Error(`report must be true, false or { autoProbe } in ${configPath}`);
```

and change the return line to `return { task, pattern, roles, caps, oracle, guards, memory, memoryDir, repo, report, configPath };`.

- [ ] **Step 4: Run the tests**

Run: `node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs test/config.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "config: report key (worker report tool, optional auto-probe)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 2: The `report` tool

**Files:**
- Create: `ext/report-ext.ts`
- Test: `test/report-ext.test.mjs`

**Interfaces:**
- Consumes: `ext/guard-kit.ts` `roleFor(ctx)` (returns `worker:<transcript basename>` inside a worker) and `emit(ev, ctx, data)`.
- Produces: one line per call in `ARBITER_REPORT_FILE`: `{ ts, role, status, summary, changed, findings, verify, open_questions }`; one lifecycle line `{ ev: "worker:report", data: { role, status, findings, verify, changed, chars, verifyCases } }` where `verifyCases` is the `verify` array verbatim.

- [ ] **Step 1: Write the failing test** — create `test/report-ext.test.mjs` (use the Write tool; the file has backslashes in a regex):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/report-ext.ts through tsx with a fake `pi` that captures registerTool,
// then calls the tool's execute() the way a worker session would. Registers nothing
// unless ARBITER_REPORT_FILE is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run({ calls, on = false }) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-ext-"));
	const lifecycle = path.join(tmp, "lifecycle.jsonl");
	const reports = path.join(tmp, "reports.jsonl");
	const driver = path.join(tmp, "driver.mjs");
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/report-ext.ts"))}).href);
		const tools = {};
		mod.default({ registerTool: (t) => { tools[t.name] = t; }, on() {}, events: { on() {} } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => "C:/sessions/orchestrator/tasks/abc123.jsonl" } };
		const out = [];
		for (const params of ${JSON.stringify(calls)}) out.push(tools.report ? await tools.report.execute("t1", params, undefined, undefined, ctx) : "not-registered");
		console.log(JSON.stringify({ registered: Object.keys(tools), schema: tools.report?.parameters ?? null, out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, ARBITER_HOME: path.resolve("."), NODE_PATH: `${PI}/node_modules`, ARBITER_REPORT_FILE: on ? reports : "" },
	});
	assert.equal(r.status, 0, r.stderr);
	const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	return { ...JSON.parse(r.stdout.trim()), lines: read(lifecycle), entries: read(reports) };
}

const REPORT = {
	status: "done",
	summary: "implemented stage 1",
	changed: ["src/orbit.mjs"],
	findings: [{ claim: "observed", text: "node --test passes 4/4", evidence_refs: ["src/orbit.test.mjs"] }],
	verify: [{ id: "c1", args: [1, 2], expect: 3 }],
	open_questions: [],
};

test("not registered when ARBITER_REPORT_FILE is unset", () => {
	const { registered, out } = run({ calls: [REPORT] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, ["not-registered"]);
});

test("schema: the required keys, the claim union and the probe-shaped verify case", () => {
	const { schema } = run({ calls: [], on: true });
	assert.deepEqual(schema.required, ["status", "summary", "changed", "findings", "verify", "open_questions"]);
	assert.deepEqual(schema.properties.status.anyOf.map((s) => s.const), ["done", "partial", "blocked"]);
	assert.deepEqual(schema.properties.findings.items.properties.claim.anyOf.map((s) => s.const), ["observed", "interpreted", "hypothesis"]);
	assert.deepEqual(schema.properties.findings.items.required, ["claim", "text"]);
	assert.equal(schema.properties.findings.items.properties.settlement_criterion.maxLength, 400);
	assert.deepEqual(schema.properties.verify.items.required, ["id", "args"]);
	assert.equal(schema.properties.verify.maxItems, 12);
	assert.equal(schema.properties.summary.maxLength, 600);
});

test("execute appends the entry under the worker's session name and emits worker:report with the verify cases", () => {
	const { out, lines, entries } = run({ calls: [REPORT], on: true });
	assert.equal(out[0].isError, false);
	assert.match(out[0].content[0].text, /report recorded \(done; 1 findings, 1 verify cases\)/);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].role, "worker:abc123");
	assert.equal(entries[0].status, "done");
	assert.deepEqual(entries[0].verify, REPORT.verify);
	assert.deepEqual(entries[0].findings, REPORT.findings);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "worker:report");
	assert.equal(lines[0].data.role, "worker:abc123");
	assert.equal(lines[0].data.status, "done");
	assert.equal(lines[0].data.findings, 1);
	assert.equal(lines[0].data.verify, 1);
	assert.deepEqual(lines[0].data.verifyCases, REPORT.verify);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/report-ext.test.mjs`
Expected: FAIL — the driver cannot import `ext/report-ext.ts` (does not exist).

- [ ] **Step 3: Implement** — create `ext/report-ext.ts` (Write tool):

```ts
/**
 * report-ext — the worker's `report` tool: a schema-checked account of what the worker
 * did (status, changed files, findings by claim, probe-shaped verify cases, open
 * questions). Each call appends one entry to ARBITER_REPORT_FILE and emits
 * `worker:report` to the lifecycle file. The supervisor tallies it, the approval gate
 * refuses `done` while a completed worker has none, retention files the findings as
 * worker candidates, and with report.autoProbe the verify cases run as a probe at once.
 * Registers nothing when the file is unset. Only the worker definition's `tools:` line
 * names `report`, so the orchestrator never sees it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);

const FILE = process.env.ARBITER_REPORT_FILE ?? "";

export default function (pi: ExtensionAPI) {
	if (!FILE) return;
	pi.registerTool({
		name: "report",
		description:
			"Record your report before you finish: status, a short summary, the files you changed, findings labelled observed (you ran it and saw it), interpreted (your reading) or hypothesis (not tested), verify cases as [{ id, args, expect? }] the supervisor can execute against the real code, and open questions. Call it once at the end of your work; the run cannot complete until every worker has reported.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("blocked")]),
			summary: Type.String({ minLength: 1, maxLength: 600 }),
			changed: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 30 }),
			findings: Type.Array(
				Type.Object({
					claim: Type.Union([Type.Literal("observed"), Type.Literal("interpreted"), Type.Literal("hypothesis")]),
					text: Type.String({ minLength: 1, maxLength: 600 }),
					evidence_refs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12 })),
					// The ledger's rule (lib/claims.mjs NEEDS_CRITERION): an interpretation or a
					// hypothesis names what would settle it, or retention files it as unreviewed.
					settlement_criterion: Type.Optional(Type.String({ maxLength: 400 })),
				}),
				{ maxItems: 20 },
			),
			verify: Type.Array(
				Type.Object({
					id: Type.String({ minLength: 1, maxLength: 40 }),
					args: Type.Array(Type.Unknown(), { maxItems: 12 }),
					expect: Type.Optional(Type.Unknown()),
				}),
				{ maxItems: 12 },
			),
			open_questions: Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const role = kit.roleFor(ctx);
			const entry = { ts: Date.now(), role, ...params };
			fs.mkdirSync(path.dirname(FILE), { recursive: true });
			fs.appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
			kit.emit("worker:report", ctx, {
				status: params.status,
				findings: params.findings.length,
				verify: params.verify.length,
				changed: params.changed.length,
				chars: JSON.stringify(entry).length,
				verifyCases: params.verify,
			});
			return {
				content: [{ type: "text", text: `report recorded (${params.status}; ${params.findings.length} findings, ${params.verify.length} verify cases). Finish your turn with a short message; the orchestrator sees both.` }],
				details: {},
				isError: false,
			};
		},
	});
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/report-ext.test.mjs`
Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add ext/report-ext.ts test/report-ext.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "ext: worker report tool (schema-checked; entry file + worker:report lifecycle event)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 3: Reducer — tally reports, know who has not reported

> **Superseded during execution (2026-09-14):** the `lastStartedTs` / `report.ts >= lastStartedTs` ordering below was replaced in the task's fix round by a per-tracker sequence (`tracker.seq`, assigned once per event in `applyLifecycleEvent`; `lastStartedSeq` on the worker; `r.seq > lastStartedSeq`), because pump-time stamps can tie within one poll batch on Windows. The tests gained a same-`now` case. Read the code, not this text, for the ordering rule.

**Files:**
- Modify: `lib/workers.mjs` (`createTracker`, the `subagents:created`/`started`/`resuming` cases, a new branch before the `memory:` match, two new exports)
- Test: `test/workers-reports.test.mjs`

**Interfaces:**
- Consumes: `worker:report` lifecycle lines from Task 2.
- Produces: `tracker.reports: [{ reported, role, status, findings, verify, changed, chars, verifyCases, ts }]`; per worker state `lastStartedTs`; `reportsFor(tracker, wid)`; `unreportedWorkers(tracker, state) → string[]` (worker ids).

- [ ] **Step 1: Write the failing test** — create `test/workers-reports.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker, applyLifecycleEvent, bindTranscript, reportsFor, unreportedWorkers } from "../lib/workers.mjs";

// Synthetic lifecycle sequences: the pump time `now` increases by one per event, exactly
// as supervisor.mjs pumpLifecycle() feeds the reducer.
const started = (id) => ({ ev: "subagents:started", data: { id, description: `work ${id}` } });
const completed = (id) => ({ ev: "subagents:completed", data: { id, status: "completed", result: `done ${id}` } });
const failed = (id) => ({ ev: "subagents:failed", data: { id, error: "boom" } });
const resuming = (id) => ({ ev: "subagents:resuming", data: { id, description: `again ${id}` } });
const resumed = (id) => ({ ev: "subagents:resumed", data: { id, status: "completed", result: `done again ${id}` } });
const report = (session, status = "done") => ({ ev: "worker:report", data: { role: `worker:${session}`, status, findings: 2, verify: 1, changed: 1, chars: 300, verifyCases: [{ id: "c1", args: [1] }] } });

function harness() {
	const state = {};
	const timeline = [];
	const tracker = createTracker();
	let now = 1000;
	const audit = [];
	const feed = (...events) => {
		for (const { ev, data } of events) {
			now += 1;
			audit.push(...applyLifecycleEvent(tracker, state, timeline, { ev, data, now }).audit);
		}
	};
	const bind = (session) => bindTranscript(tracker, state, `C:/sessions/orchestrator/tasks/${session}.jsonl`);
	return { state, tracker, audit, feed, bind };
}

test("a report resolves to the bound worker, is tallied, and satisfies the gate input", () => {
	const h = harness();
	h.feed(started("a"));
	assert.equal(h.bind("sess-a"), "worker:a");
	h.feed(report("sess-a"), completed("a"));
	assert.equal(h.tracker.reports.length, 1);
	assert.equal(h.tracker.reports[0].role, "worker:a");
	assert.equal(h.tracker.reports[0].status, "done");
	assert.deepEqual(h.tracker.reports[0].verifyCases, [{ id: "c1", args: [1] }]);
	assert.deepEqual(reportsFor(h.tracker, "worker:a").map((r) => r.status), ["done"]);
	assert.deepEqual(h.audit.filter((a) => a.type === "worker_report").map((a) => a.msg), ["report: done; 2 findings, 1 verify cases, 1 files"]);
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
});

test("a completed worker without a report is unreported; a failed one is exempt; a running one is not counted", () => {
	const h = harness();
	h.feed(started("a"), completed("a"), started("b"), failed("b"), started("c"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
});

test("a resumed worker needs a report after the resume", () => {
	const h = harness();
	h.feed(started("a"));
	h.bind("sess-a");
	h.feed(report("sess-a"), completed("a"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
	h.feed(resuming("a"), resumed("a"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
	h.feed(report("sess-a", "partial"));
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
	assert.equal(reportsFor(h.tracker, "worker:a").length, 2);
});

test("a report that arrives before its transcript is bound resolves at query time", () => {
	const h = harness();
	h.feed(started("a"), report("sess-a"), completed("a"));
	assert.equal(h.tracker.reports[0].role, "worker:sess-a", "unresolved at arrival");
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), ["worker:a"]);
	h.bind("sess-a");
	assert.deepEqual(unreportedWorkers(h.tracker, h.state), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/workers-reports.test.mjs`
Expected: FAIL — `reportsFor`/`unreportedWorkers` are not exported.

- [ ] **Step 3: Implement** — in `lib/workers.mjs`:

(a) In `createTracker()`, after the `checkpoints: [],` line add:

```js
		reports: [], // worker reports (ext/report-ext.ts): { reported, role, status, findings, verify, changed, chars, verifyCases, ts }
```

(b) In `applyLifecycleEvent`, directly above the line `const memoryMatch = /^memory:(search|get|refused)$/.exec(ev);` add:

```js
	// A worker's report (ext/report-ext.ts). `reported` is the name the extension knew
	// (worker:<transcript basename>); `role` is the lifecycle id when the transcript is
	// already bound, else the same name — reportsFor() re-resolves it at query time.
	if (ev === "worker:report") {
		const { role: reported = "unknown", status = "?", findings = 0, verify = 0, changed = 0, chars = 0, verifyCases = [] } = data ?? {};
		const role = workerIdForTranscriptName(tracker, String(reported));
		tracker.reports.push({ reported: String(reported), role, status, findings, verify, changed, chars, verifyCases: Array.isArray(verifyCases) ? verifyCases : [], ts: now });
		audit.push({ agent: String(role), type: "worker_report", msg: `report: ${status}; ${findings} findings, ${verify} verify cases, ${changed} files` });
		return { audit, decision: null };
	}
```

(c) In the `switch (ev)`: in `case "subagents:created"` change `ensureWorker(state, wid);` to `ensureWorker(state, wid).lastStartedTs = now;`; in `case "subagents:started"` change `ensureWorker(state, wid).status = "running";` to

```js
			const w = ensureWorker(state, wid);
			w.status = "running";
			w.lastStartedTs = now;
```

and in `case "subagents:resuming"` change `ensureWorker(state, wid).status = "running";` to the same three lines. (Declaring `const w` twice in one `switch` needs braces: `case "subagents:started": { ... break; }` already has them; wrap the `resuming` case body in braces the same way.)

(d) After `applyLifecycleEvent` (before `bindTranscript`), add:

```js
/**
 * Reports filed by one worker, by lifecycle id. A report that arrived before the
 * worker's transcript was bound is re-resolved here, not at arrival.
 */
export function reportsFor(tracker, wid) {
	return tracker.reports.filter((r) => r.role === wid || workerIdForTranscriptName(tracker, r.reported) === wid);
}

/**
 * Completed workers whose latest report predates their latest start or resume — the
 * approval gate's `unreported` input. Failed workers are exempt (nothing to resume);
 * running ones are not counted (they may still report).
 */
export function unreportedWorkers(tracker, state) {
	return Object.values(state)
		.filter((s) => s.role === "worker" && s.status === "completed")
		.filter((s) => !reportsFor(tracker, s.name).some((r) => r.ts >= (s.lastStartedTs ?? 0)))
		.map((s) => s.name);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/workers-reports.test.mjs test/workers.test.mjs test/workers-memory.test.mjs test/workers-handles.test.mjs`
Expected: all PASS (the fixture replays must be unchanged by the `lastStartedTs` additions).

- [ ] **Step 5: Commit**

```bash
git add lib/workers.mjs test/workers-reports.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "workers: tally worker:report; unreportedWorkers() for the gate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 4: Gate input and the two messages

**Files:**
- Modify: `lib/gate.mjs`, `lib/messages.mjs` (the `gate:` and `probe:` blocks)
- Test: `test/gate.test.mjs`, `test/messages.test.mjs`

**Interfaces:**
- Produces: `decideApproval({ ..., unreported = [] })` → `{ ok: false, reason: "unreported", sinceEditMs, unreported }`; `M.gate.unreported(ids)`; `M.probe.autoResults(n, wid, parts)`.

- [ ] **Step 1: Write the failing tests** — append to `test/gate.test.mjs`:

```js
test("rejects when a completed worker has no report — after no_probe and no_src, before stale", () => {
	const r = decideApproval({ ...base, unreported: ["worker:a"] });
	assert.equal(r.reason, "unreported");
	assert.deepEqual(r.unreported, ["worker:a"]);
	assert.equal(decideApproval({ ...base, lastProbeHash: null, unreported: ["worker:a"] }).reason, "no_probe");
	assert.equal(decideApproval({ ...base, srcExists: false, unreported: ["worker:a"] }).reason, "no_src");
	assert.equal(decideApproval({ ...base, currentHash: "h2", unreported: ["worker:a"] }).reason, "unreported");
	assert.equal(decideApproval({ ...base, lastEditTs: 50_000, unreported: [] }).ok, true);
	assert.equal(decideApproval({ ...base, lastEditTs: 50_000 }).ok, true, "default is an empty list");
});
```

and append to `test/messages.test.mjs`:

```js
test("gate: unreported names the workers and the fix; probe: autoResults names the worker whose cases ran", () => {
	assert.equal(
		orch.gate.unreported(["worker:a1", "worker:b2"]),
		'[SUPERVISOR] Approval not accepted: worker:a1, worker:b2 finished without calling `report`. Resume each one with `subagent` (resume: "<worker id>") and ask it to call `report` with what it did and how to verify it, then send done again.',
	);
	assert.equal(
		orch.probe.autoResults(3, "worker:a1", ["1/1 matched the worker's stated expectations."]),
		"[SUPERVISOR] Probe run #3 — worker:a1's own verify cases from its report, executed by the supervisor against the current src/, not self-reported. They check only what the worker chose to check; probe anything else you need before done.\n1/1 matched the worker's stated expectations.",
	);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/gate.test.mjs test/messages.test.mjs`
Expected: both new tests FAIL.

- [ ] **Step 3: Implement** — replace `decideApproval` in `lib/gate.mjs` with:

```js
export function decideApproval({ lastProbeHash, currentHash, srcExists, lastEditTs, now, quiescenceMs = QUIESCENCE_MS, unreported = [] }) {
	const sinceEditMs = now - (lastEditTs || 0);
	if (lastProbeHash === null || lastProbeHash === undefined) return { ok: false, reason: "no_probe", sinceEditMs };
	if (!srcExists) return { ok: false, reason: "no_src", sinceEditMs };
	// Orchestrator pattern with worker reports on: a completed worker that never called
	// `report` blocks approval. The worker can skip the tool; the run cannot finish
	// until it has not. Failed workers are never in this list (lib/workers.mjs).
	if (unreported.length) return { ok: false, reason: "unreported", sinceEditMs, unreported };
	if (currentHash !== lastProbeHash) return { ok: false, reason: "stale", sinceEditMs };
	if (sinceEditMs < quiescenceMs) return { ok: false, reason: "too_soon", sinceEditMs };
	return { ok: true, reason: null, sinceEditMs };
}
```

In `lib/messages.mjs`, inside the `gate: { ... }` object add after `too_soon`:

```js
			unreported: (ids) =>
				`[SUPERVISOR] Approval not accepted: ${ids.join(", ")} finished without calling \`report\`. Resume each one with \`subagent\` (resume: "<worker id>") and ask it to call \`report\` with what it did and how to verify it, then send done again.`,
```

and inside the `probe: { ... }` object add after `results`:

```js
			autoResults: (n, wid, parts) =>
				`[SUPERVISOR] Probe run #${n} — ${wid}'s own verify cases from its report, executed by the supervisor against the current src/, not self-reported. They check only what the worker chose to check; probe anything else you need before done.\n${parts.join("\n\n")}`,
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/gate.test.mjs test/messages.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/gate.mjs lib/messages.mjs test/gate.test.mjs test/messages.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "gate: refuse done while a completed worker has no report; messages for unreported and auto-probe results" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 5: Retention of report findings and the ledger line

**Files:**
- Modify: `lib/memory.mjs` (`retainFromRun`), `lib/compaction.mjs` (`ledgerLines`)
- Test: `test/memory.test.mjs`, `test/compaction.test.mjs`

**Interfaces:**
- Produces: `retainFromRun({ summary, timeline, deliverable, oracle, reports = [], ts })` adds one semantic record per report finding on a `SUCCESS` run (`source: "agent"`, `status: "candidate"`, confidence 0.4); `ledgerLines({ ..., reports = null })` adds a `Worker reports` line when `reports` is an array.

- [ ] **Step 1: Write the failing tests** — append to `test/memory.test.mjs` (it already imports `retainFromRun`; if not, add it to the import list):

```js
test("retainFromRun files worker report findings as agent candidates on a successful run only; a hypothesis or interpretation without a settlement criterion is unreviewed", () => {
	const summary = { runId: "r1", task: "orbit", reason: "SUCCESS: oracle passed", wallSec: 10, config: { pattern: "orchestrator", roles: {} }, mailByKind: {}, doneAttempts: 1 };
	const findings = [
		{ claim: "observed", text: "tests pass 4/4", evidence_refs: ["src/x.test.mjs"] },
		{ claim: "hypothesis", text: "edge case untested" },
		{ claim: "interpreted", text: "the slow path is the parser", settlement_criterion: "profile parse() on the 10k-line fixture" },
		{ claim: "nonsense", text: "" },
	];
	const reports = [{ ts: 1, role: "worker:a", status: "done", summary: "s", changed: [], verify: [], open_questions: [], findings }];
	const out = retainFromRun({ summary, timeline: [], reports, ts: 5 });
	// retainFromRun itself only ever writes supervisor records, so `agent` isolates the worker's.
	const worker = out.filter((r) => r.source === "agent");
	assert.equal(worker.length, 3, "the empty-text finding is dropped");
	assert.deepEqual(worker.map((r) => [r.kind, r.claim, r.status, r.confidence]), [["semantic", "observed", "candidate", 0.4], ["semantic", "unreviewed", "candidate", 0.4], ["semantic", "interpreted", "candidate", 0.4]]);
	assert.equal(worker[2].settlement_criterion, "profile parse() on the 10k-line fixture");
	assert.equal("settlement_criterion" in worker[1], false);
	assert.equal(worker[0].scope, "task:orbit");
	assert.equal(worker[0].summary, "tests pass 4/4");
	assert.match(worker[0].text, /^tests pass 4\/4 \(worker report, worker:a\)$/);
	assert.deepEqual(worker[0].evidence, ["run:r1", "worker:a", "src/x.test.mjs"]);
	assert.deepEqual(worker[1].evidence, ["run:r1", "worker:a"]);
	const failed = retainFromRun({ summary: { ...summary, reason: "CAP: wall 100s >= 100s" }, timeline: [], reports, ts: 5 });
	assert.equal(failed.filter((r) => r.source === "agent").length, 0);
});
```

and append to `test/compaction.test.mjs` (it imports `ledgerLines`; add it to the import if missing):

```js
test("ledgerLines lists worker reports only when the feature is on", () => {
	assert.ok(!ledgerLines({}).some((l) => l.startsWith("Worker reports")));
	assert.ok(ledgerLines({ reports: [] }).includes("Worker reports: none yet — a completed worker without one blocks done."));
	const [line] = ledgerLines({ reports: [{ role: "worker:a", status: "done", findings: 2, verify: 1 }] }).filter((l) => l.startsWith("Worker reports"));
	assert.equal(line, "Worker reports (tool `report`, schema-checked): worker:a done (2 findings, 1 verify cases)");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/memory.test.mjs test/compaction.test.mjs`
Expected: both new tests FAIL.

- [ ] **Step 3: Implement** — in `lib/memory.mjs`, change the signature to `export function retainFromRun({ summary, timeline, deliverable = null, oracle = null, reports = [], ts = Date.now() }) {` and, directly above `const spawns = timeline.filter(...)`, add:

```js
	// Worker reports (ext/report-ext.ts): the worker's own claims, kept as candidates
	// under its own label and the `agent` source that agents' memory mail already uses
	// (the worker id is in the evidence and the text). The oracle's evidence never
	// attaches here — it vouched for the tree, not for what a worker said about it. An
	// interpretation or hypothesis without a settlement criterion is unreviewed text:
	// the ledger's rule (NEEDS_CRITERION), not a lighter one for workers.
	if (String(summary.reason).startsWith("SUCCESS")) {
		for (const r of Array.isArray(reports) ? reports : []) {
			const who = String(r?.role ?? "worker");
			for (const f of Array.isArray(r?.findings) ? r.findings : []) {
				if (!f || typeof f.text !== "string" || !f.text.trim()) continue;
				const text = f.text.trim();
				const criterion = typeof f.settlement_criterion === "string" ? f.settlement_criterion.trim() : "";
				let claim = CLAIMS.includes(f.claim) ? f.claim : "unreviewed";
				if (NEEDS_CRITERION.has(claim) && !criterion) claim = "unreviewed";
				const refs = Array.isArray(f.evidence_refs) ? f.evidence_refs.map(String) : [];
				out.push(makeRecord({ scope, kind: "semantic", claim, ...(criterion ? { settlement_criterion: criterion } : {}), summary: text.slice(0, 160), text: `${text} (worker report, ${who})`, snapshot, evidence: [`run:${runId}`, who, ...refs], confidence: 0.4, source: "agent", status: "candidate", ts }));
			}
		}
	}
```

In `lib/compaction.mjs`, change the `ledgerLines` signature to `export function ledgerLines({ probes = [], memoryIds = [], workers = [], handles = [], oracle = null, time = "", reports = null } = {}) {` and, directly above `out.push(oracle ? ...)`, add:

```js
	if (Array.isArray(reports)) out.push(reports.length ? `Worker reports (tool \`report\`, schema-checked): ${reports.map((r) => `${r.role} ${r.status} (${r.findings} findings, ${r.verify} verify cases)`).join("; ")}` : "Worker reports: none yet — a completed worker without one blocks done.");
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/memory.test.mjs test/compaction.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/memory.mjs lib/compaction.mjs test/memory.test.mjs test/compaction.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "memory: retain worker report findings as worker candidates; compaction ledger lists reports" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 6: The worker prompt paragraph

**Files:**
- Modify: `lib/worker-def.mjs` (`resolveWorkerPrompt`)
- Test: `test/worker-def.test.mjs`

**Interfaces:**
- Produces: `REPORT_INSTRUCTION` (exported string); `resolveWorkerPrompt({ taskDir, home, memoryText, report })` inserts it between the base prompt and the memory excerpt when `report` is true.

- [ ] **Step 1: Write the failing test** — append to `test/worker-def.test.mjs`:

```js
test("resolveWorkerPrompt inserts the report instruction between the prompt and the memory excerpt when asked", async () => {
	const { resolveWorkerPrompt, REPORT_INSTRUCTION } = await import("../lib/worker-def.mjs");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-home-"));
	fs.mkdirSync(path.join(home, "prompts"));
	fs.writeFileSync(path.join(home, "prompts", "worker.md"), "GENERIC\n");
	const task = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-task-"));
	assert.equal(resolveWorkerPrompt({ taskDir: task, home }).prompt, "GENERIC");
	assert.equal(resolveWorkerPrompt({ taskDir: task, home, report: true }).prompt, `GENERIC\n\n${REPORT_INSTRUCTION}`);
	assert.equal(resolveWorkerPrompt({ taskDir: task, home, report: true, memoryText: "# MEMORY" }).prompt, `GENERIC\n\n${REPORT_INSTRUCTION}\n\n# MEMORY`);
	assert.match(REPORT_INSTRUCTION, /call the `report` tool once/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/worker-def.test.mjs`
Expected: FAIL — `REPORT_INSTRUCTION` is undefined.

- [ ] **Step 3: Implement** — in `lib/worker-def.mjs`, above `resolveWorkerPrompt` add:

```js
// Appended by resolveWorkerPrompt when the run has worker reports on, so every task's
// own worker.md gets it without edits. The tool's schema is the contract; this only
// says when to call it and what happens if a worker does not.
export const REPORT_INSTRUCTION =
	"Before your final message, call the `report` tool once: status (done, partial or blocked), a short summary, the files you changed, findings each labelled observed (you ran it and saw it), interpreted (your reading of what you saw) or hypothesis (not tested) — an interpreted or hypothesis finding also gives its settlement_criterion, the observation that would settle it — verify cases as [{ id, args, expect? }] that the supervisor can execute against the real code, and open questions. The orchestrator cannot complete the run while a finished worker has no report.";
```

and replace `resolveWorkerPrompt` with:

```js
export function resolveWorkerPrompt({ taskDir, home, memoryText = "", report = false }) {
	const own = path.join(taskDir, "worker.md");
	const file = fs.existsSync(own) ? own : path.join(home, "prompts", "worker.md");
	const base = fs.readFileSync(file, "utf8").trimEnd();
	return { prompt: [base, report ? REPORT_INSTRUCTION : "", memoryText].filter(Boolean).join("\n\n"), file };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/worker-def.test.mjs`
Expected: PASS, including the existing `resolveWorkerPrompt` test (the join reproduces `OWN\n\n# MEMORY\n- fact` exactly).

- [ ] **Step 5: Commit**

```bash
git add lib/worker-def.mjs test/worker-def.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "worker-def: report instruction appended to the worker prompt when reports are on" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 7: Supervisor wiring and a capped smoke run

**Files:**
- Modify: `supervisor.mjs` — imports, `GUARDS`, the `REPORT_FILE` constant next to `CHECKPOINT_FILE`, the launch `env` block, `pumpLifecycle`, `compactionLedger`, `runProbe`, `handleApproval`, `finish`, the `writeWorkerDefinition` call.

**Interfaces:**
- Consumes: everything produced in Tasks 1–6.
- Produces: `runs/<id>/reports.jsonl`; `summary.reports = { enabled, autoProbe, total, byWorker, unreported, verifyCases, autoProbes }` on orchestrator runs.

- [ ] **Step 1: Imports** — change the `./lib/workers.mjs` import to

```js
import { createTracker, applyLifecycleEvent, bindTranscript, dropUnclaimedSubagentEntry, unreportedWorkers } from "./lib/workers.mjs";
```

- [ ] **Step 2: Register the extension for every role** — in the `GUARDS` array, after the `checkpoint`-related entries (it ends with the pre-spawn-compact entry), add:

```js
	// Worker `report` tool (ext/report-ext.ts): registers nothing unless ARBITER_REPORT_FILE
	// is set; only the worker definition's tools line names it.
	path.join(here, "ext", "report-ext.ts"),
```

- [ ] **Step 3: The file and the env** — next to `const CHECKPOINT_FILE = path.join(RUN, "checkpoint.jsonl");` add

```js
const REPORT_FILE = path.join(RUN, "reports.jsonl");
let autoProbes = 0; // probes the supervisor ran from workers' verify cases (report.autoProbe)
```

and in the launch `env:` block, after the `ARBITER_CHECKPOINT_FILE` line, add

```js
			ARBITER_REPORT_FILE: PATTERN === "orchestrator" && CONFIG.report ? REPORT_FILE : "",
```

- [ ] **Step 4: Worker tools and prompt** — in the `if (PATTERN === "orchestrator") { ... }` block near the bottom: change `resolveWorkerPrompt({ taskDir: TASK, home: here, memoryText: MEMORY_TEXT })` to `resolveWorkerPrompt({ taskDir: TASK, home: here, memoryText: MEMORY_TEXT, report: Boolean(CONFIG.report) })`, and in the `writeWorkerDefinition` call change `tools: WORKER_TOOLS,` to `tools: CONFIG.report ? [...WORKER_TOOLS, "report"] : WORKER_TOOLS,`.

- [ ] **Step 5: The gate** — in `handleApproval()`, add `unreported: CONFIG.report ? unreportedWorkers(tracker, state) : [],` to the `decideApproval({...})` call, and replace the two lines after `if (verdict.ok) return runOracle();` with:

```js
	const why = verdict.reason === "unreported" ? M.gate.unreported(verdict.unreported) : M.gate[verdict.reason](verdict.sinceEditMs);
	const label = { no_probe: "approval without probe", no_src: "approval error", unreported: "approval without worker report", stale: "approval stale (src changed since probe)", too_soon: "approval too soon after edit" }[verdict.reason];
```

- [ ] **Step 6: Auto-probe** — in `pumpLifecycle()`, after the `guard:pre_spawn_compact_denied` line inside the loop, add:

```js
		// A worker's report carries probe-shaped verify cases; with report.autoProbe the
		// supervisor runs them at once — a probe the orchestrator did not have to ask for,
		// delivered to it labelled as the worker's own cases. Tasks without a probe.mjs skip.
		if (ev === "worker:report" && CONFIG.report?.autoProbe && Array.isArray(data?.verifyCases) && data.verifyCases.length && fs.existsSync(path.join(TASK, "oracle", "probe.mjs"))) {
			const wid = tracker.reports[tracker.reports.length - 1]?.role ?? String(data.role ?? "worker");
			runProbe({ from: "supervisor", to: VERIFIER, kind: "probe", body: JSON.stringify(data.verifyCases) }, { auto: wid });
		}
```

Then in `runProbe`: change the signature to `function runProbe(msg, { auto = null } = {}) {`; directly after `probeCount++;` add

```js
	if (auto) {
		autoProbes++;
		timeline.push({ ts: Date.now(), from: "supervisor", to: VERIFIER, kind: "probe", body: msg.body, auto });
	}
	const whose = auto ? "the worker's" : "your";
```

change the line `parts.push(\`${matchCount}/${expectById.size} matched your stated expectations.\`);` to use `${whose}` in place of `your`, and change the final delivery line to

```js
		deliver(VERIFIER, auto ? M.probe.autoResults(probeCount, auto, parts) : M.probe.results(probeCount, parts), auto ? `auto-probe results (${auto})` : "probe results");
```

- [ ] **Step 7: The ledger** — in `compactionLedger()`, change the `probes` line to

```js
	const probes = timeline.filter((m) => m.kind === "probe" && (m.from === "orchestrator" || m.auto)).map((m, i) => ({ n: i + 1, head: `${m.auto ? `(auto, ${m.auto}) ` : ""}${String(m.body).replace(/\s+/g, " ").slice(0, 100)}` }));
```

(auto-probes count in `probeCount` too, so `n` still equals the number the orchestrator saw) and add `reports: CONFIG.report ? tracker.reports : null` to the `ledgerLines({...})` call.

- [ ] **Step 8: Summary and retention** — in `finish()`, after `summary.memory = {...};` add:

```js
	if (PATTERN === "orchestrator") {
		summary.reports = {
			enabled: Boolean(CONFIG.report),
			autoProbe: Boolean(CONFIG.report?.autoProbe),
			total: tracker.reports.length,
			byWorker: tracker.reports.reduce((m, r) => ((m[r.role] = (m[r.role] ?? 0) + 1), m), {}),
			unreported: CONFIG.report ? unreportedWorkers(tracker, state) : [],
			verifyCases: tracker.reports.reduce((n, r) => n + (Number(r.verify) || 0), 0),
			autoProbes,
		};
	}
```

and in the retention `try` block, directly above `appendLog(MEMORY.log, retainFromRun(...))`, add

```js
		let reports = [];
		try {
			if (CONFIG.report && fs.existsSync(REPORT_FILE)) reports = fs.readFileSync(REPORT_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			reports = [];
		}
```

then change that call to `retainFromRun({ summary, timeline, deliverable, oracle: lastOracleResult, reports })`.

- [ ] **Step 9: Full suite and the guard smoke**

Run: `npm test` then `npm run smoke:guards`
Expected: every test passes (218 + the new ones); the guard smoke still passes (it loads every entry in `GUARDS`, so a load error in `report-ext.ts` shows here).

- [ ] **Step 10: A capped live smoke with reports on** — write a throwaway config `configs/smoke-orch-report.json`:

```json
{ "task": "glob", "pattern": "orchestrator", "report": { "autoProbe": true },
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" }, "worker": { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 } },
  "caps": { "wallSec": 240, "toolCalls": 120 } }
```

Run: `node supervisor.mjs --config configs/smoke-orch-report.json` (4 minutes; needs the llama router up). Then, with `<id>` the new directory under `runs/`:

```bash
grep -c "" runs/<id>/reports.jsonl 2>/dev/null || echo "no report yet (fine at 240 s)"
grep -E "\"type\":\"(warn|worker_report|model_error)\"" runs/<id>/audit.jsonl | head
grep -n "tools:" runs/<id>/ws-builder/.pi/agents/worker.md
node -e "console.log(JSON.stringify(require('./runs/<id>/summary.json').reports))"
```

Expected: no `warn` lines about `report-ext`; the worker definition's `tools:` line ends with `,report`; `summary.reports.enabled` is `true`. A report entry is a bonus at this cap, not required.

- [ ] **Step 11: Commit** (delete the throwaway config first)

```bash
rm configs/smoke-orch-report.json
git add supervisor.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "supervisor: worker reports — env, tool allowlist, gate input, auto-probe, ledger, summary.reports, retention" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 8: The paired batch on orbit, the report, the backlog

**Files:**
- Create: `configs/orch-orbit-27b-report.json`, `configs/orch-orbit-27b-report-autoprobe.json`, `docs/batch/worker-report.md`
- Modify: `docs/backlog.md`

- [ ] **Step 1: The two treatment configs** — copy `configs/orch-orbit-27b.json` twice. In `orch-orbit-27b-report.json` add `"report": true,` after `"pattern": "orchestrator",` and set `"_note": "Paired with orch-orbit-27b.json (2026-09-14): worker report tool on, gate refuses done while a completed worker has no report."`. In `orch-orbit-27b-report-autoprobe.json` add `"report": { "autoProbe": true },` and `"_note": "As orch-orbit-27b-report.json plus the supervisor runs each report's verify cases as a probe when it lands."`.

- [ ] **Step 2: Run the batch** (three runs, roughly 20 minutes each at 27B; run it in the background and do not edit `supervisor.mjs`, `lib/` or `ext/` until it finishes):

Run: `node tools/batch.mjs report-2026-09-14 configs/orch-orbit-27b.json configs/orch-orbit-27b-report.json configs/orch-orbit-27b-report-autoprobe.json`
Expected: `docs/batch/report-2026-09-14.md` with three rows.

- [ ] **Step 3: Read the numbers** — for each run id in that report:

```bash
node -e "const s=require('./runs/<id>/summary.json');console.log(JSON.stringify({reason:s.reason,wall:s.wallSec,probes:s.mailByKind?.probe,probedBeforeDone:s.orchestratorProbedBeforeDone,done:s.doneAttempts,reports:s.reports},null,1))"
grep -c "approval without worker report" runs/<id>/audit.jsonl
node tools/kpi.mjs | grep -E "<id>|E_excl"
```

and, for the two treatment runs, how many of the orchestrator's own probe cases reuse a worker's verify cases:

```bash
node -e "const fs=require('fs');const id=process.argv[1];const rep=fs.readFileSync('runs/'+id+'/reports.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);const want=new Set(rep.flatMap(r=>r.verify.map(c=>JSON.stringify(c.args))));let own=0,reused=0;for(const l of fs.readFileSync('runs/'+id+'/bus.jsonl','utf8').split('\n')){if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.kind!=='probe'||m.from!=='orchestrator')continue;let cases;try{cases=JSON.parse(m.body)}catch{continue}for(const c of cases){own++;if(want.has(JSON.stringify(c.args)))reused++}}console.log({workerCases:want.size,orchestratorCases:own,reused})" <id>
```

- [ ] **Step 4: Write `docs/batch/worker-report.md`** — a table with one row per run (config, run id, outcome, oracle score, wall s, probes total, of which auto, orchestrator probed before done, done attempts rejected for `unreported`, reports total, unreported at finish, orchestrator cases reusing worker cases, `E_excl`), then three short paragraphs: whether workers called `report` unprompted beyond the appended paragraph, whether the gate ever fired and what the orchestrator did next, whether auto-probe changed the orchestrator's own probing. State N=1 and what a second pair would settle. Do not claim a KPI gain from one pair.

- [ ] **Step 5: Backlog** — append to `docs/backlog.md` a section:

```markdown
## From Claude Code's Workflow tool (2026-09-14 — `docs/superpowers/specs/2026-09-14-workflow-borrowings-design.md`)

24. **Worker report contract** — done 2026-09-14 (`ext/report-ext.ts`, gate reason `unreported`, `report.autoProbe`, worker findings retained as `source: "agent"` candidates under the ledger's own criterion rule; `docs/batch/worker-report.md`). Off by default; flip the default only when a second orbit pair agrees with the first. Open: resolves #20's "report format" half; the free-text result still reaches the orchestrator too — measure whether the pair is a confound before delivering the structured copy instead.
```

- [ ] **Step 6: Commit**

```bash
git add configs/orch-orbit-27b-report.json configs/orch-orbit-27b-report-autoprobe.json docs/batch/report-2026-09-14.md docs/batch/worker-report.md docs/backlog.md memory/
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "worker report: paired orbit batch, report, backlog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

(`memory/` changes because retention runs at every finish; include them as every batch commit has.)
