# Roster and Specialist Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Specialists defined once in `roster/`, selected per run by name, each with its own `agent:<name>` memory scope it can search and append candidates to, with retention linking what it learned to the run and oracle result.

**Architecture:** A roster loader parses model-free agent definition files and renders them into the pi-subagents format the supervisor already installs. The config gains a `workers` block (legacy `roles.worker` maps onto the `worker` roster entry). Specialist memory is a new scope family in the existing record store, index, and tools; a `remember` tool writes host-mediated candidates to a run-local file that retention folds into `agent:<memory>` records. Observability labels worker lanes with the specialist type.

**Tech Stack:** Node ≥ 22 ESM (`.mjs`), tabs, `node:test` (`npm test` = `node --test "test/**/*.test.mjs"`), pi extensions in `.ts` under `ext/` driven through pi's tsx in tests (see `test/context-usage-ext.test.mjs` for the harness), SQLite FTS index in `lib/memory-index.mjs` (already present).

**Spec:** `docs/superpowers/specs/2026-09-16-roster-and-specialist-memory-design.md`

## Global Constraints

- No new dependencies. Tabs in `.mjs`/`.ts`. Every task's tests assert real values, never `assert.ok(true)`.
- Never stage anything under `memory/` (unrelated uncommitted edits live there). Tests never touch `memory/records.jsonl`; they use temp dirs (`memoryDir`-style paths or `os.tmpdir()`).
- Prefix stability: nothing added by this plan may inject text into a prompt after spawn. Roster sections, briefs, and definitions are computed once before the orchestrator process starts.
- `model:` is forbidden in roster files. Model/provider come only from the run config.
- Scope `agent:<name>` where `<name>` matches `/^[\w.-]+$/`, exactly like task/repo names.
- Candidates written by agents are `source: "agent"`, `status: "candidate"`, `claim: "unreviewed"`, `confidence: 0.4`, and are never included in any spawn brief; briefs use promoted records only.
- Every commit message ends with the two trailer lines:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QNstRa6QzP2vS2hgeYGo3F`.
- Existing configs keep working unchanged (legacy mapping); the existing pathnorm runs remain comparable to the control arm.

## File map

- Create `lib/roster.mjs` — parse/validate/render roster definitions; roster section text for the orchestrator prompt.
- Create `roster/worker.md`, `roster/scout.md`, `roster/implementer.md`, `roster/tester.md`.
- Modify `lib/config.mjs` — `workers` block, legacy mapping, per-override preflight; `agent:` accepted in `extraScopes`.
- Modify `lib/worker-def.mjs` — `writeRosterDefinitions()` alongside the existing writer (kept for one release, unused by the supervisor).
- Modify `prompts/orchestrator.md` — `{{ROSTER}}` placeholder for the subagent sentence.
- Modify `supervisor.mjs` — install selected specialists, roster section substitution, `type` on manifest records, remember file env, retention call.
- Modify `lib/worker-manifest.mjs` — `type` field in rows.
- Modify `lib/memory.mjs` — `validScope` accepts `agent:`; `retainSpecialists()`.
- Modify `lib/memory-index.mjs` — `status` filter in `search`.
- Modify `lib/memory-brief.mjs` — `seededBrief` accepts `status`.
- Modify `lib/wiki.mjs` — Agents section in INDEX; `recall` ordering includes `agent:`.
- Modify `lib/memory-tools.mjs` + `ext/memory-ext.ts` — `remember` tool.
- Modify `lib/patterns.mjs` — `remember` in `WORKER_TOOLS`.
- Modify `lib/context-trace.mjs`, `tools/context-trace.mjs`, `tools/kpi.mjs` — specialist type on spawns, `roster` column.
- Create `configs/orch-pathnorm-27b-roster.json`, `configs/orch-pathnorm-27b-roster-memory.json`, `configs/orch-lru-27b-roster-memory.json`.
- Tests: `test/roster.test.mjs`, `test/config.test.mjs` (extend), `test/worker-manifest.test.mjs` (extend), `test/memory.test.mjs` (extend), `test/memory-index.test.mjs` (extend), `test/memory-brief.test.mjs` (extend), `test/memory-tools.test.mjs` (extend), `test/memory-ext.test.mjs` (new, harness copy), `test/context-trace.test.mjs` (extend), `test/patterns-tools.test.mjs` (extend).

---

### Task 1: Roster loader and the four roster files

**Files:**
- Create: `lib/roster.mjs`, `test/roster.test.mjs`, `roster/worker.md`, `roster/scout.md`, `roster/implementer.md`, `roster/tester.md`

**Interfaces:**
- Produces:
  ```js
  export const ROSTER_TOOLS = ["read","bash","edit","write","ls","grep","find","memory_search","memory_get","recall_result","remember","report","context_usage"];
  export function parseRosterFile(file)            // -> { name, description, tools: string[], thinking: string|null, background: boolean, maxTurns: number, memory: string, body: string, file }
  export function loadRoster(dir)                  // -> Map<name, spec>; throws on a bad file naming the file and the problem
  export function selectSpecialists(roster, names) // -> spec[]; throws `unknown specialist "<n>" (roster has: a, b, c)` listing sorted names
  export function renderDefinition(spec, { provider, model, thinking, background, extraTools = [], promptSuffix = "" }) // -> string (.md with frontmatter in pi-subagents keys)
  export function rosterSection(specs)             // -> string for the orchestrator prompt
  ```

- [ ] **Step 1: Write the failing tests** (`test/roster.test.mjs`)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRosterFile, loadRoster, selectSpecialists, renderDefinition, rosterSection, ROSTER_TOOLS } from "../lib/roster.mjs";

function tmpRoster(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	return dir;
}
const TESTER = `---
name: tester
description: Writes and runs tests against the spec.
tools: read, bash, write, memory_search, remember
thinking: off
background: false
maxTurns: 40
memory: tester
---
You are TESTER.
`;

test("parseRosterFile reads frontmatter and body", () => {
	const dir = tmpRoster({ "tester.md": TESTER });
	const s = parseRosterFile(path.join(dir, "tester.md"));
	assert.equal(s.name, "tester");
	assert.equal(s.description, "Writes and runs tests against the spec.");
	assert.deepEqual(s.tools, ["read", "bash", "write", "memory_search", "remember"]);
	assert.equal(s.thinking, "off");
	assert.equal(s.background, false);
	assert.equal(s.maxTurns, 40);
	assert.equal(s.memory, "tester");
	assert.equal(s.body, "You are TESTER.");
});

test("defaults: memory = name, maxTurns 60, background false, thinking null", () => {
	const dir = tmpRoster({ "scout.md": "---\nname: scout\ndescription: Maps the repo.\ntools: read, ls\n---\nbody\n" });
	const s = parseRosterFile(path.join(dir, "scout.md"));
	assert.equal(s.memory, "scout");
	assert.equal(s.maxTurns, 60);
	assert.equal(s.background, false);
	assert.equal(s.thinking, null);
});

test("rejects model:, name/filename mismatch, unknown tool, missing description, bad thinking", () => {
	const dir = tmpRoster({
		"a.md": "---\nname: a\ndescription: x\ntools: read\nmodel: llama.cpp/qwen3-27b\n---\nb\n",
		"b.md": "---\nname: c\ndescription: x\ntools: read\n---\nb\n",
		"d.md": "---\nname: d\ndescription: x\ntools: read, teleport\n---\nb\n",
		"e.md": "---\nname: e\ntools: read\n---\nb\n",
		"f.md": "---\nname: f\ndescription: x\ntools: read\nthinking: max\n---\nb\n",
	});
	assert.throws(() => parseRosterFile(path.join(dir, "a.md")), /model: is not allowed/);
	assert.throws(() => parseRosterFile(path.join(dir, "b.md")), /name "c" does not match file "b"/);
	assert.throws(() => parseRosterFile(path.join(dir, "d.md")), /unknown tool "teleport"/);
	assert.throws(() => parseRosterFile(path.join(dir, "e.md")), /description is required/);
	assert.throws(() => parseRosterFile(path.join(dir, "f.md")), /thinking must be one of/);
});

test("loadRoster maps every .md in the dir; selectSpecialists keeps the requested order and names unknowns", () => {
	const dir = tmpRoster({ "tester.md": TESTER, "scout.md": "---\nname: scout\ndescription: Maps.\ntools: read\n---\nb\n" });
	const roster = loadRoster(dir);
	assert.deepEqual([...roster.keys()].sort(), ["scout", "tester"]);
	assert.deepEqual(selectSpecialists(roster, ["tester", "scout"]).map((s) => s.name), ["tester", "scout"]);
	assert.throws(() => selectSpecialists(roster, ["ghost"]), /unknown specialist "ghost" \(roster has: scout, tester\)/);
});

test("renderDefinition emits pi-subagents frontmatter with model from config, overrides applied, extra tools and suffix appended", () => {
	const dir = tmpRoster({ "tester.md": TESTER });
	const s = parseRosterFile(path.join(dir, "tester.md"));
	const md = renderDefinition(s, { provider: "llama.cpp", model: "qwen3-27b", thinking: "low", background: true, extraTools: ["report"], promptSuffix: "Call report once." });
	const lines = md.split("\n");
	assert.equal(lines[0], "---");
	assert.ok(lines.includes("name: tester"));
	assert.ok(lines.includes("description: Writes and runs tests against the spec."));
	assert.ok(lines.includes("tools: read,bash,write,memory_search,remember,report"));
	assert.ok(lines.includes("model: llama.cpp/qwen3-27b"));
	assert.ok(lines.includes("thinking: low"));
	assert.ok(lines.includes("max_turns: 40"));
	assert.ok(lines.includes("run_in_background: true"));
	assert.ok(md.endsWith("You are TESTER.\n\nCall report once.\n"));
	const md2 = renderDefinition(s, { provider: "p", model: "m" });
	assert.ok(md2.includes("thinking: off"), "roster thinking used when no override");
	assert.ok(md2.includes("run_in_background: false"));
	assert.ok(!md2.includes("report"));
});

test("rosterSection lists each specialist as `subagent_type` with its description, in order", () => {
	const dir = tmpRoster({ "tester.md": TESTER, "scout.md": "---\nname: scout\ndescription: Maps the repo.\ntools: read\n---\nb\n" });
	const roster = loadRoster(dir);
	const text = rosterSection(selectSpecialists(roster, ["scout", "tester"]));
	assert.match(text, /^- `subagent` \(subagent_type "scout"\): Maps the repo\./m);
	assert.match(text, /^- `subagent` \(subagent_type "tester"\): Writes and runs tests against the spec\./m);
	assert.ok(text.indexOf('"scout"') < text.indexOf('"tester"'));
	assert.match(text, /One worker runs at a time/);
});

test("ROSTER_TOOLS covers every tool the shipped roster files use, and the four shipped files parse", () => {
	const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	const roster = loadRoster(path.join(here, "..", "roster"));
	assert.deepEqual([...roster.keys()].sort(), ["implementer", "scout", "tester", "worker"]);
	for (const s of roster.values()) for (const t of s.tools) assert.ok(ROSTER_TOOLS.includes(t), `${s.name} uses ${t}`);
	assert.deepEqual(roster.get("scout").tools.filter((t) => ["bash", "edit", "write"].includes(t)), [], "scout is read-only");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/roster.test.mjs` → FAIL (`Cannot find module '../lib/roster.mjs'`).

- [ ] **Step 3: Implement `lib/roster.mjs`**

```js
// Roster: specialists defined once in roster/<name>.md and selected per run by name.
// Files are pi-subagents agent definitions minus the model line: model/provider come
// from the run config (lib/config.mjs `workers`), so one roster serves local and cloud.
import fs from "node:fs";
import path from "node:path";
import { WORKER_THINKING_LEVELS } from "./config.mjs";

export const ROSTER_TOOLS = ["read", "bash", "edit", "write", "ls", "grep", "find", "memory_search", "memory_get", "recall_result", "remember", "report", "context_usage"];
const NAME_RE = /^[\w.-]+$/;

function parseFrontmatter(text, file) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) throw new Error(`${file}: roster file must start with a --- frontmatter block`);
	const fields = {};
	for (const raw of m[1].split(/\r?\n/)) {
		const line = raw.replace(/\s+#.*$/, "").trim();
		if (!line) continue;
		const i = line.indexOf(":");
		if (i < 0) throw new Error(`${file}: bad frontmatter line ${JSON.stringify(raw)}`);
		fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fields, body: m[2].trim() };
}

export function parseRosterFile(file) {
	const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"), file);
	const stem = path.basename(file, ".md");
	if ("model" in fields) throw new Error(`${file}: model: is not allowed in a roster file (the run config supplies provider/model)`);
	const name = fields.name ?? "";
	if (!NAME_RE.test(name)) throw new Error(`${file}: name must match ${NAME_RE}, got ${JSON.stringify(name)}`);
	if (name !== stem) throw new Error(`${file}: name "${name}" does not match file "${stem}"`);
	const description = (fields.description ?? "").trim();
	if (!description) throw new Error(`${file}: description is required`);
	const tools = (fields.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
	if (!tools.length) throw new Error(`${file}: tools is required`);
	for (const t of tools) if (!ROSTER_TOOLS.includes(t)) throw new Error(`${file}: unknown tool "${t}" (known: ${ROSTER_TOOLS.join(", ")})`);
	const thinking = fields.thinking ? fields.thinking : null;
	if (thinking && !WORKER_THINKING_LEVELS.includes(thinking)) throw new Error(`${file}: thinking must be one of ${WORKER_THINKING_LEVELS.join(", ")}, got ${JSON.stringify(thinking)}`);
	const background = fields.background === undefined ? false : fields.background === "true";
	const maxTurns = fields.maxTurns === undefined ? 60 : Number(fields.maxTurns);
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`${file}: maxTurns must be a positive integer`);
	const memory = fields.memory ? fields.memory : name;
	if (!NAME_RE.test(memory)) throw new Error(`${file}: memory must match ${NAME_RE}`);
	if (!body) throw new Error(`${file}: prompt body is empty`);
	return { name, description, tools, thinking, background, maxTurns, memory, body, file };
}

export function loadRoster(dir) {
	const out = new Map();
	if (!fs.existsSync(dir)) throw new Error(`roster directory not found: ${dir}`);
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
		const spec = parseRosterFile(path.join(dir, f));
		out.set(spec.name, spec);
	}
	return out;
}

export function selectSpecialists(roster, names) {
	return names.map((n) => {
		const spec = roster.get(n);
		if (!spec) throw new Error(`unknown specialist "${n}" (roster has: ${[...roster.keys()].sort().join(", ")})`);
		return spec;
	});
}

export function renderDefinition(spec, { provider, model, thinking, background, extraTools = [], promptSuffix = "" }) {
	const level = thinking ?? spec.thinking;
	const bg = background ?? spec.background;
	const tools = [...spec.tools, ...extraTools.filter((t) => !spec.tools.includes(t))];
	return [
		"---",
		`name: ${spec.name}`,
		`description: ${spec.description}`,
		`tools: ${tools.join(",")}`,
		`model: ${provider}/${model}`,
		...(level ? [`thinking: ${level}`] : []),
		`max_turns: ${spec.maxTurns}`,
		`run_in_background: ${bg}`,
		"---",
		spec.body,
		...(promptSuffix ? ["", promptSuffix.trim()] : []),
		"",
	].join("\n");
}

export function rosterSection(specs) {
	const lines = specs.map((s) => `- \`subagent\` (subagent_type "${s.name}"): ${s.description}`);
	return [
		...lines,
		"  Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
}
```

Note: `lib/config.mjs` must not import `lib/roster.mjs` at module top level or you get a cycle; Task 2 imports it lazily inside `loadConfig` via a function-level `await import` is not possible in a sync function, so Task 2 passes the roster dir and uses `loadRoster` imported at top of `config.mjs` — to avoid the cycle, move `THINKING_LEVELS`/`WORKER_THINKING_LEVELS` into `lib/thinking-levels.mjs` in this task and re-export them from `config.mjs`:

```js
// lib/thinking-levels.mjs
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WORKER_THINKING_LEVELS = THINKING_LEVELS.filter((l) => l !== "max");
```
In `lib/config.mjs` replace the two `export const` lines with `export { THINKING_LEVELS, WORKER_THINKING_LEVELS } from "./thinking-levels.mjs"; import { THINKING_LEVELS, WORKER_THINKING_LEVELS } from "./thinking-levels.mjs";` and in `lib/roster.mjs` import from `./thinking-levels.mjs`.

- [ ] **Step 4: Write the four roster files**

`roster/worker.md`: frontmatter `name: worker`, `description: Builds one piece of the task from the orchestrator's brief.`, `tools: read, bash, edit, write, ls, grep, find, memory_search, memory_get, recall_result, remember`, `background: false`, `maxTurns: 60`, then the body = the full text of `prompts/worker.md` (copy verbatim; keep `prompts/worker.md` in place because `resolveWorkerPrompt` still reads it for task-local overrides).

`roster/scout.md`:
```
---
name: scout
description: Read-only. Maps the workspace and the brief's obligations before anyone edits: files, exports, gaps, and the concrete checks a tester would run. Cheap; call first.
tools: read, ls, grep, find, memory_search, memory_get, remember
thinking: off
background: false
maxTurns: 25
memory: scout
---
You are SCOUT. You never edit files. Read README.md and everything under `src/`, then answer the brief with a map, not prose:

1. FILES: each file under `src/` with its exported names and one line on what it does.
2. OBLIGATIONS: every requirement you can extract from the brief and README as a numbered list; mark each `present`, `stubbed`, or `missing` after reading the code.
3. RISKS: edge cases the requirements imply (empty input, ordering, error types) that the code does not visibly handle.
4. CHECKS: 3–8 concrete probe inputs with expected outputs that would prove the obligations, in the form `fn(args) -> expected`.

Keep the whole answer under 60 lines. If memory search returns a promoted record for this task class, cite its id next to the obligation it informs. Use `remember` at most twice, only for something a future scout on a similar task would need (a convention of this repo, a trap in the spec wording), phrased as a claim with the file that shows it.
```

`roster/implementer.md`: same frontmatter shape, `description: Implements one piece under src/ from the orchestrator's brief, testing it locally before reporting.`, `tools: read, bash, edit, write, ls, grep, find, memory_search, memory_get, recall_result, remember`, `thinking: off`, `maxTurns: 60`, body = `prompts/worker.md` text with this paragraph appended: `If the brief includes a scout's map, trust its FILES and OBLIGATIONS sections and go straight to the missing/stubbed items; do not re-read files the map already describes unless you edit them.` and `Use \`remember\` at most three times, for a lesson about implementing this kind of module (a Node API quirk, a test pattern that caught a bug), never for task-specific facts.`

`roster/tester.md`:
```
---
name: tester
description: Independent tester. Writes and runs a test file against the brief's obligations without reading any other worker's transcript, and reports failures with file:line evidence.
tools: read, bash, write, ls, grep, find, memory_search, memory_get, remember
thinking: off
background: false
maxTurns: 40
memory: tester
---
You are TESTER. You are independent: you have not seen how the code was written and you must not ask. Read README.md and `src/`, derive the obligations from the brief, and write `src/__tests__/<module>.test.mjs` using `node:test` and `node:assert/strict` (create the directory if needed; nothing else outside it). Cover every obligation with at least one assertion of a concrete value, plus the edge cases the brief implies (empty input, invalid input, ordering). Run `node --test src/__tests__/` and report:
- status: done when every test passes, partial when some fail (list each failing test with the assertion message and the `src/` line it points at), blocked when the module cannot be imported.
- findings: one per failing obligation, labelled observed, with the exact input and the actual vs expected output.
Never edit files outside `src/__tests__/`. Use `remember` at most twice, for a testing lesson that transfers to other modules of this kind (an assertion pattern, a node:test pitfall), not for this task's specifics.
```

- [ ] **Step 5: Run tests** — `node --test test/roster.test.mjs` → all pass; then `npm test` → all pass (config tests still pass after the thinking-levels move).

- [ ] **Step 6: Commit** — `git add lib/roster.mjs lib/thinking-levels.mjs lib/config.mjs roster/ test/roster.test.mjs && git commit -m "roster: specialist definitions, loader, renderer, prompt section"` (+ trailers).

---

### Task 2: `workers` config block with legacy mapping and preflight

**Files:**
- Modify: `lib/config.mjs` (the roles loop around lines 40–58 and the preflight block that follows), `test/config.test.mjs`

**Interfaces:**
- Consumes: `loadRoster`, `selectSpecialists` from `lib/roster.mjs`.
- Produces on the returned config: `config.workers = { default: { provider, model, thinking? }, use: string[], overrides: { [name]: { provider?, model?, thinking?, background? } }, max: number, specialists: spec[] }` for the orchestrator pattern; `null` for other patterns. `roles.worker` is still populated (from `workers.default` + `max`) so existing supervisor code keeps working until Task 3 switches over. `loadConfig` accepts a new option `rosterDir` (default `<repo>/roster`).

- [ ] **Step 1: Failing tests** (append to `test/config.test.mjs`; reuse its `SKIP` env constant and temp-config helper; add a temp roster helper writing `worker.md` and `tester.md` minimal files)

```js
test("workers block: selects specialists, applies overrides, resolves roles.worker for compatibility", () => {
	const roster = tmpRosterDir(); // writes worker.md and tester.md
	const cfg = writeConfig({ task: "glob", pattern: "orchestrator",
		roles: { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" } },
		workers: { default: { provider: "llama.cpp", model: "qwen3-27b", thinking: "off" }, use: ["tester", "worker"], overrides: { tester: { thinking: "low" } }, max: 2 } });
	const c = loadConfig({ configPath: cfg, env: SKIP, rosterDir: roster });
	assert.deepEqual(c.workers.use, ["tester", "worker"]);
	assert.equal(c.workers.max, 2);
	assert.deepEqual(c.workers.specialists.map((s) => s.name), ["tester", "worker"]);
	assert.equal(c.workers.overrides.tester.thinking, "low");
	assert.deepEqual(c.roles.worker, { provider: "llama.cpp", model: "qwen3-27b", thinking: "off", max: 2, background: false, contextWindow: null });
});

test("legacy roles.worker maps to workers.use = [\"worker\"]", () => {
	const roster = tmpRosterDir();
	const cfg = writeConfig({ task: "glob", pattern: "orchestrator",
		roles: { orchestrator: { provider: "p", model: "m" }, worker: { provider: "p", model: "m", max: 1, thinking: "off", background: true } } });
	const c = loadConfig({ configPath: cfg, env: SKIP, rosterDir: roster });
	assert.deepEqual(c.workers.use, ["worker"]);
	assert.equal(c.workers.default.thinking, "off");
	assert.equal(c.workers.overrides.worker.background, true);
	assert.equal(c.workers.max, 1);
});

test("workers.use naming an unknown specialist fails with the roster listing; both blocks at once is an error; dyad has workers null", () => {
	const roster = tmpRosterDir();
	assert.throws(() => loadConfig({ configPath: writeConfig({ task: "glob", pattern: "orchestrator", roles: { orchestrator: { provider: "p", model: "m" } }, workers: { default: { provider: "p", model: "m" }, use: ["ghost"] } }), env: SKIP, rosterDir: roster }), /unknown specialist "ghost" \(roster has: tester, worker\)/);
	assert.throws(() => loadConfig({ configPath: writeConfig({ task: "glob", pattern: "orchestrator", roles: { orchestrator: { provider: "p", model: "m" }, worker: { provider: "p", model: "m" } }, workers: { default: { provider: "p", model: "m" }, use: ["worker"] } }), env: SKIP, rosterDir: roster }), /roles\.worker and workers cannot both be set/);
	const d = loadConfig({ configPath: writeConfig({ task: "glob", pattern: "dyad", roles: { builder: { provider: "p", model: "m" }, critic: { provider: "p", model: "m" } } }), env: SKIP, rosterDir: roster });
	assert.equal(d.workers, null);
});

test("workers overrides go through model preflight", () => {
	// point ARBITER_MODEL_STORE at a temp store listing only p/m; override names p/zzz → throws naming roles.workers.tester
	...assert.throws(/model preflight: roles\.workers\.tester names "p\/zzz"/)
});
```

- [ ] **Step 2: Run** — FAIL (`workers` undefined / no rosterDir option).

- [ ] **Step 3: Implement in `lib/config.mjs`**

Inside `loadConfig({ configPath, env = process.env, rosterDir })`: default `rosterDir = path.join(here, "..", "roster")`. In the roles loop, when `name === "worker"`: if `raw.workers` is set and `raw.roles?.worker` is also set → throw `roles.worker and workers cannot both be set in ${configPath}`. Build `workersRaw`:
```js
const workersRaw = raw.workers ?? (r ? { default: { provider: r.provider, model: r.model, ...(r.thinking != null ? { thinking: r.thinking } : {}) }, use: ["worker"], overrides: { worker: { ...(r.background != null ? { background: Boolean(r.background) } : {}) } }, max: r.max ?? 1 } : null);
if (!workersRaw) throw new Error(`pattern "${pattern}" requires role "worker" or a workers block (missing in ${configPath})`);
```
Then `provider`/`model` for the worker role come from `workersRaw.default` (env overrides `ROLE_worker_PROVIDER/MODEL` still apply), thinking validated with `WORKER_THINKING_LEVELS`, `roles.worker.max = Number(workersRaw.max ?? 1)`, `roles.worker.background = Boolean(workersRaw.overrides?.worker?.background ?? false)`. After the loop, for the orchestrator pattern:
```js
const roster = loadRoster(rosterDir);
const use = Array.isArray(workersRaw.use) && workersRaw.use.length ? workersRaw.use.map(String) : ["worker"];
const specialists = selectSpecialists(roster, use);
const overrides = {};
for (const [n, o] of Object.entries(workersRaw.overrides ?? {})) {
	if (!use.includes(n)) throw new Error(`workers.overrides.${n} is not in workers.use in ${configPath}`);
	overrides[n] = {};
	if (o.provider) overrides[n].provider = String(o.provider);
	if (o.model) overrides[n].model = String(o.model);
	if (o.thinking != null) { if (!WORKER_THINKING_LEVELS.includes(o.thinking)) throw new Error(`workers.overrides.${n}.thinking must be one of ${WORKER_THINKING_LEVELS.join(", ")}`); overrides[n].thinking = o.thinking; }
	if (o.background != null) overrides[n].background = Boolean(o.background);
}
workers = { default: { ...roles.worker }, use, overrides, max: roles.worker.max, specialists };
delete workers.default.max; delete workers.default.background; delete workers.default.contextWindow;
```
Preflight: extend `preflightRoles` input with pseudo-roles `workers.<name>` for every override that sets provider or model (`{ provider: o.provider ?? default.provider, model: o.model ?? default.model }`); the error line already names the role key, so the message reads `roles.workers.tester names "p/zzz"`. Return `workers` on the config (`null` for non-orchestrator patterns). Keep the existing `preflight` field behaviour.

- [ ] **Step 4: Run** — `node --test test/config.test.mjs` pass; `npm test` pass.
- [ ] **Step 5: Commit** — `config: workers block (roster selection, overrides, legacy roles.worker mapping)`.

---

### Task 3: Install selected specialists and the orchestrator roster section

**Files:**
- Modify: `lib/worker-def.mjs` (add `writeRosterDefinitions`), `prompts/orchestrator.md:5`, `supervisor.mjs` (install block ~1452–1471; prompt assembly ~170–178; manifest appends), `lib/worker-manifest.mjs` (`type` in rows), `test/worker-manifest.test.mjs`, new `test/worker-def.test.mjs`

**Interfaces:**
- Produces: `writeRosterDefinitions(workspaceDir, { specialists, workers, extraTools, promptSuffixFor })` in `lib/worker-def.mjs` → `{ files: string[] }`; writes `<ws>/.pi/agents/<name>.md` for each and `<ws>/.pi/subagents.json` `{ maxConcurrent }`. `promptSuffixFor(spec)` returns the memory excerpt + report instruction text for that spec (the generic `worker` keeps `resolveWorkerPrompt`'s task-local override: when `spec.name === "worker"` and `tasks/<task>/worker.md` exists, its text replaces `spec.body`).
- Manifest `created`/`started` records gain `type` (the lifecycle `data.type`); `manifestJoin` rows gain `type` (default `null`).
- `prompts/orchestrator.md` line 5 becomes the single line `{{ROSTER}}`; the supervisor replaces it with `rosterSection(specialists)` before writing the system prompt. Legacy `use: ["worker"]` renders the same sentence as today (roster/worker.md's description is the old description).

- [ ] **Step 1: Failing tests** — `test/worker-def.test.mjs`: temp workspace + two parsed specs (from a temp roster) → `writeRosterDefinitions` writes both files with `model: p/m`, `subagents.json` has `maxConcurrent: 2`, the `worker` spec's body is replaced by a temp `taskDir/worker.md` when provided, and `promptSuffixFor` text is appended to both. `test/worker-manifest.test.mjs`: a `created` record with `type: "tester"` folds to `row.type === "tester"`; a row without it has `type: null`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

`lib/worker-def.mjs`:
```js
import { renderDefinition } from "./roster.mjs";
export function writeRosterDefinitions(workspaceDir, { specialists, workers, extraTools = [], promptSuffixFor = () => "", taskDir = null }) {
	const dir = path.join(workspaceDir, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const files = [];
	for (const spec of specialists) {
		const o = workers.overrides?.[spec.name] ?? {};
		let body = spec.body;
		const own = taskDir ? path.join(taskDir, "worker.md") : null;
		if (spec.name === "worker" && own && fs.existsSync(own)) body = fs.readFileSync(own, "utf8").trimEnd();
		const md = renderDefinition({ ...spec, body }, { provider: o.provider ?? workers.default.provider, model: o.model ?? workers.default.model, thinking: o.thinking ?? workers.default.thinking ?? null, background: o.background, extraTools, promptSuffix: promptSuffixFor(spec) });
		const file = path.join(dir, `${spec.name}.md`);
		fs.writeFileSync(file, md);
		files.push(file);
	}
	fs.writeFileSync(path.join(workspaceDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: workers.max ?? 1 }));
	return { files };
}
```
`supervisor.mjs` install block: replace the `resolveWorkerPrompt` + `writeWorkerDefinition` calls with:
```js
const suffix = resolveWorkerPrompt({ taskDir: TASK, home: here, memoryText: MEMORY_TEXT, report: Boolean(CONFIG.report) }); // keep for its appended memory/report text: use suffix.prompt minus its base body → expose a new export `workerPromptSuffix({ memoryText, report })` in worker-def.mjs returning just the appended part, and use that here
const { files } = writeRosterDefinitions(WS.workspace, { specialists: CONFIG.workers.specialists, workers: CONFIG.workers, extraTools: CONFIG.report ? ["report"] : [], promptSuffixFor: () => workerPromptSuffix({ memoryText: MEMORY_TEXT, report: Boolean(CONFIG.report) }), taskDir: TASK });
log({ type: "worker_prompt", msg: `roster: ${CONFIG.workers.use.join(", ")} (${files.length} definitions)${MEMORY_TEXT ? " + memory excerpt" : ""}` });
```
Prompt assembly (the `prompts[role]` loop): after reading `base` for `orchestrator`, `base = base.replace("{{ROSTER}}", rosterSection(CONFIG.workers.specialists))`; throw if the placeholder is missing. Manifest: in the lifecycle handler pass `type: data.type ?? null` on `created` and `started` records; in `lib/worker-manifest.mjs` `manifestJoin` set `row.type = record.type ?? row.type ?? null` on those. `summary.json` already embeds `config`; make sure `CONFIG.workers` minus `specialists` is what gets written (strip the parsed specs: `{ ...CONFIG, workers: CONFIG.workers && { default, use, overrides, max } }`).

- [ ] **Step 4: Run** — `node --check supervisor.mjs`; `npm test`; then a 30-second dry check: `node -e "import('./lib/config.mjs').then(m=>console.log(m.loadConfig({configPath:'configs/orch-pathnorm-27b.json',env:process.env}).workers.use))"` prints `[ 'worker' ]`.
- [ ] **Step 5: Commit** — `supervisor: install roster specialists; orchestrator roster section; manifest type`.

---

### Task 4: `agent:<name>` scopes across the memory system

**Files:**
- Modify: `lib/memory.mjs` (`validScope`, error text), `lib/config.mjs` (`extraScopes` regex), `lib/wiki.mjs` (INDEX "Agents" section at ~258; `recall` order at ~285), `lib/memory-index.mjs` (`search` gains `status` filter), `lib/memory-brief.mjs` (`seededBrief` passes `status`), `supervisor.mjs` (`MEMORY_SCOPES` adds `agent:<memory>` for every selected specialist), tests in `test/memory.test.mjs`, `test/memory-index.test.mjs`, `test/memory-brief.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- `validScope("agent:tester") === true`; `makeRecord({ scope: "agent:tester", ... })` works.
- `search(indexFile, { query, scopes, snapshot, limit, kinds, claim, status })` — when `status` is `"promoted"` only promoted rows return.
- `seededBrief({ ..., status })` forwards it.
- `recall` orders `repo:`, `task:`, `agent:`, `global`; INDEX has an "Agents" section listing `agent:` scopes.

- [ ] **Step 1: Failing tests** — `makeRecord` accepts `agent:scout` and rejects `agent:` / `agent:bad name`; `search` with `status: "promoted"` on a temp index with one candidate and one promoted record in `agent:scout` returns only the promoted one; `seededBrief` with `status: "promoted"` includes only its id; `recall` with scopes `["global","agent:scout"]` includes the agent page text; `loadConfig` accepts `memory.extraScopes: ["agent:scout"]`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `validScope`: `/^(task|repo|agent):[\w.-]+$/`, error message lists `"agent:<name>"`; `config.mjs` extraScopes regex the same; `memory-index.mjs` `search`: add `if (status) { where.push("status = ?"); args.push(status); }` next to the kinds/claim filters (read the function first; the row set already carries `status`); `memory-brief.mjs`: pass `status` through to `search`; `wiki.mjs`: add `...section("Agents", scopes.filter((s) => s.startsWith("agent:")).map(indexLine))` after Tasks, and in `recall` insert `...scopes.filter((s) => s.startsWith("agent:"))` before global; `supervisor.mjs`: `const SPECIALIST_SCOPES = (CONFIG.workers?.specialists ?? []).map((s) => \`agent:${s.memory}\`)` and add them to `MEMORY_SCOPES` (dedupe; note in a comment that all workers share the union in this slice, and search rows show scope so a tester can tell a scout's record).
- [ ] **Step 4: Run** — `npm test`.
- [ ] **Step 5: Commit** — `memory: agent:<name> scopes (validation, index status filter, wiki, recall, run scopes)`.

---

### Task 5: `remember` tool (host-mediated candidates)

**Files:**
- Modify: `lib/memory-tools.mjs` (add `rememberTool`), `ext/memory-ext.ts` (register `remember` when `ARBITER_REMEMBER_FILE` is set), `lib/patterns.mjs` (`remember` in `WORKER_TOOLS`), `supervisor.mjs` (env `ARBITER_REMEMBER_FILE: path.join(RUN, "remember.jsonl")`), tests: `test/memory-tools.test.mjs` (extend), new `test/memory-ext.test.mjs` (copy the harness from `test/context-usage-ext.test.mjs`), `test/patterns-tools.test.mjs` (extend)

**Interfaces:**
- `rememberTool(cfg, params, role, state)` where `cfg.rememberFile` is the path, `params = { text, evidence_refs?: string[] }`, `state` is a per-process `Map<role, count>`; appends `{ ts, role, text, evidence_refs, chars }` as one JSON line; returns `{ text: "remembered as a candidate for review (<n> of 5 this run)", refused: false }`; the 6th call per role returns `{ refused: true, text: "remember limit reached (5 per worker run); put further lessons in your report" }` and writes nothing. Text must be 20–600 chars after trim, else refused with the reason. Each accepted call is charged `text.length` to the budget ledger like `memory_get` (reuse the existing charge helper).
- Lifecycle event `memory:remember` (`{ chars, detail: first 80 chars }`) or `memory:refused`.

- [ ] **Step 1: Failing tests** — policy: 5 accepted then refused; short text refused; file has 5 lines with `role`; ext harness: after a fake `ARBITER_REMEMBER_FILE` env the fake `pi.registerTool` collector has `remember`, executing it writes the line and the lifecycle file has `memory:remember`; `test/patterns-tools.test.mjs`: `WORKER_TOOLS` includes `remember`, `ORCHESTRATOR_TOOLS` does not.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — follow the shapes above; in `ext/memory-ext.ts` register the tool only when `process.env.ARBITER_REMEMBER_FILE` is set and `kit.roleFor(ctx)` starts with `worker` (an orchestrator call returns refused text "remember is for workers"). Description: "Save one lesson for future workers of your kind, as a candidate a human will review. Say what you learned, where the evidence is (file, test, command), and when it applies. Not for task-specific facts."
- [ ] **Step 4: Run** — `npm test`.
- [ ] **Step 5: Commit** — `memory: remember tool — worker candidates to a run-local file`.

---

### Task 6: Retention for specialists

**Files:**
- Modify: `lib/memory.mjs` (add `retainSpecialists`), `supervisor.mjs` (finish: read `remember.jsonl` and the manifest, call it, append), `test/memory.test.mjs`

**Interfaces:**
```js
export function retainSpecialists({ runId, task, passed, oracleN, remembers, manifestRows, specialists, ts = Date.now() })
// remembers: [{ ts, role: "worker:<sessionId>", text, evidence_refs }]
// manifestRows: values of manifestJoin() ({ wid, sessionId, type, status, outcome, description })
// specialists: [{ name, memory }]
// -> records[]
```
Rules: for each remember entry, find the manifest row whose `sessionId` equals the role's session id (`role.slice("worker:".length)`), map `row.type` → specialist → `scope = agent:<memory>`; unknown type or no row → scope `task:<task>` with evidence `unresolved_worker:<sessionId>` (never dropped silently). Record: `kind: "semantic"`, `claim: "unreviewed"`, `source: "agent"`, `confidence: 0.4`, `status: "candidate"`, `evidence: ["run:<runId>", "from_agent:<memory>", "worker:<sessionId>", ...evidence_refs]`, `text`, `summary` auto. For each specialist type that has at least one manifest row: one `procedural` record in `agent:<memory>`: text `"<name> ran on <task> (<k> spawn(s): <descriptions joined by ' | ', each first sentence>) — run <passed|failed>"`, `source: "supervisor"`, `confidence: passed ? 0.7 : 0.4`, evidence `["run:<runId>", ...(passed && oracleN ? ["oracle:<runId>#<oracleN>"] : []), "applies_to:task:<task>"]` (so a passing run's record is host-vouched and promotes automatically per `makeRecord`).

- [ ] **Step 1: Failing tests** — two remembers (one from a tester session, one from an unknown session) + rows → one `agent:tester` candidate with the right evidence and one `task:x` record with `unresolved_worker:`; procedural record per type with promoted status when passed and oracle given, candidate when failed; no rows → no procedural records.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** as specified; wire in `supervisor.mjs` finish next to `retainFromRun`: `const remembers = readJsonl(path.join(RUN, "remember.jsonl")); const rows = [...manifestJoin(readManifest(RUN)).values()]; appendLog(MEMORY.log, retainSpecialists({ runId, task: TASK_NAME, passed: String(summary.reason).startsWith("SUCCESS"), oracleN: lastOracleResult?.n ?? null, remembers, manifestRows: rows, specialists: CONFIG.workers?.specialists ?? [] }));` (guard with try/catch + warn log like the manifest appends). Also record `summary.memory.remembers = remembers.length`.
- [ ] **Step 4: Run** — `npm test`; `node --check supervisor.mjs`.
- [ ] **Step 5: Commit** — `memory: retain specialist candidates and per-specialist procedural records`.

---

### Task 7: Observability — specialist type in trace, CLI, kpi

**Files:**
- Modify: `lib/context-trace.mjs` (spawn object gains `type` from the lifecycle `created`/`started` `data.type`), `tools/context-trace.mjs` (agent header prints `[<type>]` after the id when present), `tools/kpi.mjs` (`roster` column: `summary.config.workers?.use?.join(",") ?? "worker"`), tests `test/context-trace.test.mjs`, `test/context-trace-cli.test.mjs`

- [ ] **Step 1: Failing tests** — fixture worker `spawn.type === "worker"`; temp-dir run with `started` `type: "tester"` → `spawn.type === "tester"`; CLI header line contains `[tester]` for that temp run; kpi: since kpi.mjs is script-only, extract `rosterLabel(summary)` into `lib/usage.mjs` and test `{config:{workers:{use:["scout","tester"]}}} → "scout,tester"`, `{config:{roles:{worker:{}}}} → "worker"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `npm test`.**
- [ ] **Step 5: Commit** — `trace/kpi: specialist type on spawns; roster column`.

---

### Task 8: Experiment configs and the batch

**Files:**
- Create: `configs/orch-pathnorm-27b-roster.json`, `configs/orch-pathnorm-27b-roster-memory.json`, `configs/orch-lru-27b-roster-memory.json`

Contents:
```json
{ "task": "pathnorm", "pattern": "orchestrator", "report": true,
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" } },
  "workers": { "default": { "provider": "llama.cpp", "model": "qwen3-27b", "thinking": "off" }, "use": ["scout", "implementer", "tester"], "max": 1 },
  "caps": { "toolCalls": 250, "wallSec": 1800, "usd": 5, "doneAttempts": 5 },
  "_note": "Roster arm (2026-09-16): scout → implementer → tester, no memory tools. Pair with configs/orch-pathnorm-27b.json (legacy single worker = control)." }
```
`-memory` variants add `"memory": { "mode": "search", "budgetChars": 2000, "retrievalChars": 6000, "workerReserveChars": 3000 }` (which turns on `memory_search`/`memory_get`/`remember`). The lru variant is the same with `"task": "lru"`.

- [ ] **Step 1:** Validate each with `node -e "import('./lib/config.mjs').then(m=>console.log(m.loadConfig({configPath:'configs/<f>',env:process.env}).workers.use))"`.
- [ ] **Step 2: Commit** — `configs: roster and roster+memory arms for pathnorm and lru`.

The batch itself (`node tools/batch.mjs roster-pathnorm configs/orch-pathnorm-27b.json configs/orch-pathnorm-27b-roster.json configs/orch-pathnorm-27b-roster-memory.json`, then human promotion of useful candidates with `tools/verdict.mjs`, then `node tools/batch.mjs roster-lru configs/orch-lru-27b-roster-memory.json`) is run by the controller after the plan lands, not by a task.

---

## Self-review

- Spec §1 roster folder → Task 1. §2 config → Task 2. §3 installation and orchestrator view → Task 3. §4 specialist memory (scopes, remember, retention, promoted-only briefs) → Tasks 4, 5, 6; the promoted-only brief for specialists is the `status: "promoted"` filter in Task 4 used by the supervisor's seeded brief when `MEMORY_MODE === "search"` (Task 4 step 3 must also change the `seededBrief` call in `supervisor.mjs` to pass `status: "promoted"` when specialists are present). §5 observability → Tasks 3 (manifest type) and 7. §6 experiment → Task 8 plus the controller's batch. Slices 2–3 are out of scope by design.
- Names used consistently: `loadRoster`, `selectSpecialists`, `renderDefinition`, `rosterSection`, `writeRosterDefinitions`, `workerPromptSuffix`, `retainSpecialists`, `rememberTool`, `rosterLabel`, `config.workers.{default,use,overrides,max,specialists}`, manifest `type`, trace `spawn.type`.
- Cycle guard: `lib/roster.mjs` imports thinking levels from `lib/thinking-levels.mjs`, never from `lib/config.mjs`.
