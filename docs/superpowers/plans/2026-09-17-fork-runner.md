# Fork Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restart a recorded run from orchestrator inference n with the exact cognitive state, workspace and harness counters restored, and continue it unchanged (branch G / null fork) or with its first tool call forced to a chosen action class (A-natural) or to a recorded tool call (A-oracle), so gather-versus-act can be compared causally.

**Architecture:** pi gains an RPC `continue` command (mid-turn continuation from a tool-result leaf, which `Agent.continue()` already implements). The supervisor gains a fork mode driven by one env var: it copies the recorded workspace snapshot instead of the task's, copies the recorded session tree and truncates the orchestrator's file at the n-th assistant entry, launches pi with `--session <that file>`, re-seeds its counters from the recorded decision point, and sends `continue` instead of the kickoff. A one-shot guard forces the first tool call in the A branches. `tools/fork.mjs` runs replicates, checks the fork's first captured request against the recorded one, and writes the report.

**Tech Stack:** Node ESM, pi (TypeScript, vitest in `C:\Users\user\open_harnessess\pi\pi`), tsx-driven extension tests as in `test/pre-spawn-compact-ext.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-17-fork-runner-design.md`

## Global Constraints

- Arbiter repo `C:\Users\user\open_harnessess\pi\arbiter`, branch `probe-match`; `npm test` = `node --test "test/**/*.test.mjs"`, 408 pass today. pi repo `C:\Users\user\open_harnessess\pi\pi`, branch `main`; its tests run with `npm test` in `packages/coding-agent` (vitest). pi loads `packages/ai` from `dist`, but `packages/coding-agent` runs from `src` through tsx (the supervisor launches `packages/coding-agent/src/cli.ts`), so no build step is needed for Task 1.
- The canonical cognitive state of a fork is the captured provider request `runs/<id>/requests/NNNN.json` (`payload.messages`, `payload.tools`). A fork's first captured request must equal it; the runner reports the comparison and the null gate depends on it.
- Fork env var: `ARBITER_FORK` = JSON `{ run, call, branch, action?, tool?, args?, replicate? }` with `branch ∈ "G" | "A-natural" | "A-oracle"`, `call` 1-based (= request seq = traced call index + 1). Absent → the supervisor behaves exactly as today.
- Force env var for the guard: `ARBITER_FORK_FORCE` = JSON `{ cls, tool?, args? }`; absent → the guard registers nothing.
- Lifecycle events: `guard:fork_force_denied` (a first call of the wrong class was blocked), `guard:fork_force_rewritten` (A-oracle overwrote the call's input), `fork:continue` (the supervisor sent `continue`).
- Action classes and their mapping from a tool call are the ones in `tools/decision-points.mjs` `classifyTurn`: subagent → spawn (or resume when `resume` is set), get_subagent_result → collect, send_mail kind probe/done/other → probe/done/memory, read/ls/grep/find/bash → inspect, memory_search/memory_get → memory, checkpoint/context_usage → checkpoint.
- Never stage `memory/` or anything under `runs/`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QNstRa6QzP2vS2hgeYGo3F`. Files LF.
- The supervisor cannot be imported in tests (importing starts a run); its fork paths are verified by the live null fork in Task 6 and by keeping every non-trivial piece in `lib/fork.mjs`, which is unit-tested.

---

### Task 1: pi — RPC `continue` command

**Files (pi repo):**
- Modify: `packages/coding-agent/src/core/agent-session.ts` (the `_runAgentPrompt` region, ~line 1104)
- Modify: `packages/coding-agent/src/modes/rpc/rpc-mode.ts` (the command `switch`, next to `case "prompt"` ~line 394)
- Test: `packages/coding-agent/test/rpc-continue.test.ts` (new; model it on `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts` for how an `AgentSession` is built in tests)

**Interfaces:**
- Produces: RPC command `{ type: "continue", id? }` → on success `{ type: "response", command: "continue", success: true }` once the agent run has started; on failure (agent busy, last message is an assistant message, no messages) `{ type: "response", command: "continue", success: false, error }`. `AgentSession.continueFromTranscript(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Read `packages/coding-agent/test/rpc-prompt-response-semantics.test.ts` first and reuse its way of constructing a session with a fake provider. The test: build an `AgentSession` whose transcript ends with a user message followed by an assistant message with one tool call and its tool result (so the leaf is a tool result); call `session.continueFromTranscript()`; assert the fake provider received exactly one new request whose message list ends with that tool result (no new user message), and that after it resolves the session's last message is an assistant message. Second test: with the transcript ending in an assistant message (no pending tool result), `continueFromTranscript()` rejects with an error matching `/Cannot continue/`. Third test, RPC level, in the style of `rpc.test.ts`: send `{ type: "continue", id: "c1" }` to a session whose leaf is a tool result and expect a success response with `command: "continue"`.

- [ ] **Step 2: Run it to verify it fails**

Run (in `packages/coding-agent`): `npx vitest run test/rpc-continue.test.ts`
Expected: FAIL — `continueFromTranscript is not a function` / unknown command.

- [ ] **Step 3: Implement**

`agent-session.ts`: factor the run bookkeeping out of `_runAgentPrompt` so both entry points share it:

```ts
	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		await this._runAgent(() => this.agent.prompt(messages));
	}

	/**
	 * Continue the agent from the current transcript without adding a user message.
	 * The last message must be a user or tool-result message (Agent.continue()).
	 * Used by the RPC `continue` command to resume a session mid-turn.
	 */
	async continueFromTranscript(): Promise<void> {
		if (this._isAgentRunActive) throw new Error("Agent is already processing.");
		await this._runAgent(() => this.agent.continue());
	}

	private async _runAgent(start: () => Promise<void>): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await start();
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}
```

Keep whatever else the original `finally` block did (copy it verbatim from the current `_runAgentPrompt`; the snippet above shows the four lines visible today — if the file has more, keep them all). `_isAgentRunActive` must be reset wherever the original reset it.

`rpc-mode.ts`, beside `case "prompt"`:

```ts
			case "continue": {
				void session
					.continueFromTranscript()
					.then(() => output(success(id, "continue")))
					.catch((err) => output(error(id, "continue", err instanceof Error ? err.message : String(err))));
				return;
			}
```

Follow the file's own `success`/`error` helper signatures (read the `prompt` case and `get_last_assistant_text` case for the exact shapes; if `error` takes a different argument order, use that). If the switch has an exhaustive command-type union, add `"continue"` to it (grep `RpcCommand` in `packages/coding-agent/src/modes/rpc/`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/rpc-continue.test.ts` then the rpc suite `npx vitest run test/rpc`
Expected: PASS.

- [ ] **Step 5: Commit (pi repo)**

```bash
git -C C:/Users/user/open_harnessess/pi/pi add packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/modes/rpc/rpc-mode.ts packages/coding-agent/test/rpc-continue.test.ts
git -C C:/Users/user/open_harnessess/pi/pi commit -m "feat(coding-agent): RPC continue command resumes the agent from a tool-result leaf without a new user message"
```

---

### Task 2: `lib/fork.mjs` — the pure pieces

**Files:**
- Create: `lib/fork.mjs`
- Test: `test/fork.test.mjs`
- Fixture: `test/fixtures/run-trace/` (29 orchestrator calls, one worker) for truncation; synthetic objects for the rest.

**Interfaces:**
- Produces:
  - `truncateSessionEntries(entries, call)` → `{ entries, cut }`: keeps the header and every entry before the `call`-th (1-based) assistant `message` entry; `cut` is the index of the first dropped entry (or `entries.length`). Throws if there are fewer than `call` assistant entries.
  - `rewriteSessionHeader(entries, { cwd })` → same array with a new header object whose `cwd` is replaced; other header fields kept.
  - `forkCounters(decisionPoints, call)` → `{ probeCount, doneAttempts, pendingProbe, mailCount }` taken from the decision point with `i === call - 1` (`state.probes`, `state.doneAttempts`, `state.pendingProbe`) and `mailCount` = number of decision points before `call - 1` whose `action.cls` ∈ {probe, done, memory} (each was one `MAIL #n`).
  - `payloadEquals(a, b)` → `{ equal, firstDiff }` comparing `messages` (deep, by JSON) and the set of tool names in `tools`; `firstDiff` = `{ index, field }` naming the first differing message index, or `"tools"`.
  - `forkSpec(env)` → parsed `ARBITER_FORK` object or `null`; validates `branch`, `call ≥ 1`, and that `A-oracle` carries `tool`; throws with a clear message otherwise.
- Consumed by Task 4 (supervisor) and Task 5 (runner).

- [ ] **Step 1: Write the failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateSessionEntries, rewriteSessionHeader, forkCounters, payloadEquals, forkSpec } from "../lib/fork.mjs";
import { readSessionFile } from "../lib/context-trace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "run-trace", "sessions", "orchestrator", "2026-09-15T04-19-13-843Z_01a0a34a-5932-73db-aba5-dad81622d78a.jsonl");

test("truncateSessionEntries keeps the header and everything before the call-th assistant entry", () => {
	const entries = readSessionFile(FIXTURE);
	const assistants = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
	assert.equal(assistants.length, 29);
	const { entries: kept, cut } = truncateSessionEntries(entries, 4);
	assert.equal(kept[0].type, "session");
	assert.equal(kept.filter((e) => e.type === "message" && e.message.role === "assistant").length, 3);
	assert.equal(entries[cut].message.role, "assistant", "the first dropped entry is the 4th assistant message");
	assert.notEqual(kept.at(-1).message?.role, "assistant", "the leaf is a user or tool-result message, which Agent.continue() accepts");
	assert.deepEqual(truncateSessionEntries(entries, 1).entries.filter((e) => e.type === "message").map((e) => e.message.role), ["user"]);
	assert.throws(() => truncateSessionEntries(entries, 30), /only 29 assistant/);
});

test("rewriteSessionHeader replaces cwd and keeps the rest of the header", () => {
	const entries = readSessionFile(FIXTURE);
	const out = rewriteSessionHeader(entries, { cwd: "C:/fork/ws-builder" });
	assert.equal(out[0].cwd, "C:/fork/ws-builder");
	assert.equal(out[0].id, entries[0].id);
	assert.equal(out[0].type, "session");
	assert.notEqual(out[0], entries[0], "the original header object is not mutated");
	assert.equal(out.length, entries.length);
});

test("forkCounters reads the harness state at the decision point and counts the mails sent before it", () => {
	const pts = [
		{ i: 0, action: { cls: "inspect" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 1, action: { cls: "spawn" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 2, action: { cls: "probe" }, state: { probes: 0, doneAttempts: 0, pendingProbe: false } },
		{ i: 3, action: { cls: "memory" }, state: { probes: 1, doneAttempts: 0, pendingProbe: true } },
		{ i: 4, action: { cls: "resume" }, state: { probes: 1, doneAttempts: 0, pendingProbe: false } },
	];
	assert.deepEqual(forkCounters(pts, 5), { probeCount: 1, doneAttempts: 0, pendingProbe: false, mailCount: 2 });
	assert.deepEqual(forkCounters(pts, 1), { probeCount: 0, doneAttempts: 0, pendingProbe: false, mailCount: 0 });
	assert.throws(() => forkCounters(pts, 6), /no decision point/);
});

test("payloadEquals compares messages deeply and tool names, and names the first difference", () => {
	const a = { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: [{ type: "function", function: { name: "read" } }] };
	assert.deepEqual(payloadEquals(a, JSON.parse(JSON.stringify(a))), { equal: true, firstDiff: null });
	const b = { ...a, messages: [a.messages[0], { role: "user", content: "U2" }] };
	assert.deepEqual(payloadEquals(a, b), { equal: false, firstDiff: { index: 1, field: "content" } });
	const c = { ...a, tools: [] };
	assert.deepEqual(payloadEquals(a, c), { equal: false, firstDiff: "tools" });
	const d = { ...a, messages: a.messages.slice(0, 1) };
	assert.deepEqual(payloadEquals(a, d), { equal: false, firstDiff: { index: 1, field: "missing" } });
});

test("forkSpec parses ARBITER_FORK and validates it", () => {
	assert.equal(forkSpec({}), null);
	assert.deepEqual(forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 5, branch: "G" }) }), { run: "r", call: 5, branch: "G", action: null, tool: null, args: null, replicate: 1 });
	const oracle = forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 5, branch: "A-oracle", action: "probe", tool: "send_mail", args: { kind: "probe", body: "[]" }, replicate: 2 }) });
	assert.equal(oracle.replicate, 2);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 0, branch: "G" }) }), /call/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "B" }) }), /branch/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "A-natural" }) }), /action/);
	assert.throws(() => forkSpec({ ARBITER_FORK: JSON.stringify({ run: "r", call: 1, branch: "A-oracle", action: "probe" }) }), /tool/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/fork.test.mjs` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/fork.mjs`**

```js
// Fork helpers: everything a forked run needs that can be computed without a
// running supervisor, so it is unit-tested (supervisor.mjs cannot be imported by
// tests). Spec: docs/superpowers/specs/2026-09-17-fork-runner-design.md.
export const BRANCHES = ["G", "A-natural", "A-oracle"];

/** Keep the header and every entry before the call-th (1-based) assistant message entry. */
export function truncateSessionEntries(entries, call) {
	let seen = 0;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant") {
			seen++;
			if (seen === call) return { entries: entries.slice(0, i), cut: i };
		}
	}
	throw new Error(`cannot fork at call ${call}: the session has only ${seen} assistant entries`);
}

/** A copy of the entries whose header carries the fork's own workspace path. */
export function rewriteSessionHeader(entries, { cwd }) {
	if (!entries.length || entries[0].type !== "session") throw new Error("session entries must start with a header");
	return [{ ...entries[0], cwd }, ...entries.slice(1)];
}

const MAIL_CLASSES = new Set(["probe", "done", "memory"]);

/** Harness counters at the moment of the call-th inference, from decisions.jsonl. */
export function forkCounters(points, call) {
	const p = points.find((x) => x.i === call - 1);
	if (!p) throw new Error(`no decision point for call ${call}`);
	const mailCount = points.filter((x) => x.i < call - 1 && MAIL_CLASSES.has(x.action.cls)).length;
	return { probeCount: p.state.probes, doneAttempts: p.state.doneAttempts, pendingProbe: Boolean(p.state.pendingProbe), mailCount };
}

/** Is the fork's first captured request the recorded one? Messages deep-equal, same tool names. */
export function payloadEquals(a, b) {
	const am = a?.messages ?? [], bm = b?.messages ?? [];
	for (let i = 0; i < Math.max(am.length, bm.length); i++) {
		if (!am[i] || !bm[i]) return { equal: false, firstDiff: { index: i, field: "missing" } };
		for (const field of new Set([...Object.keys(am[i]), ...Object.keys(bm[i])])) {
			if (JSON.stringify(am[i][field]) !== JSON.stringify(bm[i][field])) return { equal: false, firstDiff: { index: i, field } };
		}
	}
	const names = (p) => (p?.tools ?? []).map((t) => t.function?.name ?? t.name).sort().join(",");
	if (names(a) !== names(b)) return { equal: false, firstDiff: "tools" };
	return { equal: true, firstDiff: null };
}

/** Parse and validate ARBITER_FORK; null when unset. */
export function forkSpec(env) {
	const raw = (env.ARBITER_FORK ?? "").trim();
	if (!raw) return null;
	let f;
	try { f = JSON.parse(raw); } catch (err) { throw new Error(`ARBITER_FORK is not JSON: ${err.message}`); }
	if (!f.run || typeof f.run !== "string") throw new Error("ARBITER_FORK.run must name a recorded run");
	if (!Number.isInteger(f.call) || f.call < 1) throw new Error("ARBITER_FORK.call must be a 1-based inference number");
	if (!BRANCHES.includes(f.branch)) throw new Error(`ARBITER_FORK.branch must be one of ${BRANCHES.join(", ")}`);
	if (f.branch !== "G" && !f.action) throw new Error("ARBITER_FORK.action (an action class) is required for A branches");
	if (f.branch === "A-oracle" && !f.tool) throw new Error("ARBITER_FORK.tool (and args) are required for A-oracle");
	return { run: f.run, call: f.call, branch: f.branch, action: f.action ?? null, tool: f.tool ?? null, args: f.args ?? null, replicate: Number.isInteger(f.replicate) ? f.replicate : 1 };
}
```

- [ ] **Step 4: Run tests** — `node --test test/fork.test.mjs` → 5 pass; then `npm test`.

- [ ] **Step 5: Commit** — `git add lib/fork.mjs test/fork.test.mjs && git commit -m "fork: pure helpers — session truncation, header rewrite, counters from the decision point, payload equality, ARBITER_FORK parsing"`

---

### Task 3: the `fork-force` guard

**Files:**
- Create: `lib/policies/fork-force.mjs`, `ext/guards/fork-force.ts`
- Modify: `supervisor.mjs` `GUARDS` (insert before `ext/guards/topology.ts`) and the child env (add `ARBITER_FORK_FORCE`)
- Test: `test/fork-force-policy.test.mjs`, `test/fork-force-ext.test.mjs` (harness as in `test/pre-spawn-compact-ext.test.mjs`), `test/supervisor-guards.test.mjs` (extend: fork-force precedes topology)

**Interfaces:**
- Produces: `classOfCall(toolName, input)` → action class (same mapping as `classifyTurn`); `decideForce({ toolName, input }, force, state)` → `{ act: "pass" }` | `{ act: "deny", reason }` | `{ act: "rewrite", input }`; `state = { done: false }` becomes `done: true` once a call of the forced class has passed (or been rewritten), after which everything passes. Env `ARBITER_FORK_FORCE` = `{ cls, tool?, args? }`.

- [ ] **Step 1: Failing tests**

`test/fork-force-policy.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classOfCall, decideForce } from "../lib/policies/fork-force.mjs";

test("classOfCall mirrors decision-points' classes for a single tool call", () => {
	assert.equal(classOfCall("subagent", { subagent_type: "tester", prompt: "x" }), "spawn");
	assert.equal(classOfCall("subagent", { resume: "id", prompt: "x" }), "resume");
	assert.equal(classOfCall("get_subagent_result", {}), "collect");
	assert.equal(classOfCall("send_mail", { kind: "probe", body: "[]" }), "probe");
	assert.equal(classOfCall("send_mail", { kind: "done", body: "" }), "done");
	assert.equal(classOfCall("send_mail", { kind: "memory", body: "" }), "memory");
	assert.equal(classOfCall("read", { path: "a" }), "inspect");
	assert.equal(classOfCall("memory_get", { ids: [] }), "memory");
	assert.equal(classOfCall("context_usage", {}), "checkpoint");
});

test("A-natural: deny every first call of the wrong class with the class named; the first call of the right class passes and disarms", () => {
	const force = { cls: "probe", tool: null, args: null };
	const state = { done: false };
	const d1 = decideForce({ toolName: "read", input: { path: "src/x.mjs" } }, force, state);
	assert.equal(d1.act, "deny");
	assert.match(d1.reason, /send a probe to the supervisor/);
	assert.equal(state.done, false);
	const d2 = decideForce({ toolName: "send_mail", input: { kind: "probe", body: "[]" } }, force, state);
	assert.deepEqual(d2, { act: "pass" });
	assert.equal(state.done, true);
	assert.deepEqual(decideForce({ toolName: "read", input: { path: "a" } }, force, state), { act: "pass" }, "disarmed after the forced call");
});

test("A-oracle: the first call of the right tool has its input replaced by the recorded arguments", () => {
	const force = { cls: "resume", tool: "subagent", args: { resume: "abc", prompt: "recorded brief" } };
	const state = { done: false };
	assert.equal(decideForce({ toolName: "send_mail", input: { kind: "probe" } }, force, state).act, "deny");
	const d = decideForce({ toolName: "subagent", input: { resume: "abc", prompt: "the model's own brief" } }, force, state);
	assert.deepEqual(d, { act: "rewrite", input: { resume: "abc", prompt: "recorded brief" } });
	assert.equal(state.done, true);
});

test("no force → pass", () => {
	assert.deepEqual(decideForce({ toolName: "read", input: {} }, null, { done: false }), { act: "pass" });
});
```

`test/fork-force-ext.test.mjs` (copy the harness of `test/pre-spawn-compact-ext.test.mjs`, feeding `tool_call` events with `toolName` and `input` per step and reading the lifecycle file): (1) unset env → not registered; (2) `ARBITER_FORK_FORCE={"cls":"probe"}`: a `read` is blocked (`block: true`, reason names the probe), lifecycle `guard:fork_force_denied`; then a `send_mail {kind:"probe"}` passes (undefined) and a later `read` passes with no further events; (3) `{"cls":"resume","tool":"subagent","args":{"resume":"abc","prompt":"R"}}`: a `subagent` call's `input` object is mutated in place to the recorded args and `guard:fork_force_rewritten` is logged with `{ tool: "subagent" }`.

`test/supervisor-guards.test.mjs`: add an assertion that `fork-force.ts` appears immediately before `topology.ts`.

- [ ] **Step 2: Run to verify failure** — the three test files fail.

- [ ] **Step 3: Implement**

`lib/policies/fork-force.mjs`:

```js
// fork-force policy: in an A branch of a fork, the orchestrator's first tool call
// must be of the forced action class (A-natural) — or, for A-oracle, the forced
// tool with the recorded arguments. Wrong-class calls are denied with the class
// named until one of the right class passes; then the policy is spent.
const DESCRIBE = {
	spawn: "spawn a new worker (subagent)", resume: "resume an existing worker (subagent with resume)", collect: "collect a background worker's result (get_subagent_result)",
	probe: "send a probe to the supervisor (send_mail kind=probe)", done: "claim the task is done (send_mail kind=done)", inspect: "inspect the workspace (read, ls, grep)",
	memory: "consult memory (memory_search, memory_get)", checkpoint: "checkpoint or check context usage", answer: "answer without a tool",
};

export function classOfCall(toolName, input) {
	const a = input ?? {};
	switch (toolName) {
		case "subagent": return a.resume ? "resume" : "spawn";
		case "get_subagent_result": return "collect";
		case "send_mail": return a.kind === "probe" ? "probe" : a.kind === "done" ? "done" : "memory";
		case "read": case "ls": case "grep": case "find": case "bash": return "inspect";
		case "memory_search": case "memory_get": case "remember": return "memory";
		case "checkpoint": case "context_usage": return "checkpoint";
		default: return "inspect";
	}
}

export function decideForce({ toolName, input }, force, state) {
	if (!force || state.done) return { act: "pass" };
	const cls = classOfCall(toolName, input);
	if (cls !== force.cls || (force.tool && toolName !== force.tool)) {
		return { act: "deny", reason: `[FORK] Your next action must be: ${DESCRIBE[force.cls] ?? force.cls}${force.tool ? ` — call \`${force.tool}\` now` : ""}. Do that first; other calls are refused until you do.` };
	}
	state.done = true;
	if (force.args && typeof force.args === "object") return { act: "rewrite", input: { ...force.args } };
	return { act: "pass" };
}
```

`ext/guards/fork-force.ts` (imports exactly like `ext/guards/pre-spawn-compact.ts`; `optionsFromEnv` parses `ARBITER_FORK_FORCE` as JSON or returns null):

```ts
export default function (pi: ExtensionAPI) {
	if (!FORCE) return;
	const state = { done: false };
	pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx: unknown) => {
		if (kit.roleFor(ctx) !== "orchestrator") return undefined;
		const input = event.input ?? {};
		const d = decideForce({ toolName: event.toolName, input }, FORCE, state);
		if (d.act === "deny") { kit.report("fork_force", "denied", ctx, { tool: event.toolName, wanted: FORCE.cls }); return kit.deny(d.reason); }
		if (d.act === "rewrite") { for (const k of Object.keys(input)) delete input[k]; Object.assign(input, d.input); kit.report("fork_force", "rewritten", ctx, { tool: event.toolName }); }
		return undefined;
	});
}
```

`supervisor.mjs`: insert `path.join(here, "ext", "guards", "fork-force.ts")` in `GUARDS` immediately before the topology entry with a comment (first blocking result wins; the fork's forcing must be seen before the topology nudge), and add `ARBITER_FORK_FORCE: process.env.ARBITER_FORK_FORCE ?? ""` to the child env next to `ARBITER_TOPOLOGY` (the runner sets it in the supervisor's own env; the supervisor passes it through).

- [ ] **Step 4: Run** — the three test files, then `npm test`.
- [ ] **Step 5: Commit** — `git add lib/policies/fork-force.mjs ext/guards/fork-force.ts supervisor.mjs test/fork-force-policy.test.mjs test/fork-force-ext.test.mjs test/supervisor-guards.test.mjs && git commit -m "fork-force guard: force the orchestrator's first tool call to a class (A-natural) or a recorded call (A-oracle)"`

---

### Task 4: supervisor fork mode

**Files:**
- Modify: `supervisor.mjs` at these sites (line numbers from today's file; read each before editing):
  - workspace creation `:150-153` (`fs.cpSync(path.join(TASK, "ws-builder"), WS.workspace, ...)`)
  - counters `:291-298` (`mailCount`, `doneAttempts`), `:939` (`probeCount`), `:297` (`lastProbeHash`)
  - `launch()` args `:320-374` (add `--session <file>` for the orchestrator)
  - prompt assembly (`prompts[name]`, before launch): use the recorded prompt for the orchestrator
  - kickoff `:1558-1576` (`deliver("orchestrator", M.kickoff.orchestrator(), "kickoff")`)
  - `finish()` summary (`:1357` area, `RECORDED_CONFIG` / summary fields)
- Modify: `lib/config.mjs` — no change needed; the fork spec is read from env in the supervisor via `forkSpec(process.env)`.

**Interfaces:**
- Consumes: `forkSpec`, `truncateSessionEntries`, `rewriteSessionHeader`, `forkCounters`, `readSessionFile` (lib/context-trace.mjs).
- Produces: a run directory exactly like a normal run plus `summary.json.fork = { run, call, branch, action, tool, replicate, sessionCut, counters }`, lifecycle event `fork:continue`, and (because capture stays on) `requests/0001.json` = the fork's first request.

- [ ] **Step 1: Write the check that will verify this task (no unit test can import the supervisor)**

Add to `test/supervisor-guards.test.mjs` a source-level test: the supervisor imports `forkSpec` from `./lib/fork.mjs`, contains the string `"--session"`, contains `ev: "fork:continue"`, and contains `M.kickoff.orchestrator()` only inside a branch guarded by `!FORK` (assert the kickoff line's enclosing 3 lines contain `FORK`). This pins the shape; Task 6 is the real verification.

- [ ] **Step 2: Implement, in this order**

(a) Near the top, after `CONFIG` is loaded and `TASK` is known:

```js
import { forkSpec, truncateSessionEntries, rewriteSessionHeader, forkCounters } from "./lib/fork.mjs";
import { readSessionFile } from "./lib/context-trace.mjs";
// Fork mode (docs/superpowers/specs/2026-09-17-fork-runner-design.md): restart a recorded
// run at orchestrator inference `call` with its workspace snapshot, its session truncated
// there, its counters re-seeded, and `continue` instead of the kickoff.
const FORK = forkSpec(process.env);
const FORK_SRC = FORK ? path.join(here, "runs", FORK.run) : null;
if (FORK) {
	for (const p of [path.join(FORK_SRC, "requests", `${String(FORK.call).padStart(4, "0")}.json`), path.join(FORK_SRC, "sessions", "orchestrator"), path.join(FORK_SRC, "decisions.jsonl"), path.join(FORK_SRC, "prompts", "orchestrator.md")]) {
		if (!fs.existsSync(p)) { console.error(`fork: missing ${p}`); process.exit(2); }
	}
	if (PATTERN !== "orchestrator") { console.error("fork: only orchestrator runs can be forked"); process.exit(2); }
}
```

(b) Workspace: replace the task copy with the snapshot when forking:

```js
const FORK_REQ = FORK ? JSON.parse(fs.readFileSync(path.join(FORK_SRC, "requests", `${String(FORK.call).padStart(4, "0")}.json`), "utf8")) : null;
if (FORK) fs.cpSync(path.join(FORK_SRC, "requests", FORK_REQ.snapshot), WS.workspace, { recursive: true });
else fs.cpSync(path.join(TASK, "ws-builder"), WS.workspace, { recursive: true });
```

(`.pi/` was excluded from the snapshot; the normal `installWorkspaceExtension` / `writeRosterDefinitions` calls run unchanged afterwards.)

(c) Sessions: before `launch("orchestrator")`, copy the recorded tree and truncate the orchestrator's own file:

```js
let FORK_SESSION_FILE = null, FORK_CUT = null;
if (FORK) {
	const srcDir = path.join(FORK_SRC, "sessions", "orchestrator");
	const dstDir = path.join(SESSIONS, "orchestrator");
	fs.cpSync(srcDir, dstDir, { recursive: true });
	const own = fs.readdirSync(dstDir).filter((f) => f.endsWith(".jsonl")); // the orchestrator's file(s); workers live under <id>/tasks/
	if (own.length !== 1) { console.error(`fork: expected one orchestrator session file, found ${own.length}`); process.exit(2); }
	FORK_SESSION_FILE = path.join(dstDir, own[0]);
	const { entries, cut } = truncateSessionEntries(readSessionFile(FORK_SESSION_FILE), FORK.call);
	FORK_CUT = cut;
	fs.writeFileSync(FORK_SESSION_FILE, rewriteSessionHeader(entries, { cwd: WS.workspace }).map((e) => JSON.stringify(e)).join("\n") + "\n");
}
```

(d) `launch()`: after `"--session-dir", path.join(SESSIONS, name),` add `...(FORK && name === "orchestrator" ? ["--session", FORK_SESSION_FILE] : []),`.

(e) Prompt: where `prompts.orchestrator` is final (just before launching), `if (FORK) prompts.orchestrator = fs.readFileSync(path.join(FORK_SRC, "prompts", "orchestrator.md"), "utf8");` — the recorded system prompt, verbatim (memory brief included).

(f) Counters: after the counter declarations, `if (FORK) { const c = forkCounters(JSON.parse("[" + fs.readFileSync(path.join(FORK_SRC, "decisions.jsonl"), "utf8").trim().split("\n").join(",") + "]"), FORK.call); mailCount = c.mailCount; doneAttempts = c.doneAttempts; probeCount = c.probeCount; if (c.probeCount > 0) lastProbeHash = hashDir(path.join(WS.workspace, "src")); FORK_COUNTERS = c; }` — `probeCount` is declared later (`:939`); place the probe part of this after that declaration, or hoist. `lastProbeHash = hashDir(src)` is the ruling in the spec: the restored src is what the last probe saw unless the record says otherwise; note it in the summary.

(g) Kickoff: in the ready timer, `if (FORK) { log({ type: "lifecycle", msg: `fork: continuing ${FORK.run} at call ${FORK.call} (${FORK.branch})` }); fs.appendFileSync(LIFECYCLE, JSON.stringify({ ts: Date.now(), ev: "fork:continue", data: { ...FORK } }) + "\n"); send("orchestrator", { id: "fork-continue", type: "continue" }); } else deliver("orchestrator", M.kickoff.orchestrator(), "kickoff");`

(h) Summary: add `fork: FORK ? { ...FORK, sessionCut: FORK_CUT, counters: FORK_COUNTERS, sourceRequestHash: FORK_REQ.hash } : null` to the summary object.

(i) Env passthrough: `ARBITER_FORK_FORCE` (Task 3) is set by the runner only for A branches.

- [ ] **Step 3: Run** — `npm test` (the source-level test passes; nothing else changes).
- [ ] **Step 4: Commit** — `git add supervisor.mjs test/supervisor-guards.test.mjs && git commit -m "supervisor: fork mode — restore a recorded run at inference n and continue it"`

---

### Task 5: `tools/fork.mjs` — the runner and the report

**Files:**
- Create: `tools/fork.mjs`
- Test: `test/fork-runner.test.mjs` (pure parts only: `planForks`, `compareFirstRequest`, `forkRow`, `renderReport`)

**Interfaces:**
- CLI: `node tools/fork.mjs <runId> <call> --config <config.json> --branch G|A-natural|A-oracle [--action <cls>] [--replicates N] [--null]`. `--null` = branch G with the null-gate read-out. For `A-oracle`, `--action` may be omitted: the runner takes the recorded class, tool and arguments from `runs/<runId>/decisions.jsonl` (point `call-1`: `action.cls`, `action.tool`) and the recorded arguments from the session file's `call`-th assistant entry's first tool call (`readSessionFile` → the assistant entry → `content[].type === "toolCall"` → `arguments`).
- For each replicate: spawn `node supervisor.mjs --config <cfg>` with env `ARBITER_FORK` (+ `ARBITER_FORK_FORCE` for A branches: `{ cls, tool?, args? }`), wait, find the new run id (diff `runs/` as `tools/batch.mjs` does), then: `node tools/decision-points.mjs <newId>` (child process), compare `runs/<newId>/requests/0001.json` payload with the source `NNNN.json` payload (`payloadEquals`), read the new run's first decision point (class, tool, params head), oracle results from audit, probes/resumes counts, decoded tokens and wall from summary/decisions.
- Report: `docs/batch/fork-<runId>-<call>.md` with the source point (its recorded class, next substantive action, head pick if `decisions-replay-substantive.jsonl` exists) and one row per replicate: branch, replicate, run id, `stateMatch` (+ first diff), first action (class · tool · params head), recorded action reproduced?, oracle, probes, resumes, decoded, wall. Null mode adds the reproduction rate line: `null fork: state match k/n, recorded class reproduced m/n`.

- [ ] **Step 1: Failing tests** for `planForks(spec)` (expands branch × replicates into env objects; A-oracle fills tool/args from the recorded call), `compareFirstRequest(sourceReq, forkReq)` (wraps payloadEquals), `forkRow(summary, decisions, audit)` (the row fields from synthetic inputs) and `renderReport(rows, source)` (contains one row per replicate and the reproduction line in null mode). Use synthetic objects; no runs.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** with the pure functions exported and `main()` guarded by the `process.argv[1]` check used in the other tools. Spawn the supervisor with `stdio: ["ignore", log, log]` to `runs/.batch-fork-<runId>-<call>/<branch>-<replicate>.log`.
- [ ] **Step 4: Run tests, `npm test`.**
- [ ] **Step 5: Commit** — `git add tools/fork.mjs test/fork-runner.test.mjs && git commit -m "tools/fork: run fork replicates, verify the restored state against the recorded request, report"`

---

### Task 6: the null-fork gate, live (controller runs this; needs llama-server)

- [ ] **Step 1:** Pick three recorded points on captured runs where the leaf is a tool result and no worker is live, from `docs/batch/decision-head-2.md`'s list: `2026-09-17T14-09-17` call 4 (inspect → spawn), `2026-09-17T14-23-08` call 7 (inspect → probe), `2026-09-17T14-51-39` call 15 (inspect → done).
- [ ] **Step 2:** For each: `node tools/fork.mjs <run> <call> --config configs/orch-pathnorm-27b-topology.json --null --replicates 2` (about 5 min per replicate; run sequentially; nothing else on the server).
- [ ] **Step 3:** Read the three reports. Gate: `stateMatch` must be true on every replicate (if not, the first diff names what the restoration got wrong — fix before anything else); record the recorded-class reproduction rate as the baseline every A-versus-G comparison must clear.
- [ ] **Step 4:** Commit the reports; update `docs/superpowers/specs/2026-09-17-fork-runner-design.md` status line with the measured baseline.

## Self-review

**Spec coverage.** Canonical state = captured payload → Task 4(c–e) restores from the session + recorded prompt, Task 5 verifies against the captured request, Task 6 gates on it. Branches G / A-natural / A-oracle → Tasks 3 and 5. Null fork gate → Task 6. Whole-workspace snapshot → already shipped (`ext/replay-capture.ts`). Replicates → Task 5 `--replicates`. Measurements → Task 5 rows (oracle, probes, resumes, decoded, wall, first action and its params; "gathered info referenced later" is left to the analysis over the causal links, not the runner). Counters re-seeded → Task 4(f).

**Placeholder scan.** Task 1 says "copy the original `finally` block verbatim" because the visible snippet may be incomplete — that is an instruction with a concrete source, not a placeholder. Task 4 gives line anchors from today's file and says to read before editing.

**Type consistency.** `forkSpec` returns `{ run, call, branch, action, tool, args, replicate }` and Task 4 and 5 use those names; `truncateSessionEntries` returns `{ entries, cut }`; `forkCounters` returns `{ probeCount, doneAttempts, pendingProbe, mailCount }`; `decideForce` returns `{ act: "pass" | "deny" | "rewrite", reason?, input? }`; the guard's events are `fork_force_denied` / `fork_force_rewritten`; the RPC command is `{ type: "continue" }`.
