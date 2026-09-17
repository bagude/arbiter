# Roster Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Specialists declare what they need and produce; the orchestrator is told the derived order and the review rule; a `topology` guard nudges a spawn whose workspace preconditions are unmet.

**Architecture:** Two optional roster frontmatter keys (`needs`, `produces`) parsed by `lib/roster.mjs`, which also derives the order and renders it into the Roster section. A pure policy `lib/policies/topology-policy.mjs` decides pass/deny/waive/skip from a spawn's arguments, the guard's in-process state, and a list of test-file mtimes; `ext/guards/topology.ts` is the thin pi adapter that supplies the filesystem and reports to the lifecycle file. Config, supervisor env, and the guard counter learn the new guard and its three event kinds.

**Tech Stack:** Node ESM (`node --test`, `node:assert/strict`), pi extensions in TypeScript run through tsx, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-roster-topology-design.md`

## Global Constraints

- Repo: `C:\Users\user\open_harnessess\pi\arbiter`, branch `probe-match`. Run tests with `npm test` (`node --test "test/**/*.test.mjs"`); 365 pass today.
- Artifact vocabulary is exactly `api, tests, code, map, review`. The only guard-checked artifact in this slice is `tests`, satisfied by at least one regular file under `<workspace>/src/__tests__/`.
- Lifecycle event names are exactly `guard:topology_denied`, `guard:topology_waived`, `guard:topology_skipped`.
- Config key is `guards.topology` with values `"nudge"`, `"enforce"`, `true` (= nudge), or `{ "mode": "nudge" | "enforce" }`; absent/false = off.
- Env var to the child is `ARBITER_TOPOLOGY`, JSON `{ mode, needs: { <specialist>: [artifacts] } }`, `""` when off.
- `ext/guards/topology.ts` must sit immediately **before** `ext/guards/pre-spawn-compact.ts` in `supervisor.mjs`'s `GUARDS` list.
- A roster with no declared needs must render the Roster section byte-for-byte as today; `test/orchestrator-prompt.test.mjs` must keep passing unchanged.
- Guards import `ext/guard-kit.ts` and their policy by file URL through `ARBITER_HOME`, never relatively (the workspace copy has no siblings). Copy the import lines from `ext/guards/pre-spawn-compact.ts:19-26`.
- Commit messages end with the two trailer lines:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QNstRa6QzP2vS2hgeYGo3F`.
- Never stage `memory/` (the user's ledger) or anything under `runs/`.

---

### Task 1: `needs` / `produces` in roster files

**Files:**
- Modify: `lib/roster.mjs:8-9` (add `ARTIFACTS`), `lib/roster.mjs:46-49` (parse + return), `lib/roster.mjs:62-68` (cycle check in `selectSpecialists`)
- Modify: `roster/tester.md:1-9`, `roster/implementer.md:1-8`, `roster/scout.md:1-9` (frontmatter only)
- Test: `test/roster.test.mjs`

**Interfaces:**
- Produces: `export const ARTIFACTS = ["api", "tests", "code", "map", "review"]`; `parseRosterFile(file)` returns `{ ..., needs: string[], produces: string[] }` (both `[]` by default); `selectSpecialists(roster, names)` throws `topology cycle among selected specialists: a -> b -> a` when produces→needs edges form a cycle. Task 2 consumes `needs`/`produces`; Task 4 sends `needs` per specialist in `ARBITER_TOPOLOGY`.

- [ ] **Step 1: Write the failing tests**

Append to `test/roster.test.mjs` (the file already imports `parseRosterFile`, `loadRoster`, `selectSpecialists`, `tmpRoster`, `TESTER`; add `ARTIFACTS` to the import line):

```js
test("needs/produces: parsed as lists over ARTIFACTS, default [], bad names rejected", () => {
	const dir = tmpRoster({
		"tester.md": TESTER.replace("memory: tester\n", "memory: tester\nneeds: api\nproduces: tests\n"),
		"plain.md": "---\nname: plain\ndescription: No topology.\ntools: read\n---\nb\n",
		"bad.md": "---\nname: bad\ndescription: Bad artifact.\ntools: read\nneeds: api, coffee\n---\nb\n",
	});
	assert.deepEqual(ARTIFACTS, ["api", "tests", "code", "map", "review"]);
	const tester = parseRosterFile(path.join(dir, "tester.md"));
	assert.deepEqual(tester.needs, ["api"]);
	assert.deepEqual(tester.produces, ["tests"]);
	const plain = parseRosterFile(path.join(dir, "plain.md"));
	assert.deepEqual(plain.needs, []);
	assert.deepEqual(plain.produces, []);
	assert.throws(() => parseRosterFile(path.join(dir, "bad.md")), /bad\.md: unknown artifact "coffee" in needs \(known: api, tests, code, map, review\)/);
});

test("selectSpecialists rejects a produces->needs cycle among the selected set and names it", () => {
	const dir = tmpRoster({
		"a.md": "---\nname: a\ndescription: A.\ntools: read\nneeds: tests\nproduces: code\n---\nb\n",
		"b.md": "---\nname: b\ndescription: B.\ntools: read\nneeds: code\nproduces: tests\n---\nb\n",
		"c.md": "---\nname: c\ndescription: C.\ntools: read\nproduces: tests\n---\nb\n",
	});
	const roster = loadRoster(dir);
	assert.throws(() => selectSpecialists(roster, ["a", "b"]), /topology cycle among selected specialists: a -> b -> a/);
	// the cycle is only among the selected set: c produces tests without needing code
	assert.equal(selectSpecialists(roster, ["a", "c"]).length, 2);
});

test("the shipped roster declares the intended topology", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	assert.deepEqual(roster.get("tester").needs, ["api"]);
	assert.deepEqual(roster.get("tester").produces, ["tests"]);
	assert.deepEqual(roster.get("implementer").needs, ["api", "tests"]);
	assert.deepEqual(roster.get("implementer").produces, ["code"]);
	assert.deepEqual(roster.get("scout").needs, []);
	assert.deepEqual(roster.get("scout").produces, ["map"]);
	assert.deepEqual(roster.get("worker").needs, []);
	assert.deepEqual(roster.get("worker").produces, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/roster.test.mjs`
Expected: the three new tests FAIL (`ARTIFACTS` is not exported; `needs` is `undefined`).

- [ ] **Step 3: Implement**

In `lib/roster.mjs`, after line 8 (`ROSTER_TOOLS`), add:

```js
// Artifacts a specialist may need (from the brief or the workspace) or produce.
// `api` lives in the orchestrator's brief; the rest are files in the workspace.
// Only `tests` has a guard-side check in this slice (lib/policies/topology-policy.mjs).
export const ARTIFACTS = ["api", "tests", "code", "map", "review"];

function parseArtifacts(fields, key, file) {
	const list = (fields[key] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
	for (const a of list) if (!ARTIFACTS.includes(a)) throw new Error(`${file}: unknown artifact "${a}" in ${key} (known: ${ARTIFACTS.join(", ")})`);
	return list;
}
```

In `parseRosterFile`, before the `if (!body)` line, add:

```js
	const needs = parseArtifacts(fields, "needs", file);
	const produces = parseArtifacts(fields, "produces", file);
```

and change the return to:

```js
	return { name, description, tools, thinking, background, maxTurns, memory, needs, produces, body, file };
```

Replace `selectSpecialists` with:

```js
export function selectSpecialists(roster, names) {
	const specs = names.map((n) => {
		const spec = roster.get(n);
		if (!spec) throw new Error(`unknown specialist "${n}" (roster has: ${[...roster.keys()].sort().join(", ")})`);
		return spec;
	});
	const cycle = findTopologyCycle(specs);
	if (cycle) throw new Error(`topology cycle among selected specialists: ${cycle.join(" -> ")}`);
	return specs;
}

// Edges: producer -> consumer for every artifact one selected specialist produces
// and another needs. Returns the first cycle as [a, b, ..., a], or null.
function findTopologyCycle(specs) {
	const producers = new Map(); // artifact -> [names]
	for (const s of specs) for (const a of s.produces) (producers.get(a) ?? producers.set(a, []).get(a)).push(s.name);
	const next = new Map(specs.map((s) => [s.name, []])); // name -> names it depends on
	for (const s of specs) for (const a of s.needs) for (const p of producers.get(a) ?? []) if (p !== s.name) next.get(s.name).push(p);
	const state = new Map(); // name -> "open" | "done"
	const stack = [];
	const visit = (n) => {
		if (state.get(n) === "done") return null;
		if (state.get(n) === "open") return [...stack.slice(stack.indexOf(n)), n];
		state.set(n, "open");
		stack.push(n);
		for (const m of next.get(n)) {
			const c = visit(m);
			if (c) return c;
		}
		stack.pop();
		state.set(n, "done");
		return null;
	};
	for (const s of specs) {
		const c = visit(s.name);
		if (c) return c;
	}
	return null;
}
```

Note the cycle test expects `a -> b -> a`: `a` needs tests (produced by `b`), so `a` depends on `b`; `b` needs code (produced by `a`). `visit("a")` opens `a`, visits `b`, `b` visits `a` (open) → `["a", "b", "a"]`.

Roster frontmatter edits (add the two lines before the closing `---`; keep everything else):

`roster/tester.md`: add `needs: api` and `produces: tests`.
`roster/implementer.md`: add `needs: api, tests` and `produces: code`.
`roster/scout.md`: add `produces: map`.
`roster/worker.md`: unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, including the existing "renderDefinition's output is YAML-safe" test (the new keys are not emitted into the agent file).

- [ ] **Step 5: Commit**

```bash
git add lib/roster.mjs roster/tester.md roster/implementer.md roster/scout.md test/roster.test.mjs
git commit -m "roster: needs/produces frontmatter over a fixed artifact vocabulary; cycle check on selection"
```

---

### Task 2: Derived order in the Roster section

**Files:**
- Modify: `lib/roster.mjs:90-97` (`rosterSection`), add `rosterOrder`
- Test: `test/roster.test.mjs`, `test/orchestrator-prompt.test.mjs` (must still pass unchanged)

**Interfaces:**
- Consumes: `spec.needs`, `spec.produces` from Task 1.
- Produces: `rosterOrder(specs)` → `spec[]` in dependency order (stable on input order); `rosterSection(specs)` renders the order paragraph when any selected spec has `needs.length > 0`.

- [ ] **Step 1: Write the failing tests**

Append to `test/roster.test.mjs` (add `rosterOrder` to the import):

```js
test("rosterOrder puts producers before consumers and keeps the config order for ties", () => {
	const dir = tmpRoster({
		"implementer.md": "---\nname: implementer\ndescription: I.\ntools: read\nneeds: api, tests\nproduces: code\n---\nb\n",
		"tester.md": "---\nname: tester\ndescription: T.\ntools: read\nneeds: api\nproduces: tests\n---\nb\n",
		"scout.md": "---\nname: scout\ndescription: S.\ntools: read\nproduces: map\n---\nb\n",
	});
	const roster = loadRoster(dir);
	const order = rosterOrder(selectSpecialists(roster, ["implementer", "tester", "scout"])).map((s) => s.name);
	assert.deepEqual(order, ["tester", "implementer", "scout"]);
});

test("rosterSection renders the derived order and the review rule when a specialist declares needs", () => {
	const dir = tmpRoster({
		"implementer.md": "---\nname: implementer\ndescription: I.\ntools: read\nneeds: api, tests\nproduces: code\n---\nb\n",
		"tester.md": "---\nname: tester\ndescription: T.\ntools: read\nneeds: api\nproduces: tests\n---\nb\n",
	});
	const roster = loadRoster(dir);
	const text = rosterSection(selectSpecialists(roster, ["implementer", "tester"]));
	const expected = [
		'- `subagent` (subagent_type "implementer"): I.',
		'- `subagent` (subagent_type "tester"): T.',
		"",
		"Order for this roster: tester → implementer.",
		"- tester needs the API from your brief (exports and signatures) and produces tests under src/__tests__/.",
		"- implementer needs the API from your brief (exports and signatures) and tests under src/__tests__/; read the tests against the specification before you brief it, resume the tester for any obligation they miss, and name the test file in the brief. Produces code under src/.",
		"",
		"Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
	assert.equal(text, expected);
});

test("rosterSection with no declared needs renders exactly the pre-topology text", () => {
	const dir = tmpRoster({ "worker.md": "---\nname: worker\ndescription: W.\ntools: read\n---\nb\n" });
	const text = rosterSection(selectSpecialists(loadRoster(dir), ["worker"]));
	assert.equal(text, '- `subagent` (subagent_type "worker"): W.\n\nWorkers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/roster.test.mjs`
Expected: FAIL (`rosterOrder` is not exported; the order paragraph is missing).

- [ ] **Step 3: Implement**

In `lib/roster.mjs`, replace `rosterSection` with:

```js
// One phrase per artifact, in the two positions a sentence can use it. The Roster
// section is part of the orchestrator's stable prefix: everything here derives from
// the roster files, never from the run.
const ARTIFACT_PHRASES = {
	api: { needs: "the API from your brief (exports and signatures)", produces: "the API" },
	tests: { needs: "tests under src/__tests__/", produces: "tests under src/__tests__/" },
	code: { needs: "code under src/", produces: "code under src/" },
	map: { needs: "a map of the workspace", produces: "a map of the workspace" },
	review: { needs: "a review", produces: "a review" },
};
const REVIEW_RULE = "read the tests against the specification before you brief it, resume the tester for any obligation they miss, and name the test file in the brief";

// Dependency order: a specialist that needs an artifact comes after every selected
// specialist that produces it. Kahn's algorithm, ties broken by input order.
export function rosterOrder(specs) {
	const producers = new Map();
	for (const s of specs) for (const a of s.produces) (producers.get(a) ?? producers.set(a, []).get(a)).push(s.name);
	const deps = new Map(specs.map((s) => [s.name, new Set()]));
	for (const s of specs) for (const a of s.needs) for (const p of producers.get(a) ?? []) if (p !== s.name) deps.get(s.name).add(p);
	const out = [];
	const done = new Set();
	while (out.length < specs.length) {
		const ready = specs.find((s) => !done.has(s.name) && [...deps.get(s.name)].every((d) => done.has(d)));
		if (!ready) throw new Error("topology cycle among selected specialists"); // selectSpecialists rejects this earlier
		out.push(ready);
		done.add(ready.name);
	}
	return out;
}

function joinPhrases(list) {
	return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function orderParagraph(specs) {
	if (!specs.some((s) => s.needs.length)) return [];
	const order = rosterOrder(specs);
	const lines = [`Order for this roster: ${order.map((s) => s.name).join(" → ")}.`];
	for (const s of order) {
		if (!s.needs.length && !s.produces.length) continue;
		const needs = joinPhrases(s.needs.map((a) => ARTIFACT_PHRASES[a].needs));
		const produces = joinPhrases(s.produces.map((a) => ARTIFACT_PHRASES[a].produces));
		if (s.needs.includes("tests")) {
			lines.push(`- ${s.name} needs ${needs}; ${REVIEW_RULE}.${produces ? ` Produces ${produces}.` : ""}`);
		} else if (s.needs.length) {
			lines.push(`- ${s.name} needs ${needs}${produces ? ` and produces ${produces}` : ""}.`);
		} else {
			lines.push(`- ${s.name} produces ${produces}.`);
		}
	}
	return [...lines, ""];
}

export function rosterSection(specs) {
	const lines = specs.map((s) => `- \`subagent\` (subagent_type "${s.name}"): ${s.description}`);
	return [
		...lines,
		"",
		...orderParagraph(specs),
		"Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, including `test/orchestrator-prompt.test.mjs` (legacy `worker` renders no order paragraph).

- [ ] **Step 5: Commit**

```bash
git add lib/roster.mjs test/roster.test.mjs
git commit -m "roster: derive the specialist order from needs/produces and render it into the Roster section"
```

---

### Task 3: Pure topology policy

**Files:**
- Create: `lib/policies/topology-policy.mjs`
- Test: `test/topology-policy.test.mjs`

**Interfaces:**
- Produces:
  - `initialState()` → `{ lastTestsRead: 0, denied: Set<string> }`
  - `noteToolCall({ toolName, input }, state, nowMs)` → mutates `state.lastTestsRead` when the call reads `src/__tests__` (tool `read` or `ls` with `input.path` under it, or `bash` whose `input.command` contains `src/__tests__`).
  - `decideSpawn({ mode, needsFor, input, state, testsFiles })` where `mode` ∈ `"nudge" | "enforce"`, `needsFor` = `{ [specialist]: string[] }`, `input` = the `subagent` tool input, `testsFiles` = `[{ mtimeMs }]` → one of
    - `{ ok: true, event: null }`
    - `{ ok: true, event: "skipped", reason: string }`
    - `{ ok: true, event: "waived", failed: string }`
    - `{ ok: false, event: "denied", reason: string, failed: string }`
    where `failed` is `"tests:missing"` or `"tests:unread"`.
  - `CHECKED_ARTIFACTS = ["tests"]`.
- Task 4 consumes all of these.

- [ ] **Step 1: Write the failing tests**

Create `test/topology-policy.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, noteToolCall, decideSpawn, CHECKED_ARTIFACTS } from "../lib/policies/topology-policy.mjs";

const NEEDS = { tester: ["api"], implementer: ["api", "tests"] };
const spawn = (subagent_type, extra = {}) => ({ subagent_type, description: "d", prompt: "Do the thing.", ...extra });

test("only tests is guard-checked; a specialist with no checked need always passes", () => {
	assert.deepEqual(CHECKED_ARTIFACTS, ["tests"]);
	const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("tester"), state: initialState(), testsFiles: [] });
	assert.deepEqual(d, { ok: true, event: null });
	const unknown = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("scout"), state: initialState(), testsFiles: [] });
	assert.deepEqual(unknown, { ok: true, event: null });
});

test("a resume is never judged", () => {
	const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { resume: "abc" }), state: initialState(), testsFiles: [] });
	assert.deepEqual(d, { ok: true, event: null });
});

test("missing tests: enforce denies every time with the tester-first reason", () => {
	const state = initialState();
	for (let i = 0; i < 2; i++) {
		const d = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
		assert.equal(d.ok, false);
		assert.equal(d.event, "denied");
		assert.equal(d.failed, "tests:missing");
		assert.match(d.reason, /^topology: implementer needs tests, and src\/__tests__\/ has none\. Spawn the tester first/);
		assert.match(d.reason, /"topology: skip — <reason>"/);
	}
});

test("missing tests: nudge denies once per specialist, then waives", () => {
	const state = initialState();
	const first = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.equal(first.ok, false);
	assert.equal(first.event, "denied");
	const second = decideSpawn({ mode: "nudge", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles: [] });
	assert.deepEqual(second, { ok: true, event: "waived", failed: "tests:missing" });
});

test("tests exist but were not read since written: denied with the read reason; a later read satisfies it", () => {
	const state = initialState();
	const testsFiles = [{ mtimeMs: 1000 }, { mtimeMs: 5000 }];
	noteToolCall({ toolName: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, state, 2000);
	const stale = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.equal(stale.ok, false);
	assert.equal(stale.failed, "tests:unread");
	assert.match(stale.reason, /tests exist but you have not read them since they were written/);
	noteToolCall({ toolName: "bash", input: { command: "cat src/__tests__/pathnorm.test.mjs" } }, state, 6000);
	const fresh = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer"), state, testsFiles });
	assert.deepEqual(fresh, { ok: true, event: null });
});

test("noteToolCall ignores reads elsewhere and tools it does not know", () => {
	const state = initialState();
	noteToolCall({ toolName: "read", input: { path: "src/pathnorm.mjs" } }, state, 100);
	noteToolCall({ toolName: "write", input: { path: "src/__tests__/x.test.mjs" } }, state, 200);
	assert.equal(state.lastTestsRead, 0);
	noteToolCall({ toolName: "ls", input: { path: "src/__tests__" } }, state, 300);
	assert.equal(state.lastTestsRead, 300);
});

test("a skip line as the first prompt line passes and is reported with its reason, in both modes", () => {
	for (const mode of ["nudge", "enforce"]) {
		const d = decideSpawn({
			mode,
			needsFor: NEEDS,
			input: spawn("implementer", { prompt: "topology: skip — spec is a one-liner, tests would be the implementation\nImplement it." }),
			state: initialState(),
			testsFiles: [],
		});
		assert.deepEqual(d, { ok: true, event: "skipped", reason: "spec is a one-liner, tests would be the implementation" });
	}
	const hyphen = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { prompt: "topology: skip - no tests apply" }), state: initialState(), testsFiles: [] });
	assert.equal(hyphen.event, "skipped");
	const notFirstLine = decideSpawn({ mode: "enforce", needsFor: NEEDS, input: spawn("implementer", { prompt: "Implement.\ntopology: skip — late" }), state: initialState(), testsFiles: [] });
	assert.equal(notFirstLine.ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/topology-policy.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `lib/policies/topology-policy.mjs`:

```js
// Topology policy: may the orchestrator spawn this specialist now?
//
// A specialist's `needs` (lib/roster.mjs) name artifacts. Only `tests` has a
// workspace check in this slice: at least one file under src/__tests__/, and the
// orchestrator has read that directory since the newest file was written — the
// review step where a missing case gets caught before any code exists
// (docs/batch/roster-pathnorm-pair-2.md: both misses were a case the tester never
// derived and the orchestrator never looked for).
//
// Modes: "enforce" denies every violating spawn; "nudge" denies the first violating
// spawn per specialist and lets the next through (waived), so the orchestrator is
// told once and the record shows what it chose. Either mode accepts a brief whose
// first line is `topology: skip — <reason>` and reports the reason.
export const CHECKED_ARTIFACTS = ["tests"];

const TESTS_DIR_RE = /(^|[\\/])src[\\/]__tests__([\\/]|$)/;
const SKIP_RE = /^\s*topology:\s*skip\s*[—–-]+\s*(.*)$/;

export function initialState() {
	return { lastTestsRead: 0, denied: new Set() };
}

/** Record reads of src/__tests__ so decideSpawn can tell "written" from "reviewed". */
export function noteToolCall({ toolName, input }, state, nowMs) {
	const p = String(input?.path ?? "");
	const cmd = String(input?.command ?? "");
	const reads = ((toolName === "read" || toolName === "ls") && TESTS_DIR_RE.test(p)) || (toolName === "bash" && cmd.includes("src/__tests__"));
	if (reads) state.lastTestsRead = Math.max(state.lastTestsRead, nowMs);
}

function testsReason(specialist, failed) {
	const retry = `then read src/__tests__/*.test.mjs against the specification, resume the tester for anything missing, and retry this spawn. To proceed without tests, make the first line of the prompt "topology: skip — <reason>".`;
	if (failed === "tests:missing") return `topology: ${specialist} needs tests, and src/__tests__/ has none. Spawn the tester first with the API (exports and signatures) from the specification, ${retry}`;
	return `topology: ${specialist} needs tests; tests exist but you have not read them since they were written. Read src/__tests__/ against the specification, then retry this spawn. To proceed anyway, make the first line of the prompt "topology: skip — <reason>".`;
}

export function decideSpawn({ mode, needsFor, input, state, testsFiles }) {
	const specialist = String(input?.subagent_type ?? "");
	const checked = (needsFor?.[specialist] ?? []).filter((a) => CHECKED_ARTIFACTS.includes(a));
	if (!checked.length || input?.resume) return { ok: true, event: null };
	const firstLine = String(input?.prompt ?? "").split(/\r?\n/)[0];
	const skip = SKIP_RE.exec(firstLine);
	if (skip) return { ok: true, event: "skipped", reason: skip[1].trim().slice(0, 200) };
	let failed = null;
	if (checked.includes("tests")) {
		const files = Array.isArray(testsFiles) ? testsFiles : [];
		if (!files.length) failed = "tests:missing";
		else if (state.lastTestsRead < Math.max(...files.map((f) => Number(f.mtimeMs) || 0))) failed = "tests:unread";
	}
	if (!failed) return { ok: true, event: null };
	if (mode === "nudge" && state.denied.has(specialist)) return { ok: true, event: "waived", failed };
	state.denied.add(specialist);
	return { ok: false, event: "denied", reason: testsReason(specialist, failed), failed };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/topology-policy.test.mjs`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add lib/policies/topology-policy.mjs test/topology-policy.test.mjs
git commit -m "topology policy: pass/deny/waive/skip for a specialist spawn from needs, state and test-file mtimes"
```

---

### Task 4: The `topology` guard, config, env, ordering, counting

**Files:**
- Create: `ext/guards/topology.ts`
- Modify: `lib/config.mjs:142-149` (guards block), `supervisor.mjs:84-102` (`GUARDS`), `supervisor.mjs:377-378` (env), `lib/workers.mjs:203` (regex)
- Test: `test/topology-ext.test.mjs`, `test/config.test.mjs`, `test/workers.test.mjs` (or wherever guard counting is tested: `grep -n "guard:" test/*.test.mjs`), `test/supervisor-guards.test.mjs` (new, list-order assertion)

**Interfaces:**
- Consumes: Task 3's `initialState`, `noteToolCall`, `decideSpawn`; `kit.report`, `kit.deny`, `kit.homeUrl` from `ext/guard-kit.ts`.
- Produces: `CONFIG.guards.topology` = `null | { mode: "nudge" | "enforce" }`; env `ARBITER_TOPOLOGY`; lifecycle events `guard:topology_{denied,waived,skipped}` counted into `summary.guards.topology`.

- [ ] **Step 1: Write the failing tests**

Create `test/topology-ext.test.mjs` (harness modelled on `test/pre-spawn-compact-ext.test.mjs`, with a real temp workspace as `ctx.cwd`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/topology.ts through tsx with a fake `pi`, a temp workspace as
// ctx.cwd, and a scripted sequence of tool_call events. Opt-in: registers nothing
// unless ARBITER_TOPOLOGY is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";
const NEEDS = { tester: ["api"], implementer: ["api", "tests"] };

function run({ calls, env = {}, workspace }) {
	const ws = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "topology-ws-"));
	const lifecycle = path.join(os.tmpdir(), `topology-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `topology-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import fs from "node:fs";
		import path from "node:path";
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/topology.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const ctx = { cwd: ${JSON.stringify(ws)}, sessionManager: { getSessionFile: () => undefined } };
		const out = [];
		for (const step of ${JSON.stringify(calls)}) {
			if (step.writeTests) { fs.mkdirSync(path.join(ctx.cwd, "src", "__tests__"), { recursive: true }); fs.writeFileSync(path.join(ctx.cwd, "src", "__tests__", step.writeTests), "// t\\n"); await new Promise(r => setTimeout(r, 20)); out.push("wrote"); continue; }
			out.push(handlers.tool_call ? await handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName: step.tool, input: step.input }, ctx) : "not-registered");
			await new Promise(r => setTimeout(r, 20));
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ARBITER_TOPOLOGY: "", ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines, ws };
}

const SPAWN = (subagent_type, prompt = "Do it.") => ({ tool: "subagent", input: { subagent_type, description: "d", prompt } });
const ENV = { ARBITER_TOPOLOGY: JSON.stringify({ mode: "nudge", needs: NEEDS }) };

test("not registered when ARBITER_TOPOLOGY is unset", () => {
	const { registered, out } = run({ calls: [SPAWN("implementer")] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, ["not-registered"]);
});

test("nudge: implementer spawn with no tests is denied once with the tester-first reason, then waived; both reported", () => {
	const { out, lines } = run({ calls: [SPAWN("implementer"), SPAWN("implementer")], env: ENV });
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /^topology: implementer needs tests, and src\/__tests__\/ has none/);
	assert.equal(out[1], undefined, "second attempt passes");
	assert.deepEqual(lines.map((l) => l.ev), ["guard:topology_denied", "guard:topology_waived"]);
	assert.equal(lines[0].data.role, "orchestrator");
	assert.equal(lines[0].data.specialist, "implementer");
	assert.equal(lines[0].data.failed, "tests:missing");
});

test("tester spawn is never judged; tests written then read lets the implementer through silently", () => {
	const { out, lines } = run({
		calls: [SPAWN("tester"), { writeTests: "pathnorm.test.mjs" }, { tool: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, SPAWN("implementer")],
		env: ENV,
	});
	assert.deepEqual(out, [undefined, "wrote", undefined, undefined]);
	assert.deepEqual(lines, []);
});

test("tests written but not read: denied with the read reason", () => {
	const { out, lines } = run({ calls: [{ writeTests: "x.test.mjs" }, SPAWN("implementer")], env: { ARBITER_TOPOLOGY: JSON.stringify({ mode: "enforce", needs: NEEDS }) } });
	assert.equal(out[1].block, true);
	assert.match(out[1].reason, /you have not read them since they were written/);
	assert.equal(lines[0].data.failed, "tests:unread");
});

test("skip line passes and is reported with the reason", () => {
	const { out, lines } = run({ calls: [SPAWN("implementer", "topology: skip — nothing to test\nImplement.")], env: { ARBITER_TOPOLOGY: JSON.stringify({ mode: "enforce", needs: NEEDS }) } });
	assert.equal(out[0], undefined);
	assert.equal(lines[0].ev, "guard:topology_skipped");
	assert.equal(lines[0].data.reason, "nothing to test");
});
```

Append to `test/config.test.mjs` (reuse the file's `tmpConfig`, `SKIP`, and the roster-aware helpers near line 186; the orchestrator pattern requires a `workers` block):

```js
test("guards.topology: string mode, true, or { mode }; validated; off by default", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" } };
	const workers = { default: { provider: "llama.cpp", model: "qwen3-27b" }, use: ["worker"] };
	const base = { task: "pathnorm", pattern: "orchestrator", roles, workers };
	assert.equal(loadConfig({ configPath: tmpConfig(base), env: SKIP }).guards.topology, null);
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, guards: { topology: "nudge" } }), env: SKIP }).guards.topology, { mode: "nudge" });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, guards: { topology: true } }), env: SKIP }).guards.topology, { mode: "nudge" });
	assert.deepEqual(loadConfig({ configPath: tmpConfig({ ...base, guards: { topology: { mode: "enforce" } } }), env: SKIP }).guards.topology, { mode: "enforce" });
	assert.throws(() => loadConfig({ configPath: tmpConfig({ ...base, guards: { topology: "loud" } }), env: SKIP }), /guards\.topology mode must be "nudge" or "enforce"/);
});
```

Create `test/supervisor-guards.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi's extension runner returns the FIRST blocking tool_call result, so a guard
// that denies `subagent` must precede pre-spawn-compact in supervisor.mjs's GUARDS
// list or its reason never reaches the model. Read the source rather than import
// supervisor.mjs (importing it starts a run).
test("GUARDS lists topology.ts immediately before pre-spawn-compact.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const t = names.indexOf("topology.ts");
	assert.ok(t >= 0, `topology.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[t + 1], "pre-spawn-compact.ts");
});
```

For the counter, find the existing guard-counting test with `grep -n "guard:" test/*.test.mjs` (expected in `test/workers.test.mjs`, a test that feeds `guard:bash_timeout_rewritten`), and add next to it:

```js
test("guard events of kind waived and skipped are counted like denied and rewritten", () => {
	const tracker = newTracker();
	for (const kind of ["denied", "waived", "skipped"]) {
		const { audit } = observe(tracker, { ts: 1, ev: `guard:topology_${kind}`, data: { role: "orchestrator", specialist: "implementer" } });
		assert.equal(audit[0].type, "guard");
		assert.match(audit[0].msg, new RegExp(`^topology ${kind}: `));
	}
	assert.deepEqual(tracker.guards.topology, { denied: { orchestrator: 1 }, waived: { orchestrator: 1 }, skipped: { orchestrator: 1 } });
});
```

(Use the tracker constructor and the observe function the neighbouring test already uses; the names above are placeholders for **those exact identifiers**: read the neighbouring test and copy its calls.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/topology-ext.test.mjs test/config.test.mjs test/supervisor-guards.test.mjs test/workers.test.mjs`
Expected: topology-ext FAIL (module not found), config FAIL (`unknown guard "topology"`), supervisor-guards FAIL, workers FAIL (waived/skipped not counted).

- [ ] **Step 3: Implement**

Create `ext/guards/topology.ts`:

```ts
/**
 * topology guard — nudges the orchestrator when it spawns a specialist whose
 * declared workspace needs are unmet. In this slice the one checked need is
 * `tests`: a file under src/__tests__/ that the orchestrator has read since it was
 * written (lib/policies/topology-policy.mjs has the rule and the reasons).
 *
 * Opt-in per run: ARBITER_TOPOLOGY is "" (registers nothing) or JSON
 * { mode: "nudge" | "enforce", needs: { <specialist>: [artifacts] } } built by the
 * supervisor from the selected roster. Only the orchestrator calls `subagent`; the
 * guard is loaded everywhere like the others and does nothing elsewhere.
 *
 * Must precede pre-spawn-compact.ts in supervisor.mjs GUARDS: pi returns the first
 * blocking result, and this guard's reason is the one the model needs first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.ARBITER_HOME ?? path.resolve(here, "..", "..");
const kit = await import(new URL(`file:///${path.join(home, "ext", "guard-kit.ts").replace(/\\/g, "/")}`).href);
const { initialState, noteToolCall, decideSpawn } = await import(kit.homeUrl(home, "lib", "policies", "topology-policy.mjs"));

function optionsFromEnv(raw: string | undefined): { mode: string; needs: Record<string, string[]> } | null {
	const v = (raw ?? "").trim();
	if (!v) return null;
	try {
		const parsed = JSON.parse(v);
		if (!parsed || typeof parsed !== "object" || !parsed.mode) return null;
		return { mode: String(parsed.mode), needs: parsed.needs ?? {} };
	} catch {
		return null;
	}
}

const OPTS = optionsFromEnv(process.env.ARBITER_TOPOLOGY);

function testsFiles(cwd: string): { mtimeMs: number }[] {
	const dir = path.join(cwd, "src", "__tests__");
	if (!fs.existsSync(dir)) return [];
	const out: { mtimeMs: number }[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push({ mtimeMs: fs.statSync(p).mtimeMs });
		}
	};
	walk(dir);
	return out;
}

export default function (pi: ExtensionAPI) {
	if (!OPTS) return;
	const state = initialState();
	pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx: { cwd: string }) => {
		const input = event.input ?? {};
		noteToolCall({ toolName: event.toolName, input }, state, Date.now());
		if (event.toolName !== "subagent") return undefined;
		const d = decideSpawn({ mode: OPTS.mode, needsFor: OPTS.needs, input, state, testsFiles: testsFiles(ctx.cwd) });
		const specialist = String(input.subagent_type ?? "");
		if (d.event === "skipped") kit.report("topology", "skipped", ctx, { specialist, reason: d.reason });
		else if (d.event === "waived") kit.report("topology", "waived", ctx, { specialist, failed: d.failed });
		else if (d.event === "denied") kit.report("topology", "denied", ctx, { specialist, failed: d.failed, mode: OPTS.mode });
		if (!d.ok) return kit.deny(d.reason);
		return undefined;
	});
}
```

`lib/config.mjs`, replace the guards block (lines 142-149) with:

```js
	const guards = { result_handles: null, call_args: null, pre_spawn_compact: null, topology: null };
	for (const [name, value] of Object.entries(raw.guards ?? {})) {
		if (!(name in guards)) throw new Error(`unknown guard "${name}" in ${configPath} (known: ${Object.keys(guards).join(", ")})`);
		if (value === true) guards[name] = {};
		else if (value === false || value == null) guards[name] = null;
		else if (typeof value === "object" && !Array.isArray(value)) guards[name] = value;
		// topology takes a bare mode string as shorthand for { mode }.
		else if (name === "topology" && typeof value === "string") guards[name] = { mode: value };
		else throw new Error(`guards.${name} must be true, false or an options object in ${configPath}`);
	}
	if (guards.topology) {
		const mode = guards.topology.mode ?? "nudge";
		if (mode !== "nudge" && mode !== "enforce") throw new Error(`guards.topology mode must be "nudge" or "enforce" in ${configPath}, got ${JSON.stringify(mode)}`);
		guards.topology = { mode };
	}
```

`supervisor.mjs` `GUARDS`: insert before the pre-spawn-compact entry:

```js
	// Topology nudge on `subagent` (registers nothing unless CONFIG.guards.topology is
	// set). Listed BEFORE pre-spawn-compact: pi returns the first blocking tool_call
	// result, and when both would deny the same spawn the orchestrator needs this
	// reason (spawn the tester first) before the compaction one.
	path.join(here, "ext", "guards", "topology.ts"),
```

`supervisor.mjs` env (next to `ARBITER_PRE_SPAWN_COMPACT`):

```js
			ARBITER_TOPOLOGY: CONFIG.guards.topology
				? JSON.stringify({ mode: CONFIG.guards.topology.mode, needs: Object.fromEntries((CONFIG.workers?.specialists ?? []).map((s) => [s.name, s.needs])) })
				: "",
```

`lib/workers.mjs:203`:

```js
	const guardMatch = /^guard:(.+)_(denied|rewritten|waived|skipped)$/.exec(ev);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass (previous count + new tests).

- [ ] **Step 5: Commit**

```bash
git add ext/guards/topology.ts lib/config.mjs supervisor.mjs lib/workers.mjs test/topology-ext.test.mjs test/config.test.mjs test/supervisor-guards.test.mjs test/workers.test.mjs
git commit -m "topology guard: nudge/enforce a specialist spawn whose tests precondition is unmet; config, env, ordering, counting"
```

---

### Task 5: Roster prompt bodies, experiment config, docs

**Files:**
- Modify: `roster/tester.md` (body), `roster/implementer.md` (body)
- Create: `configs/orch-pathnorm-27b-topology.json`
- Modify: `docs/backlog.md` (one "Done" line under the roster entry; find it with `grep -n "roster" docs/backlog.md`)
- Test: `test/roster.test.mjs` (existing "four shipped files parse" and "YAML-safe" tests), `test/config.test.mjs` (load the new config)

**Interfaces:**
- Consumes: Task 1's frontmatter keys (already in the files), Task 4's `guards.topology`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.mjs`:

```js
test("configs/orch-pathnorm-27b-topology.json loads: tester then implementer, nudge, memory search", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const c = loadConfig({ configPath: path.join(here, "..", "configs", "orch-pathnorm-27b-topology.json"), env: SKIP });
	assert.deepEqual(c.workers.use, ["tester", "implementer"]);
	assert.deepEqual(c.guards.topology, { mode: "nudge" });
	assert.equal(c.memory.mode, "search");
	assert.equal(c.memory.retrievalChars, 9000);
});
```

(If `test/config.test.mjs` does not already import `path` and `fileURLToPath`, add those imports.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL (config file missing).

- [ ] **Step 3: Implement**

Create `configs/orch-pathnorm-27b-topology.json`:

```json
{ "task": "pathnorm", "pattern": "orchestrator", "report": true,
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" } },
  "workers": { "default": { "provider": "llama.cpp", "model": "qwen3-27b", "thinking": "off" }, "use": ["tester", "implementer"], "max": 1 },
  "caps": { "toolCalls": 250, "wallSec": 1800, "usd": 5, "doneAttempts": 5 },
  "memory": { "mode": "search", "budgetChars": 2000, "retrievalChars": 9000, "workerReserveChars": 4000 },
  "guards": { "topology": "nudge" },
  "_note": "Test-first roster (2026-09-17): tester writes src/__tests__ from the API in the brief, the orchestrator reviews the tests against the spec, then the implementer builds to them. topology guard in nudge mode. Pair with orch-pathnorm-27b.json (control) and orch-pathnorm-27b-roster-memory.json. Spec: docs/superpowers/specs/2026-09-17-roster-topology-design.md" }
```

Replace the body of `roster/tester.md` (everything after the closing `---`) with:

```
You are TESTER. You are independent: you have not seen how the code was written and you must not ask. The module may not be implemented yet — that is expected. Write `src/__tests__/<module>.test.mjs` using `node:test` and `node:assert/strict` (create the directory if needed; nothing else outside it) against the API in the brief: the exports and signatures are your contract, and README.md and `src/` tell you the module's name and shape.

Derive the tests from the brief's rules, not only its examples. Cover every obligation with at least one assertion of a concrete value. For every rule the brief states, add one assertion per degenerate input it applies to: the empty string, a lone `.`, the root `/`, a trailing separator, a non-string argument. Ordering and duplicate inputs where the brief mentions them.

Run `node --test src/__tests__/` once to confirm the file loads. Failures against a stub or a missing implementation are expected and are not findings. Report:
- status: done when the test file loads (state the assertion count and the file path); blocked only when the file itself cannot load.
- findings: only for something in the brief you could not turn into an assertion (say which rule and why).

Never edit files outside `src/__tests__/`. Use `remember` at most twice, for a testing lesson that transfers to other modules of this kind (an assertion pattern, a node:test pitfall), not for this task's specifics.

When you are done, call the `report` tool once with status done (or blocked) and your findings; the orchestrator cannot see your answer until you do.
```

Append to the body of `roster/implementer.md`, before the `remember` paragraph:

```
If the brief names a test file under `src/__tests__/`, run it first with `node --test src/__tests__/` and make it pass; do not edit anything under `src/__tests__/`. If a test contradicts the brief, say so in your report and follow the brief.
```

`docs/backlog.md`: add under the roster "Done" entry one line:

```
- Done (2026-09-17): roster topology — `needs`/`produces` frontmatter, derived order in the Roster section, `topology` guard (nudge/enforce) on `subagent` with the `tests` check; config `guards.topology`; `configs/orch-pathnorm-27b-topology.json`. Spec `docs/superpowers/specs/2026-09-17-roster-topology-design.md`.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass; the "YAML-safe" test proves pi-subagents still loads the four shipped files after the body edits (the tester body contains a colon inside backticks and a `—`; both were already present before).

- [ ] **Step 5: Commit**

```bash
git add roster/tester.md roster/implementer.md configs/orch-pathnorm-27b-topology.json docs/backlog.md test/config.test.mjs
git commit -m "roster: test-first tester and implementer bodies; pathnorm topology config"
```

---

### Task 6: Dry run against a real workspace layout (no model)

**Files:**
- Test: `test/topology-dryrun.test.mjs`

**Interfaces:**
- Consumes: everything above.

This is the lesson from memtest (docs/batch/memtest.md: "dry-run host-side code agents cannot fix"): prove the exact sequence a run will take through the guard against files laid out the way `writeRosterDefinitions` and the tester will lay them out.

- [ ] **Step 1: Write the test**

Create `test/topology-dryrun.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { rosterSection } from "../lib/roster.mjs";
import { initialState, noteToolCall, decideSpawn } from "../lib/policies/topology-policy.mjs";

// The sequence the pathnorm topology run is expected to take, end to end through
// the pure policy with the real config and roster: implementer-first is nudged,
// tester passes, tests written + read lets the implementer through, a resume is
// never judged.
test("orch-pathnorm-27b-topology.json: the intended sequence passes and the wrong one is nudged exactly once", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const c = loadConfig({ configPath: path.join(here, "..", "configs", "orch-pathnorm-27b-topology.json"), env: { ...process.env, ARBITER_SKIP_MODEL_PREFLIGHT: "1" } });
	const needsFor = Object.fromEntries(c.workers.specialists.map((s) => [s.name, s.needs]));
	assert.deepEqual(needsFor, { tester: ["api"], implementer: ["api", "tests"] });
	assert.match(rosterSection(c.workers.specialists), /^Order for this roster: tester → implementer\.$/m);

	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "topology-dryrun-"));
	const files = () => {
		const dir = path.join(ws, "src", "__tests__");
		return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => ({ mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs })) : [];
	};
	const state = initialState();
	const mode = c.guards.topology.mode;
	const spawn = (subagent_type, extra = {}) => decideSpawn({ mode, needsFor, input: { subagent_type, description: "d", prompt: "brief", ...extra }, state, testsFiles: files() });

	assert.equal(spawn("implementer").event, "denied", "implementer before tests is nudged");
	assert.deepEqual(spawn("tester"), { ok: true, event: null }, "tester is never judged");
	fs.mkdirSync(path.join(ws, "src", "__tests__"), { recursive: true });
	fs.writeFileSync(path.join(ws, "src", "__tests__", "pathnorm.test.mjs"), "// tests\n");
	assert.equal(spawn("implementer").failed, "tests:unread", "written but not reviewed");
	noteToolCall({ toolName: "read", input: { path: "src/__tests__/pathnorm.test.mjs" } }, state, Date.now() + 1000);
	assert.deepEqual(spawn("implementer"), { ok: true, event: null }, "reviewed tests let the implementer through");
	assert.deepEqual(spawn("implementer", { resume: "abc" }), { ok: true, event: null }, "a resume is never judged");
});
```

Check the env key name for skipping model preflight with `grep -n "SKIP" lib/config.mjs` and use the exact name (the config tests' `SKIP` constant shows it).

- [ ] **Step 2: Run it**

Run: `node --test test/topology-dryrun.test.mjs`
Expected: PASS. If the `tests:unread` step fails because the file mtime and `Date.now()` are equal on a coarse clock, the `+ 1000` above covers it; do not weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add test/topology-dryrun.test.mjs
git commit -m "test: topology dry run through the real pathnorm config and roster"
```

---

## Self-review

**Spec coverage.** §1 frontmatter + cycle check → Task 1. §2 order + Roster section → Task 2. §3 guard: pure policy → Task 3; adapter, config, env, ordering → Task 4; skip line, nudge-once, enforce, read check, resume → Tasks 3 and 4 tests. §4 prompt bodies → Task 5. §5 accounting (three event kinds counted) → Task 4 (`workers.mjs` regex + test). §6 experiment config → Task 5; the runs and `docs/batch/roster-topology.md` happen after the plan, not in it.

**Placeholder scan.** Task 4's counter test names `newTracker`/`observe` as stand-ins for the identifiers in the neighbouring test; the step says to copy those exact identifiers, which the implementer must do. Task 6 names the preflight-skip env key by instruction. No TBDs.

**Type consistency.** `needs`/`produces` are `string[]` throughout. `decideSpawn` returns `{ ok, event, reason?, failed? }` with `event` ∈ `null | "denied" | "waived" | "skipped"`; the adapter and the dry run use those names. `CONFIG.guards.topology` is `null | { mode }` in config, supervisor env, and tests. `ARBITER_TOPOLOGY` JSON shape `{ mode, needs }` matches `optionsFromEnv`.
