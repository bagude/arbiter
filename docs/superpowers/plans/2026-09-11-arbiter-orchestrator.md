# Arbiter Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalise the `duo` harness into `arbiter` (run configs with patterns and roles) and add an orchestrator–workers pattern whose workers run as `@gotgenes/pi-subagents` children while the model-free supervisor keeps observing everything and gating the result.

**Architecture:** `supervisor.mjs` stays an external Node process driving pi over `--mode rpc`; its intricate logic (config, gate, routing, per-agent state, session-transcript adaptation) moves into small pure modules under `lib/` with `node:test` coverage. For the orchestrator pattern the supervisor launches one pi agent with the pi-subagents extension plus two Arbiter extensions (`ext/mail-ext.ts` for `probe`/`done`, `ext/subagents-bridge.ts` forwarding lifecycle events to a file), tails the children's persisted session transcripts, and applies the existing hash+quiescence gate to the shared workspace.

**Tech Stack:** Node 26 ESM (`.mjs`), `node:test` + `node:assert/strict`, pi coding agent at `C:\Users\user\open_harnessess\pi\pi` (run through its bundled `tsx`), `@gotgenes/pi-subagents` 21.7.0, llama.cpp router at `http://127.0.0.1:8080` serving `qwen3-27b` (and `qwen3-flash` via `models.ini`).

**Spec:** `docs/superpowers/specs/2026-09-11-arbiter-orchestrator-design.md`

## Global Constraints

- Role asymmetry is enforced by tool grants, never by prompt (spec §3).
- The oracle and the hash+quiescence gate run in the supervisor process; no model decides acceptance (spec §1, §4).
- `@gotgenes/pi-subagents` is pinned to `21.7.0`; the substrate smoke test (Task 9) must pass on every pi bump (spec §7).
- Dyad and solo patterns keep their current behaviour exactly (spec §2).
- `DUO_*` environment variables are removed, not aliased (spec §2).
- All new logic that can be pure lives in `lib/` with tests; the supervisor only wires (spec §7).
- Probe values, worker reports and briefs delivered into any model context are capped at 1500 characters; full text stays in the run's files (spec §4).
- Every file written by tasks uses tabs for indentation in `.mjs`/`.ts` (matches `supervisor.mjs`) and LF line endings.
- Commits: `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit ...` until the user configures a global identity; commit messages end with the two attribution lines used in the initial commit.
- Paths: after Task 1 the project root is `C:\Users\user\open_harnessess\pi\arbiter`; every path below is relative to it unless absolute. pi's repo is `C:\Users\user\open_harnessess\pi\pi` (referred to as `<PI>`); `<TSX>` = `<PI>\node_modules\tsx\dist\cli.mjs`; `<CLI>` = `<PI>\packages\coding-agent\src\cli.ts`.

---

## File structure

```
arbiter/
  package.json                    project manifest; pins @gotgenes/pi-subagents; `npm test`
  arbiter.json                    default run config (dyad, glob, local Qwen) — today's behaviour
  configs/                        one file per planned run (Task 15)
  supervisor.mjs                  wiring only: launch, RPC I/O, timers, finish
  lib/text.mjs                    truncateForMail, PROBE_VALUE_MAX
  lib/gate.mjs                    decideApproval() — pure gate decision
  lib/agents.mjs                  per-agent state factory, quiescence and live-worker queries
  lib/routing.mjs                 routeMail() — what the supervisor does with a bus message, per pattern
  lib/patterns.mjs                PATTERNS table: roles, tool grants, peers, prompts per pattern
  lib/config.mjs                  loadConfig() — arbiter.json + env overrides + validation
  lib/session-adapter.mjs         sessionEntryToEvents() — pi session JSONL → RPC-shaped events
  lib/child-transcripts.mjs       child transcript discovery + incremental JSONL tailer
  lib/worker-def.mjs              worker agent-definition (frontmatter markdown) generator
  ext/mail-ext.ts                 send_mail tool (moved; gains the orchestrator role)
  ext/subagents-bridge.ts         forwards subagents:* lifecycle events to a file
  prompts/{builder,builder-solo,critic,orchestrator,worker}.md
  tasks/                          unchanged
  tools/extract-runs.mjs          run → console data (run list derived from runs/*/summary.json)
  tools/kpi.mjs                   success-per-1k-tokens table, per role
  tools/build-console.mjs         splices runs-data.json into the template
  tools/console.template.html     the console (metadata derived from summary.json, no TASK_META)
  test/*.test.mjs, test/fixtures/
  docs/superpowers/{specs,plans}/
```

---

## Phase A — rename and generalise (no behaviour change)

### Task 1: Rename the project to `arbiter`

**Files:**
- Rename: directory `C:\Users\user\open_harnessess\pi\duo` → `C:\Users\user\open_harnessess\pi\arbiter`
- Modify: `supervisor.mjs` (header comment and the `here`-relative paths are unchanged; only the console/usage text mentions "duo")
- Modify: `.gitignore`

**Interfaces:**
- Produces: the project root path used by every later task.

- [ ] **Step 1: Confirm nothing is running from the old path**

Run: `tasklist //FI "IMAGENAME eq node.exe" //FO CSV` and `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select CommandLine` (PowerShell). Expected: no `supervisor.mjs` or `cli.ts --mode rpc` processes. If any exist, stop them first (`Stop-Process -Id <pid> -Force`).

- [ ] **Step 2: Rename the directory**

Run (bash): `mv /c/Users/user/open_harnessess/pi/duo /c/Users/user/open_harnessess/pi/arbiter && cd /c/Users/user/open_harnessess/pi/arbiter && git status --short | head`
Expected: git status is clean (git does not track the root directory name).

- [ ] **Step 3: Replace remaining "duo" wording in tracked files**

Run: `grep -rn "duo" --include=*.mjs --include=*.ts --include=*.md --include=*.json . | grep -v node_modules | grep -v docs/superpowers`
For each hit in `supervisor.mjs` and `mail-ext.ts` change the word to `arbiter` (comments and the `console.log` usage banner only). Leave `docs/superpowers/**` untouched — the spec documents the rename itself.

- [ ] **Step 4: Verify the supervisor still starts**

Run: `cd /c/Users/user/open_harnessess/pi/arbiter && node --check supervisor.mjs && DUO_TASK=glob DUO_PROVIDER=llama.cpp DUO_MODEL=qwen3-27b DUO_CAP_WALL=15 timeout 40 node supervisor.mjs 2>&1 | tail -5`
Expected: banner, `both agents ready; kicking off`, `FINISH: CAP: wall 15s`, no errors. Then delete the smoke run: `rm -rf runs/<that-run-id>`.

- [ ] **Step 5: Commit**

```bash
git add -A && git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "Rename project duo -> arbiter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PuJy7LyibtATwkTXsm6irr"
```

### Task 2: Bring the console, extraction and KPI tools into the project

**Files:**
- Create: `tools/extract-runs.mjs`, `tools/kpi.mjs`, `tools/build-console.mjs`, `tools/console.template.html` (copied from `C:\Users\user\AppData\Local\Temp\claude\C--Users-user-open-harnessess-pi-pi\cce6e070-efad-47af-9c45-796a46bc3242\scratchpad\{extract-runs.mjs,kpi.mjs,build-artifact.mjs,duo-console.template.html}` then edited)
- Test: `test/extract-runs.test.mjs`

**Interfaces:**
- Produces: `tools/extract-runs.mjs` exports `discoverRuns(runsDir) → Array<{dir, id, label, gate, srcFile, summary}>` and `extractRun(runDir, meta) → runRecord`; writes `tools/runs-data.json` when run as a script. `runRecord` has `{id, label, gate, complete, summary, events, sourceFile, source, roles}` where `roles` is `summary.config?.roles ?? null`.
- Consumes: `runs/*/summary.json` (existing shape; Task 7 adds `config`).

- [ ] **Step 1: Copy the four files**

Run:
```bash
S="/c/Users/user/AppData/Local/Temp/claude/C--Users-user-open-harnessess-pi-pi/cce6e070-efad-47af-9c45-796a46bc3242/scratchpad"
cd /c/Users/user/open_harnessess/pi/arbiter && mkdir -p tools test/fixtures
cp "$S/extract-runs.mjs" tools/extract-runs.mjs
cp "$S/kpi.mjs" tools/kpi.mjs
cp "$S/build-artifact.mjs" tools/build-console.mjs
cp "$S/duo-console.template.html" tools/console.template.html
```

- [ ] **Step 2: Write the failing test for run discovery**

`test/extract-runs.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRuns } from "../tools/extract-runs.mjs";

test("discoverRuns lists only run dirs with a summary.json, labelled from the summary", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-runs-"));
	fs.mkdirSync(path.join(tmp, "2026-09-11T01-00-00"));
	fs.writeFileSync(
		path.join(tmp, "2026-09-11T01-00-00", "summary.json"),
		JSON.stringify({ runId: "2026-09-11T01-00-00", reason: "SUCCESS: oracle passed", task: "glob", builderModel: "llama.cpp/qwen3-27b", criticModel: "llama.cpp/qwen3-27b", oracleGate: "critic approval" }),
	);
	fs.mkdirSync(path.join(tmp, "2026-09-11T02-00-00")); // no summary: still running or crashed
	fs.mkdirSync(path.join(tmp, ".ws-2026-09-11T02-00-00")); // temp workspace root
	const runs = discoverRuns(tmp);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].id, "2026-09-11T01-00-00");
	assert.equal(runs[0].srcFile, "glob.mjs");
	assert.match(runs[0].label, /glob/);
	assert.match(runs[0].label, /qwen3-27b/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd /c/Users/user/open_harnessess/pi/arbiter && node --test test/extract-runs.test.mjs`
Expected: FAIL — `discoverRuns` is not exported.

- [ ] **Step 4: Rewrite `tools/extract-runs.mjs` around `discoverRuns`/`extractRun`**

Replace the hard-coded `RUNS` array and the top-level loop with:
```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = path.join(here, "..", "runs");
const THINK_CAP = 6000;
const SRC_BY_TASK = { duration: "duration.mjs", glob: "glob.mjs", orbit: "orbit.mjs", decline: "decline.mjs", "intercom-review": "findings.json" };

function readJsonl(p) { /* unchanged from the scratch version */ }

export function discoverRuns(runsDir = RUNS_DIR) {
	return fs
		.readdirSync(runsDir)
		.filter((d) => !d.startsWith(".") && fs.existsSync(path.join(runsDir, d, "summary.json")))
		.sort()
		.map((d) => {
			const summary = JSON.parse(fs.readFileSync(path.join(runsDir, d, "summary.json"), "utf8"));
			const task = summary.task ?? "glob";
			const models = summary.criticModel && !/^none/.test(summary.criticModel) && summary.criticModel !== summary.builderModel
				? `${summary.builderModel} × ${summary.criticModel}`
				: summary.builderModel ?? summary.model;
			const pattern = summary.config?.pattern ?? (summary.solo ? "solo" : "dyad");
			return {
				dir: path.join(runsDir, d),
				id: d,
				label: `${task} · ${pattern} · ${models}`,
				gate: summary.oracleGate ?? "critic approval",
				srcFile: SRC_BY_TASK[task] ?? "src.mjs",
				summary,
			};
		});
}

export function extractRun(run) {
	// body: the existing per-run block from the scratch version, using run.dir / run.srcFile / run.summary,
	// returning the object instead of assigning into `out`. Add `roles: run.summary.config?.roles ?? null`.
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = {};
	for (const run of discoverRuns()) {
		out[run.id] = extractRun(run);
		console.error(`${run.id}: ${out[run.id].events.length} events, complete=${out[run.id].complete}`);
	}
	fs.writeFileSync(path.join(here, "runs-data.json"), JSON.stringify(out));
	console.error("wrote tools/runs-data.json");
}
```
Keep the event-building code exactly as it is in the scratch version (bus → mail events, audit → tool/lifecycle/oracle/system/warn events, raw-*.jsonl → thinking events); only its inputs and output change. For workers (Task 14) the audit `agent` field already carries `worker:<id>` and passes through unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/extract-runs.test.mjs` — Expected: PASS.

- [ ] **Step 6: Make the console derive metadata from the summary**

In `tools/console.template.html`, delete the whole `const TASK_META = { ... };` object and add, right after `const RUNS = __RUNS_DATA__;`:
```js
function metaFor(run){
  const s = run.summary || {};
  const roles = run.roles || {};
  const roleNames = Object.keys(roles);
  const builderLike = roleNames.find(r => r === "builder" || r === "worker") || "builder";
  const criticLike  = roleNames.find(r => r === "critic" || r === "orchestrator") || null;
  return {
    title: run.label,
    gate: run.gate,
    model: criticLike && s.criticModel && !/^none/.test(s.criticModel) ? `${s.builderModel} / ${s.criticModel}` : (s.builderModel || s.model || "?"),
    builderTools: (roles[builderLike] && roles[builderLike].tools) || ["read","bash","edit","write","ls","grep","find","send_mail"],
    criticTools: criticLike ? ((roles[criticLike] && roles[criticLike].tools) || ["send_mail"]) : [],
    builderRole: builderLike === "worker" ? "worker: builds what the orchestrator briefs" : "implements against a spec it doesn't have",
    criticRole: criticLike === "orchestrator" ? "orchestrator: decomposes, delegates, probes, claims done" : (criticLike ? "holds the spec, probes before approving" : "none — solo run"),
    blurb: `${s.reason || "running"} · ${s.wallSec ? s.wallSec + "s" : ""} · ${typeof s.costUsd === "number" ? "$" + s.costUsd.toFixed(2) : ""}`
  };
}
```
Then replace every `TASK_META[id]` / `TASK_META[currentId]` with `metaFor(RUNS[id])` / `metaFor(RUNS[currentId])` (four sites: `buildRunList`, two in the header/role renderers, and the `runSub` assignment). Change the `<title>` and the sidebar wordmark from `Duo Console` / `DUO CONSOLE` to `Arbiter Console` / `ARBITER CONSOLE`.

- [ ] **Step 7: Fix paths in `tools/build-console.mjs` and `tools/kpi.mjs`**

`tools/build-console.mjs`:
```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const template = fs.readFileSync(path.join(here, "console.template.html"), "utf8");
const data = fs.readFileSync(path.join(here, "runs-data.json"), "utf8").replace(/<\/script/gi, "<\\/script");
fs.writeFileSync(path.join(here, "console.html"), template.replace("__RUNS_DATA__", data));
console.log("wrote tools/console.html");
```
`tools/kpi.mjs`: replace `BASE` and the `RUNS` array with `import { discoverRuns } from "./extract-runs.mjs";` and `const RUNS = discoverRuns().map((r) => ({ dir: r.dir, label: r.label }));` (keep `tokenTotals` and the table printing). Add a per-role breakdown: `tokenTotals` already loops `["builder", "critic"]`; change it to loop over every `raw-*.jsonl` in the run dir (`fs.readdirSync(dir).filter(f => /^raw-.*\.jsonl$/.test(f))`) and to also return `byRole`, an object keyed by the role prefix of the file name (`raw-worker:abc.jsonl` → `worker`), summing `input+output` per role. Print `byRole` as a final column, JSON-stringified.

- [ ] **Step 8: Build the console end to end and check it opens**

Run: `node tools/extract-runs.mjs && node tools/build-console.mjs && node tools/kpi.mjs | head -20`
Expected: one line per existing run dir with a summary (there are 16), `wrote tools/console.html`, and a KPI table. Open `tools/console.html` in a browser: every run appears in the sidebar and selecting one renders its feed (this was the failure mode with `TASK_META` — any run missing from a hand-kept table crashed the sidebar).

- [ ] **Step 9: Commit**

```bash
git add tools test && git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "Move console, extraction and KPI tools into the project; derive run list from summary.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PuJy7LyibtATwkTXsm6irr"
```

### Task 3: `lib/text.mjs` — capping helper

**Files:**
- Create: `lib/text.mjs`, `test/text.test.mjs`
- Modify: `supervisor.mjs` (remove the inline `PROBE_VALUE_MAX`/`truncateForMail`, import instead)

**Interfaces:**
- Produces: `export const PROBE_VALUE_MAX = 1500; export function truncateForMail(s, max = PROBE_VALUE_MAX): string`

- [ ] **Step 1: Write the failing test**

`test/text.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateForMail, PROBE_VALUE_MAX } from "../lib/text.mjs";

test("short strings pass through untouched", () => {
	assert.equal(truncateForMail("abc"), "abc");
});
test("long strings are cut at the cap with a note carrying the original length", () => {
	const s = "x".repeat(PROBE_VALUE_MAX + 100);
	const out = truncateForMail(s);
	assert.ok(out.startsWith("x".repeat(PROBE_VALUE_MAX)));
	assert.match(out, /truncated, 1600 chars total/);
	assert.ok(out.length < s.length);
});
test("a custom cap is honoured", () => {
	assert.match(truncateForMail("abcdefgh", 4), /^abcd…\[truncated, 8 chars total/);
});
```

- [ ] **Step 2: Run it to verify it fails** — `node --test test/text.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Create `lib/text.mjs`**

```js
// Caps text that is about to enter a model's context. Full values stay in the run's
// files; found live: two ~250KB untruncated probe echoes pushed a local model past
// what its own overflow recovery could summarise.
export const PROBE_VALUE_MAX = 1500;
export function truncateForMail(s, max = PROBE_VALUE_MAX) {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[truncated, ${s.length} chars total — ask for a smaller case, e.g. a shorter n, if you need to see all of it]`;
}
```

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Use it from the supervisor**

In `supervisor.mjs` delete the `PROBE_VALUE_MAX` constant and the `truncateForMail` function (the block right after `hashDir`), and add `import { truncateForMail } from "./lib/text.mjs";` to the imports. `node --check supervisor.mjs` must pass.

- [ ] **Step 6: Commit** — `git add lib/text.mjs test/text.test.mjs supervisor.mjs` + commit message `Extract truncateForMail into lib/text.mjs`.

### Task 4: `lib/gate.mjs` — the approval decision as a pure function

**Files:**
- Create: `lib/gate.mjs`, `test/gate.test.mjs`
- Modify: `supervisor.mjs` `handleCriticApproval()`

**Interfaces:**
- Produces: `export const QUIESCENCE_MS = 15_000; export function decideApproval({ lastProbeHash, currentHash, srcExists, lastEditTs, now, quiescenceMs = QUIESCENCE_MS }) → { ok: boolean, reason: null | "no_probe" | "no_src" | "stale" | "too_soon", sinceEditMs: number }`
- Consumes: hashes as produced by the supervisor's existing `hashDir()`.

- [ ] **Step 1: Write the failing tests**

`test/gate.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval } from "../lib/gate.mjs";

const base = { lastProbeHash: "h1", currentHash: "h1", srcExists: true, lastEditTs: 0, now: 100_000, quiescenceMs: 15_000 };

test("rejects when no probe has ever run", () => {
	assert.deepEqual(decideApproval({ ...base, lastProbeHash: null }).reason, "no_probe");
});
test("rejects when src is gone", () => {
	assert.equal(decideApproval({ ...base, srcExists: false }).reason, "no_src");
});
test("rejects when the tree changed since the probe", () => {
	assert.equal(decideApproval({ ...base, currentHash: "h2" }).reason, "stale");
});
test("rejects when an edit is too recent", () => {
	const r = decideApproval({ ...base, lastEditTs: 95_000 });
	assert.equal(r.reason, "too_soon");
	assert.equal(r.sinceEditMs, 5_000);
});
test("accepts when probed, unchanged and quiet", () => {
	const r = decideApproval({ ...base, lastEditTs: 50_000 });
	assert.equal(r.ok, true);
	assert.equal(r.reason, null);
});
test("checks are ordered: no_probe wins over stale", () => {
	assert.equal(decideApproval({ ...base, lastProbeHash: null, currentHash: "zzz" }).reason, "no_probe");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/gate.test.mjs` → FAIL.

- [ ] **Step 3: Create `lib/gate.mjs`**

```js
// The approval gate: a claim of completion is accepted only when the code that was
// verified is provably the code that will be tested, and nobody is mid-edit.
// Replaces the mail-based precondition ("BUILDER must send done first") that six
// local-model runs never satisfied.
export const QUIESCENCE_MS = 15_000;

export function decideApproval({ lastProbeHash, currentHash, srcExists, lastEditTs, now, quiescenceMs = QUIESCENCE_MS }) {
	const sinceEditMs = now - (lastEditTs || 0);
	if (lastProbeHash === null || lastProbeHash === undefined) return { ok: false, reason: "no_probe", sinceEditMs };
	if (!srcExists) return { ok: false, reason: "no_src", sinceEditMs };
	if (currentHash !== lastProbeHash) return { ok: false, reason: "stale", sinceEditMs };
	if (sinceEditMs < quiescenceMs) return { ok: false, reason: "too_soon", sinceEditMs };
	return { ok: true, reason: null, sinceEditMs };
}
```

- [ ] **Step 4: Run the tests** — PASS.

- [ ] **Step 5: Rewire `handleCriticApproval()` in `supervisor.mjs`**

Replace its body with:
```js
function handleCriticApproval() {
	const srcDir = path.join(WS.builder, "src");
	const srcExists = fs.existsSync(srcDir);
	const verdict = decideApproval({
		lastProbeHash,
		currentHash: srcExists ? hashDir(srcDir) : null,
		srcExists,
		lastEditTs: state.builder.lastEditTs,
		now: Date.now(),
	});
	if (verdict.ok) return runOracle();
	const why = {
		no_probe: '[SUPERVISOR] Approval not accepted: you have not run a single kind="probe" yet, so nothing confirms this matches BUILDER\'s real code. Probe first, then approve.',
		no_src: "[SUPERVISOR] Approval not accepted: BUILDER's src/ no longer exists.",
		stale: '[SUPERVISOR] Approval not accepted: BUILDER\'s src/ has changed since your last probe — the code you verified is not the code that would be tested. Send a fresh kind="probe" against the current code, then approve.',
		too_soon: `[SUPERVISOR] Approval not accepted yet: BUILDER edited code ${(verdict.sinceEditMs / 1000).toFixed(1)}s ago, too recent to be sure it's settled. Wait a few seconds and send done again — no need to re-probe unless BUILDER tells you something changed.`,
	}[verdict.reason];
	const label = { no_probe: "approval without probe", no_src: "approval error", stale: "approval stale (src changed since probe)", too_soon: "approval too soon after edit" }[verdict.reason];
	deliver("critic", why, label);
}
```
Import: `import { decideApproval, QUIESCENCE_MS } from "./lib/gate.mjs";` and delete the local `const QUIESCENCE_MS = 15_000;`. `timeStatus()` still reads `QUIESCENCE_MS` — the import covers it.

- [ ] **Step 6: Verify** — `node --check supervisor.mjs && node --test test/` → all PASS.

- [ ] **Step 7: Commit** — `Extract the approval gate into lib/gate.mjs`.

### Task 5: `lib/agents.mjs` — per-agent state

**Files:**
- Create: `lib/agents.mjs`, `test/agents.test.mjs`
- Modify: `supervisor.mjs` `launch()` (use the factory), `timeStatus()`, `maybeQuiescentOracle()`, `handleCriticApproval()` (quiescence over all editing agents)

**Interfaces:**
- Produces:
  - `export function createAgentState({ id, role, child = null, raw = null }) → { id, role, child, raw, busy: false, ready: false, status: "starting", toolCalls: 0, cost: 0, buf: "", pendingBash: new Map(), lastEditTs: 0 }`
  - `export function lastEditAcross(states) → number` (max `lastEditTs` over an iterable of states)
  - `export function liveWorkers(states) → state[]` (role `"worker"` and status `"running"`)
  - `export const EDITING_TOOLS = new Set(["write", "edit", "bash"])`

- [ ] **Step 1: Write the failing tests**

`test/agents.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentState, lastEditAcross, liveWorkers, EDITING_TOOLS } from "../lib/agents.mjs";

test("a fresh state is idle, not ready, with zero counters", () => {
	const s = createAgentState({ id: "builder", role: "builder" });
	assert.equal(s.ready, false);
	assert.equal(s.busy, false);
	assert.equal(s.toolCalls, 0);
	assert.equal(s.lastEditTs, 0);
	assert.ok(s.pendingBash instanceof Map);
});
test("lastEditAcross is the max over every agent", () => {
	const a = createAgentState({ id: "worker:1", role: "worker" }); a.lastEditTs = 10;
	const b = createAgentState({ id: "worker:2", role: "worker" }); b.lastEditTs = 30;
	const c = createAgentState({ id: "orchestrator", role: "orchestrator" });
	assert.equal(lastEditAcross([a, b, c]), 30);
	assert.equal(lastEditAcross([]), 0);
});
test("liveWorkers returns running workers only", () => {
	const a = createAgentState({ id: "worker:1", role: "worker" }); a.status = "running";
	const b = createAgentState({ id: "worker:2", role: "worker" }); b.status = "completed";
	const o = createAgentState({ id: "orchestrator", role: "orchestrator" }); o.status = "running";
	assert.deepEqual(liveWorkers([a, b, o]).map((s) => s.id), ["worker:1"]);
});
test("bash counts as an editing tool", () => {
	assert.ok(EDITING_TOOLS.has("bash") && EDITING_TOOLS.has("edit") && EDITING_TOOLS.has("write") && !EDITING_TOOLS.has("read"));
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Create `lib/agents.mjs`**

```js
// Per-agent bookkeeping. One entry per pi process (dyad, solo) or per pi-subagents
// child (orchestrator pattern). Nothing here decides anything; it is the state the
// supervisor's decisions read.
export const EDITING_TOOLS = new Set(["write", "edit", "bash"]);

export function createAgentState({ id, role, child = null, raw = null }) {
	return { id, role, child, raw, busy: false, ready: false, status: "starting", toolCalls: 0, cost: 0, buf: "", pendingBash: new Map(), lastEditTs: 0 };
}

export function lastEditAcross(states) {
	let max = 0;
	for (const s of states) if (s.lastEditTs > max) max = s.lastEditTs;
	return max;
}

export function liveWorkers(states) {
	return [...states].filter((s) => s.role === "worker" && s.status === "running");
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Use it in `supervisor.mjs`**

In `launch(name)`: replace the object literal `const s = { name, child, raw, busy: false, ... }` with `const s = createAgentState({ id: name, role: name, child, raw }); s.name = name;` (keep `s.name` because existing code reads it). In `handle()`, where `lastEditTs` is set for `name === "builder"`, change the condition to `if (EDITING_TOOLS.has(ev.toolName) && (s.role === "builder" || s.role === "worker")) s.lastEditTs = Date.now();`. In `handleCriticApproval()` and `timeStatus()` and `maybeQuiescentOracle()` replace `state.builder.lastEditTs` / `b.lastEditTs` with `lastEditAcross(Object.values(state))`. Add the import.

- [ ] **Step 6: Verify** — `node --check supervisor.mjs && node --test test/` → PASS.

- [ ] **Step 7: Commit** — `Extract per-agent state into lib/agents.mjs`.

### Task 6: `lib/routing.mjs` — what the supervisor does with a bus message

**Files:**
- Create: `lib/routing.mjs`, `test/routing.test.mjs`
- Modify: `supervisor.mjs` `pumpBus()`

**Interfaces:**
- Produces: `export function routeMail(pattern, msg) → { action, to? }` with `action ∈ {"probe", "approval", "bounce_probe", "solo_done", "solo_ack", "deliver", "drop"}`. `msg` is a bus record `{ from, to, kind, body }`.

- [ ] **Step 1: Write the failing tests**

`test/routing.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeMail } from "../lib/routing.mjs";

const m = (from, to, kind) => ({ from, to, kind, body: "" });

test("dyad: critic probe is intercepted", () => {
	assert.deepEqual(routeMail("dyad", m("critic", "builder", "probe")), { action: "probe" });
});
test("dyad: critic done is an approval attempt", () => {
	assert.deepEqual(routeMail("dyad", m("critic", "builder", "done")), { action: "approval" });
});
test("dyad: a builder probe is bounced, never relayed", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "probe")), { action: "bounce_probe", to: "builder" });
});
test("dyad: everything else is delivered to its recipient", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "question")), { action: "deliver", to: "critic" });
	assert.deepEqual(routeMail("dyad", m("builder", "critic", "done")), { action: "deliver", to: "critic" });
});
test("solo: builder done runs the oracle, anything else is acknowledged", () => {
	assert.deepEqual(routeMail("solo", m("builder", "supervisor", "done")), { action: "solo_done" });
	assert.deepEqual(routeMail("solo", m("builder", "supervisor", "status")), { action: "solo_ack", to: "builder" });
});
test("orchestrator: orchestrator probe and done are intercepted; other kinds acknowledged", () => {
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "probe")), { action: "probe" });
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "done")), { action: "approval" });
	assert.deepEqual(routeMail("orchestrator", m("orchestrator", "supervisor", "status")), { action: "solo_ack", to: "orchestrator" });
});
test("unknown recipients are dropped", () => {
	assert.deepEqual(routeMail("dyad", m("builder", "nobody", "question")), { action: "drop" });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Create `lib/routing.mjs`**

```js
// Every bus message goes through here. The supervisor intercepts what it must act on
// (probes, approvals) and relays the rest; nothing a model writes is executed by
// accident because the routing is decided by (pattern, from, kind), never by body.
const AGENTS_BY_PATTERN = { dyad: ["builder", "critic"], solo: ["builder"], orchestrator: ["orchestrator"] };
const VERIFIER_BY_PATTERN = { dyad: "critic", orchestrator: "orchestrator" };

export function routeMail(pattern, msg) {
	const verifier = VERIFIER_BY_PATTERN[pattern];
	if (verifier && msg.from === verifier && msg.kind === "probe") return { action: "probe" };
	if (verifier && msg.from === verifier && msg.kind === "done") return { action: "approval" };
	if (msg.kind === "probe") return { action: "bounce_probe", to: msg.from };
	if (pattern === "solo" && msg.from === "builder") return msg.kind === "done" ? { action: "solo_done" } : { action: "solo_ack", to: "builder" };
	if (pattern === "orchestrator" && msg.from === "orchestrator") return { action: "solo_ack", to: "orchestrator" };
	if ((AGENTS_BY_PATTERN[pattern] ?? []).includes(msg.to)) return { action: "deliver", to: msg.to };
	return { action: "drop" };
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Rewire `pumpBus()` in `supervisor.mjs`**

Replace the chain of `if (msg.kind === ... && msg.from === ...)` blocks (probe intercept, builder-probe bounce, critic done, solo block, generic deliver) with:
```js
const route = routeMail(PATTERN, msg);
switch (route.action) {
	case "probe": runProbe(msg); break;
	case "approval": handleCriticApproval(); break;
	case "bounce_probe":
		deliver(route.to, '[SUPERVISOR] Your kind="probe" was not run — only the verifying role\'s probes are host-executed. Describe what you found as kind="status" instead.', "probe bounced");
		break;
	case "solo_done": runOracle(); break;
	case "solo_ack":
		deliver(route.to, '[SUPERVISOR] Acknowledged, but nobody will answer this — there is no counterpart in this run. When your implementation is complete and self-tested, send kind="done".', "ack (no counterpart)");
		break;
	case "deliver": deliver(route.to, frame(msg), `mail #${msg.n} from ${msg.from}`); break;
	case "drop": log({ type: "warn", msg: `mail #${msg.n} to unknown recipient "${msg.to}" dropped` }); break;
}
```
`PATTERN` is a module constant: for now `const PATTERN = SOLO ? "solo" : "dyad";` (Task 7 replaces it with the config value). `handleCriticApproval` is renamed `handleApproval` everywhere (it serves the orchestrator too).

- [ ] **Step 6: Verify** — `node --check supervisor.mjs && node --test test/` → PASS; then the 15 s dyad smoke from Task 1 Step 4 and a solo smoke (`DUO_SOLO=1`, same flags) both reach `FINISH: CAP: wall 15s`. Delete both smoke run dirs.

- [ ] **Step 7: Commit** — `Extract mail routing into lib/routing.mjs`.

### Task 7: `lib/patterns.mjs` + `lib/config.mjs` — run configuration replaces `DUO_*`

**Files:**
- Create: `lib/patterns.mjs`, `lib/config.mjs`, `arbiter.json`, `test/config.test.mjs`
- Modify: `supervisor.mjs` (top ~60 lines: env parsing, `AGENTS`, prompts; `finish()` summary; banner)

**Interfaces:**
- Produces:
  - `lib/patterns.mjs`: `export const BUILDER_TOOLS = "read,bash,edit,write,ls,grep,find,send_mail"; export const ORCHESTRATOR_TOOLS = "read,ls,grep,send_mail,subagent,steer_subagent,get_subagent_result"; export const WORKER_TOOLS = ["read","bash","edit","write","ls","grep","find"]; export const PATTERNS = { dyad: { roles: ["builder","critic"], tools: { builder: BUILDER_TOOLS, critic: "send_mail" }, peer: { builder: "critic", critic: "builder" }, prompt: { builder: "builder.md", critic: "critic.md" }, verifier: "critic" }, solo: { roles: ["builder"], tools: { builder: BUILDER_TOOLS }, peer: { builder: "supervisor" }, prompt: { builder: "builder-solo.md" }, verifier: null }, orchestrator: { roles: ["orchestrator","worker"], tools: { orchestrator: ORCHESTRATOR_TOOLS }, peer: { orchestrator: "supervisor" }, prompt: { orchestrator: "orchestrator.md", worker: "worker.md" }, verifier: "orchestrator" } }`
  - `lib/config.mjs`: `export function loadConfig({ configPath, env = process.env }) → { task, pattern, roles: { [name]: { provider, model, max?, background? } }, caps: { toolCalls, wallSec, usd, doneAttempts, idleNudgeSec, maxNudges, bashTimeoutSec }, oracle: { reportFailingInputs }, configPath }`; throws `Error("pattern \"X\" requires role \"Y\" (missing in <path>)")`; `export function parseArgs(argv) → { configPath }` (reads `--config <path>`, default `arbiter.json` beside `supervisor.mjs`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

`test/config.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseArgs } from "../lib/config.mjs";
import { PATTERNS } from "../lib/patterns.mjs";

function tmpConfig(obj) {
	const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-cfg-")), "arbiter.json");
	fs.writeFileSync(p, JSON.stringify(obj));
	return p;
}

test("loads a dyad config and fills cap defaults", () => {
	const cfg = loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "dyad", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" }, critic: { provider: "anthropic", model: "claude-sonnet-5" } } }), env: {} });
	assert.equal(cfg.pattern, "dyad");
	assert.equal(cfg.caps.wallSec, 1500);
	assert.equal(cfg.caps.doneAttempts, 5);
	assert.equal(cfg.oracle.reportFailingInputs, false);
});
test("a missing role fails with the role named", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" } } });
	assert.throws(() => loadConfig({ configPath: p, env: {} }), /requires role "worker"/);
});
test("env overrides win over the file", () => {
	const p = tmpConfig({ task: "glob", pattern: "solo", roles: { builder: { provider: "llama.cpp", model: "qwen3-27b" } }, caps: { wallSec: 100 } });
	const cfg = loadConfig({ configPath: p, env: { ROLE_builder_MODEL: "qwen3-flash", ARBITER_CAP_WALL: "6000", ARBITER_TASK: "orbit" } });
	assert.equal(cfg.roles.builder.model, "qwen3-flash");
	assert.equal(cfg.caps.wallSec, 6000);
	assert.equal(cfg.task, "orbit");
});
test("worker role defaults: max 1, foreground", () => {
	const p = tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { provider: "zai", model: "glm-5.3-flash" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } } });
	const cfg = loadConfig({ configPath: p, env: {} });
	assert.equal(cfg.roles.worker.max, 1);
	assert.equal(cfg.roles.worker.background, false);
});
test("parseArgs reads --config", () => {
	assert.equal(parseArgs(["node", "supervisor.mjs", "--config", "configs/x.json"]).configPath, "configs/x.json");
});
test("every pattern's prompt files exist", () => {
	for (const [name, p] of Object.entries(PATTERNS)) for (const f of Object.values(p.prompt)) assert.ok(fs.existsSync(path.join("prompts", f)), `${name}: prompts/${f}`);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL. (The last test will fail until Task 12 adds `orchestrator.md` and `worker.md`; create empty placeholders now with one line each — `# orchestrator` / `# worker` — and Task 12 fills them.)

- [ ] **Step 3: Create `lib/patterns.mjs`** with exactly the exports listed in Interfaces (copy the object literally).

- [ ] **Step 4: Create `lib/config.mjs`**

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS } from "./patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CAP_DEFAULTS = { toolCalls: 200, wallSec: 1500, usd: 5, doneAttempts: 5, idleNudgeSec: 120, maxNudges: 3, bashTimeoutSec: 90 };
const CAP_ENV = { toolCalls: "ARBITER_CAP_TOOLS", wallSec: "ARBITER_CAP_WALL", usd: "ARBITER_CAP_USD", doneAttempts: "ARBITER_CAP_DONE", idleNudgeSec: "ARBITER_IDLE_NUDGE", bashTimeoutSec: "ARBITER_BASH_TIMEOUT_SEC" };

export function parseArgs(argv) {
	const i = argv.indexOf("--config");
	return { configPath: i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(here, "..", "arbiter.json") };
}

export function loadConfig({ configPath, env = process.env }) {
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const task = env.ARBITER_TASK || raw.task;
	const pattern = env.ARBITER_PATTERN || raw.pattern;
	const def = PATTERNS[pattern];
	if (!def) throw new Error(`unknown pattern "${pattern}" in ${configPath} (known: ${Object.keys(PATTERNS).join(", ")})`);
	const roles = {};
	for (const name of def.roles) {
		const r = raw.roles?.[name];
		const provider = env[`ROLE_${name}_PROVIDER`] || r?.provider;
		const model = env[`ROLE_${name}_MODEL`] || r?.model;
		if (!provider || !model) throw new Error(`pattern "${pattern}" requires role "${name}" (missing in ${configPath})`);
		roles[name] = { provider, model };
		if (name === "worker") {
			roles[name].max = Number(r?.max ?? 1);
			roles[name].background = Boolean(r?.background ?? false);
		}
	}
	const caps = { ...CAP_DEFAULTS, ...(raw.caps ?? {}) };
	for (const [key, envName] of Object.entries(CAP_ENV)) if (env[envName]) caps[key] = Number(env[envName]);
	const oracle = { reportFailingInputs: Boolean(raw.oracle?.reportFailingInputs ?? false) };
	if (!task) throw new Error(`no task in ${configPath}`);
	return { task, pattern, roles, caps, oracle, configPath };
}
```

- [ ] **Step 5: Create `arbiter.json`** (today's default run):

```json
{
  "task": "glob",
  "pattern": "dyad",
  "roles": {
    "builder": { "provider": "llama.cpp", "model": "qwen3-27b" },
    "critic":  { "provider": "llama.cpp", "model": "qwen3-27b" }
  },
  "caps": { "toolCalls": 200, "wallSec": 1500, "usd": 5, "doneAttempts": 5 },
  "oracle": { "reportFailingInputs": false }
}
```

- [ ] **Step 6: Run tests** → PASS.

- [ ] **Step 7: Rewire the top of `supervisor.mjs`**

Delete `MODEL`, `PROVIDER`, `BUILDER_MODEL`, `BUILDER_PROVIDER`, `CRITIC_MODEL`, `CRITIC_PROVIDER`, `TASK_NAME`, `SOLO`, and the `CAPS` literal. Replace with:
```js
import { loadConfig, parseArgs } from "./lib/config.mjs";
import { PATTERNS } from "./lib/patterns.mjs";
const CONFIG = loadConfig(parseArgs(process.argv));
const { task: TASK_NAME, pattern: PATTERN, roles: ROLES, caps: CAPS, oracle: ORACLE_OPTS } = CONFIG;
const PDEF = PATTERNS[PATTERN];
const SOLO = PATTERN === "solo";
```
Replace the `prompts` object and `AGENTS` with:
```js
const prompts = {};
for (const role of PDEF.roles) {
	const base = fs.readFileSync(path.join(here, "prompts", PDEF.prompt[role]), "utf8");
	const needsContext = role === "critic" || role === "orchestrator" || SOLO;
	prompts[role] = needsContext ? `${base}\n\n# ${contextHeading}\n\n${taskContext}` : base;
}
const AGENTS = {};
for (const role of PDEF.roles) {
	if (role === "worker") continue; // workers are pi-subagents children, not supervisor-launched processes
	let tools = PDEF.tools[role];
	if (role === "builder" && fs.existsSync(toolsOverride)) tools = fs.readFileSync(toolsOverride, "utf8").trim();
	AGENTS[role] = { tools, peer: PDEF.peer[role], provider: ROLES[role].provider, model: ROLES[role].model };
}
```
Keep the task-level `builder.md` override for the dyad builder (`builderPromptFile` logic) by checking `if (role === "builder" && !SOLO && fs.existsSync(path.join(TASK, "builder.md")))` before reading `PDEF.prompt[role]`. The go-section becomes `for (const role of Object.keys(AGENTS)) launch(role);` and the kickoff branches on `PATTERN` (`"dyad"` → both kickoffs; `"solo"` and `"orchestrator"` → builder/orchestrator kickoff only; the orchestrator kickoff text is added in Task 14). In `finish()`, replace `builderModel`/`criticModel`/`solo`/`oracleGate` with `config: CONFIG` (whole resolved config) plus `oracleGate: PDEF.verifier ? `${PDEF.verifier} approval (hash+quiescence)` : "solo: builder done or quiescence"` and keep `model` as `Object.values(ROLES).map(r => r.model).join(" + ")`. Print `console.log("config:", JSON.stringify(CONFIG))` at startup.

- [ ] **Step 8: Verify** — `node --check supervisor.mjs && node --test test/`; then `ARBITER_CAP_WALL=15 timeout 40 node supervisor.mjs 2>&1 | tail -5` (dyad from `arbiter.json`) and `ARBITER_PATTERN=solo ARBITER_CAP_WALL=15 timeout 40 node supervisor.mjs 2>&1 | tail -5` both finish cleanly; `summary.json` of each contains `"config"`. `grep -rn "DUO_" --include=*.mjs --include=*.ts . | grep -v node_modules` prints nothing. Delete the smoke run dirs.

- [ ] **Step 9: Commit** — `Run configuration: arbiter.json with patterns and roles replaces DUO_* env`.

---

## Phase B — the orchestrator pattern

### Task 8: Install the substrate and write the lifecycle bridge extension

**Files:**
- Create: `package.json`, `ext/subagents-bridge.ts`, `test/bridge.test.mjs`
- Move: `mail-ext.ts` → `ext/mail-ext.ts` (update the `-e` path in `launch()`)

**Interfaces:**
- Produces: `ext/subagents-bridge.ts` default export `(pi: ExtensionAPI) => void`; when `ARBITER_LIFECYCLE_FILE` is set it appends one JSON line `{ ts, ev, data }` per event for `ev ∈ LIFECYCLE_EVENTS`; `export const LIFECYCLE_EVENTS = ["subagents:created","subagents:started","subagents:update","subagents:completed","subagents:failed","subagents:resuming","subagents:resumed","subagents:steered","subagents:compacted"]`.
- Consumes: `pi.events.on(name, handler)` (pi's `ExtensionAPI.events: EventBus`, `<PI>/packages/coding-agent/src/core/extensions/types.ts:1505`).

- [ ] **Step 1: Create `package.json` and install**

```json
{
  "name": "arbiter",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" },
  "dependencies": { "@gotgenes/pi-subagents": "21.7.0" }
}
```
Run: `cd /c/Users/user/open_harnessess/pi/arbiter && npm install --no-audit --no-fund` (if npm refuses on the peer dependency `@earendil-works/pi-coding-agent`, rerun with `--legacy-peer-deps`; pi's loader aliases that import to the running pi at load time — `<PI>/packages/coding-agent/src/core/extensions/loader.ts:57-66`).
Expected: `node_modules/@gotgenes/pi-subagents/src/index.ts` exists; `git status` shows `package.json`, `package-lock.json` (node_modules is ignored).

- [ ] **Step 2: Move the mail extension**

`git mv mail-ext.ts ext/mail-ext.ts`; in `supervisor.mjs` `launch()` change `path.join(here, "mail-ext.ts")` to `path.join(here, "ext", "mail-ext.ts")`.

- [ ] **Step 3: Write the failing test for the bridge**

`test/bridge.test.mjs` (renders the extension with a fake `pi`, the same technique used for `send_mail` this session):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PI = "C:/Users/user/open_harnessess/pi/pi";
const TSX = `${PI}/node_modules/tsx/dist/cli.mjs`;

test("bridge subscribes to every lifecycle event and appends JSON lines", () => {
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-bridge-")), "lifecycle.jsonl");
	const driver = path.join(os.tmpdir(), `bridge-driver-${process.pid}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const handlers = new Map();
		const pi = { events: { on: (name, fn) => handlers.set(name, fn) } };
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/subagents-bridge.ts"))}).href);
		mod.default(pi);
		console.log(JSON.stringify([...handlers.keys()]));
		handlers.get("subagents:created")({ id: "abc", agent: "worker" });
		handlers.get("subagents:completed")({ id: "abc", result: "x".repeat(5000) });
	`);
	const r = spawnSync(process.execPath, [TSX, driver], { encoding: "utf8", env: { ...process.env, ARBITER_LIFECYCLE_FILE: out, NODE_PATH: `${PI}/node_modules` } });
	assert.equal(r.status, 0, r.stderr);
	const names = JSON.parse(r.stdout.trim().split("\n")[0]);
	for (const ev of ["subagents:created", "subagents:started", "subagents:update", "subagents:completed", "subagents:failed", "subagents:resuming", "subagents:resumed", "subagents:steered", "subagents:compacted"]) assert.ok(names.includes(ev), ev);
	const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines.length, 2);
	assert.equal(lines[0].ev, "subagents:created");
	assert.equal(lines[0].data.id, "abc");
	assert.ok(lines[1].data.result.length <= 1600, "results are capped before they are written");
});
```

- [ ] **Step 4: Run to verify failure** → FAIL (file missing).

- [ ] **Step 5: Create `ext/subagents-bridge.ts`**

```ts
/**
 * subagents-bridge — forwards @gotgenes/pi-subagents lifecycle events to a file.
 *
 * The package emits its lifecycle on pi's extension-only event bus; rpc-mode does
 * not forward those to an external client. This runs host-side inside the
 * orchestrator's pi process and writes one JSON line per event so the supervisor
 * can tail them exactly like it tails the mail bus. Large payloads (a worker's
 * final result) are capped here — the full text lives in the child's transcript.
 */
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LIFECYCLE_EVENTS = [
	"subagents:created",
	"subagents:started",
	"subagents:update",
	"subagents:completed",
	"subagents:failed",
	"subagents:resuming",
	"subagents:resumed",
	"subagents:steered",
	"subagents:compacted",
];
const OUT = process.env.ARBITER_LIFECYCLE_FILE ?? "";
const CAP = 1500;

function cap(value: unknown): unknown {
	if (typeof value === "string" && value.length > CAP) return `${value.slice(0, CAP)}…[truncated, ${value.length} chars total]`;
	if (Array.isArray(value)) return value.map(cap);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cap(v)]));
	return value;
}

export default function (pi: ExtensionAPI) {
	if (!OUT) return;
	for (const ev of LIFECYCLE_EVENTS) {
		pi.events.on(ev, (data: unknown) => {
			fs.appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), ev, data: cap(data) })}\n`);
		});
	}
}
```

- [ ] **Step 6: Run the test** → PASS.

- [ ] **Step 7: Commit** — `Add pi-subagents dependency and the lifecycle bridge extension; move mail-ext under ext/`.

### Task 9: Substrate smoke test (re-runnable on every pi bump)

**Files:**
- Create: `test/substrate-smoke.mjs` (not under `node --test`; run explicitly), `test/fixtures/smoke-agent.md`

**Interfaces:**
- Produces: a script that exits 0 only when a parent pi with pi-subagents + the bridge spawns a child that runs `echo child-ran`, the bridge file contains `subagents:completed` with result containing `child-ran`, and a child transcript appears under the parent session dir. This is the spec's "substrate smoke".
- Consumes: `ext/subagents-bridge.ts`, local model server up.

- [ ] **Step 1: Write the agent definition fixture** `test/fixtures/smoke-agent.md`:

```md
---
name: echoer
description: Runs one shell command and reports its output.
tools: bash
max_turns: 4
model: llama.cpp/qwen3-27b
---
You run exactly the shell command you are given, with `timeout: 30`, and reply with its output and nothing else.
```

- [ ] **Step 2: Write `test/substrate-smoke.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PI = "C:/Users/user/open_harnessess/pi/pi";
const TSX = `${PI}/node_modules/tsx/dist/cli.mjs`;
const CLI = `${PI}/packages/coding-agent/src/cli.ts`;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-smoke-"));
fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
fs.copyFileSync(path.join(here, "fixtures", "smoke-agent.md"), path.join(ws, ".pi", "agents", "echoer.md"));
fs.writeFileSync(path.join(ws, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
const sessionDir = path.join(ws, "sessions");
const lifecycle = path.join(ws, "lifecycle.jsonl");

const child = spawn(process.execPath, [
	TSX, CLI, "--mode", "rpc", "--provider", "llama.cpp", "--model", "qwen3-27b",
	"--session-dir", sessionDir, "--name", "orchestrator",
	"-ne", "-e", path.join(ROOT, "node_modules/@gotgenes/pi-subagents/src/index.ts"), "-e", path.join(ROOT, "ext/subagents-bridge.ts"),
	"-na", "-ns", "-np", "-nc", "-t", "subagent",
	"--system-prompt", "You delegate. Use the subagent tool with subagent_type \"echoer\" and prompt \"Run the shell command: echo child-ran\". Then stop.",
], { cwd: ws, env: { ...process.env, ARBITER_LIFECYCLE_FILE: lifecycle }, stdio: ["pipe", "pipe", "inherit"] });

let done = false;
let buf = "";
child.stdout.on("data", (c) => {
	buf += c.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "response" && ev.id === "hello") child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Go." })}\n`);
		if (ev.type === "agent_settled") done = true;
	}
});
child.stdin.write(`${JSON.stringify({ id: "hello", type: "get_state" })}\n`);

const deadline = Date.now() + 120_000;
const timer = setInterval(() => {
	if (!done && Date.now() < deadline) return;
	clearInterval(timer);
	child.kill();
	const events = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const completed = events.find((e) => e.ev === "subagents:completed");
	const transcripts = fs.readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).replace(/\\/g, "/").includes("/tasks/") && String(f).endsWith(".jsonl"));
	const ok = done && completed && JSON.stringify(completed.data).includes("child-ran") && transcripts.length === 1;
	console.log(JSON.stringify({ ok, done, events: events.map((e) => e.ev), transcripts }, null, 2));
	process.exit(ok ? 0 : 1);
}, 500);
```

- [ ] **Step 3: Run it**

Run: `node test/substrate-smoke.mjs` — Expected: exit 0, the printed `events` include `subagents:created`, `subagents:started`, `subagents:completed`, and `transcripts` has one path of the form `orchestrator/<session-basename>/tasks/<id>.jsonl`. Record the exact `transcripts[0]` value in the commit message — Task 10 depends on that layout.

- [ ] **Step 4: Commit** — `Substrate smoke: parent pi + pi-subagents + bridge spawns a child observed via lifecycle file and transcript`.

### Task 10: `lib/session-adapter.mjs` — child transcripts as supervisor events

**Files:**
- Create: `lib/session-adapter.mjs`, `test/session-adapter.test.mjs`, `test/fixtures/session-entries.jsonl`

**Interfaces:**
- Produces: `export function sessionEntryToEvents(entry) → Array<{type:"tool_execution_start", toolName, args, toolCallId} | {type:"tool_execution_end", toolCallId} | {type:"message_end", message}>`. Non-message entries (`session`, `session_info`, `model_change`, `thinking_level_change`) → `[]`.
- Consumes: pi session JSONL entries. Verified shapes (from `runs/2026-09-11T00-27-17/sessions/builder/*.jsonl`): `{"type":"message","message":{"role":"assistant","content":[{"type":"thinking",...},{"type":"text",...},{"type":"toolCall","id":"<id>","name":"read","arguments":{"path":"README.md"}}],"usage":{"input":2332,"output":74,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}` and `{"type":"message","message":{"role":"toolResult","toolCallId":"<id>","toolName":"read","content":[{"type":"text","text":"..."}]}}`.

- [ ] **Step 1: Build the fixture from a real session file**

Run:
```bash
f=$(ls runs/2026-09-11T00-27-17/sessions/builder/*.jsonl | head -1)
{ sed -n '1p' "$f"; grep -m1 '"role":"assistant"' "$f"; grep -m1 '"role":"toolResult"' "$f"; } > test/fixtures/session-entries.jsonl
wc -l test/fixtures/session-entries.jsonl   # expect 3
```

- [ ] **Step 2: Write the failing test**

`test/session-adapter.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionEntryToEvents } from "../lib/session-adapter.mjs";

const [sessionHeader, assistant, toolResult] = fs.readFileSync("test/fixtures/session-entries.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("non-message entries produce nothing", () => {
	assert.deepEqual(sessionEntryToEvents(sessionHeader), []);
});
test("an assistant message yields tool_execution_start per toolCall and one message_end", () => {
	const evs = sessionEntryToEvents(assistant);
	const starts = evs.filter((e) => e.type === "tool_execution_start");
	assert.ok(starts.length >= 1);
	assert.equal(starts[0].toolName, "read");
	assert.deepEqual(starts[0].args, { path: "README.md" });
	assert.equal(typeof starts[0].toolCallId, "string");
	const end = evs.find((e) => e.type === "message_end");
	assert.equal(end.message.role, "assistant");
	assert.equal(typeof end.message.usage.input, "number");
});
test("a toolResult message yields tool_execution_end with the same id", () => {
	const evs = sessionEntryToEvents(toolResult);
	assert.deepEqual(evs, [{ type: "tool_execution_end", toolCallId: toolResult.message.toolCallId }]);
});
```

- [ ] **Step 3: Run to verify failure** → FAIL.

- [ ] **Step 4: Create `lib/session-adapter.mjs`**

```js
// pi-subagents children are not on the parent's RPC stream, but pi persists each
// child's transcript in its session JSONL format. This turns those entries into the
// same event shapes the supervisor already handles for RPC-driven agents, so a child
// gets tool counts, edit timestamps, bash watchdog and cost accounting for free.
export function sessionEntryToEvents(entry) {
	if (entry?.type !== "message" || !entry.message) return [];
	const m = entry.message;
	if (m.role === "toolResult") return [{ type: "tool_execution_end", toolCallId: m.toolCallId }];
	if (m.role !== "assistant") return [];
	const out = [];
	for (const part of m.content ?? []) {
		if (part.type === "toolCall") out.push({ type: "tool_execution_start", toolName: part.name, args: part.arguments ?? {}, toolCallId: part.id });
	}
	out.push({ type: "message_end", message: m });
	return out;
}
```

- [ ] **Step 5: Run the test** → PASS.

- [ ] **Step 6: Commit** — `Session adapter: pi session JSONL entries -> supervisor events`.

### Task 11: `lib/child-transcripts.mjs` — find and tail worker transcripts

**Files:**
- Create: `lib/child-transcripts.mjs`, `test/child-transcripts.test.mjs`

**Interfaces:**
- Produces:
  - `export function childTranscriptDir(orchestratorSessionDir) → string | null`: given `RUN/sessions/orchestrator`, finds the single `*.jsonl` session file there and returns `<dir>/<basename-without-.jsonl>/tasks`, or `null` if no session file yet. (Layout from `node_modules/@gotgenes/pi-subagents/src/session-dir.ts`: `<parent-dir>/<parent-basename>/tasks/`.)
  - `export class JsonlTailer { constructor(filePath); readNew() → object[] }` — returns newly appended, fully-terminated JSON lines since the last call; tolerates a partial trailing line.
  - `export function workerIdFromTranscript(filePath) → string` — basename without `.jsonl`.

- [ ] **Step 1: Write the failing tests**

`test/child-transcripts.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childTranscriptDir, JsonlTailer, workerIdFromTranscript } from "../lib/child-transcripts.mjs";

test("childTranscriptDir derives <dir>/<base>/tasks from the parent session file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-sess-"));
	assert.equal(childTranscriptDir(dir), null);
	fs.writeFileSync(path.join(dir, "2026-09-11T13-00-00-000Z_abc.jsonl"), "");
	assert.equal(childTranscriptDir(dir), path.join(dir, "2026-09-11T13-00-00-000Z_abc", "tasks"));
});
test("JsonlTailer returns only new complete lines", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-tail-")), "t.jsonl");
	fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":');
	const t = new JsonlTailer(f);
	assert.deepEqual(t.readNew(), [{ a: 1 }, { a: 2 }]);
	assert.deepEqual(t.readNew(), []);
	fs.appendFileSync(f, '3}\n');
	assert.deepEqual(t.readNew(), [{ a: 3 }]);
});
test("workerIdFromTranscript is the file basename", () => {
	assert.equal(workerIdFromTranscript("C:\\x\\tasks\\41afd2c6.jsonl"), "41afd2c6");
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Create `lib/child-transcripts.mjs`**

```js
import fs from "node:fs";
import path from "node:path";

export function childTranscriptDir(orchestratorSessionDir) {
	if (!fs.existsSync(orchestratorSessionDir)) return null;
	const file = fs.readdirSync(orchestratorSessionDir).find((f) => f.endsWith(".jsonl"));
	if (!file) return null;
	return path.join(orchestratorSessionDir, file.slice(0, -".jsonl".length), "tasks");
}

export function workerIdFromTranscript(filePath) {
	return path.basename(filePath, ".jsonl");
}

export class JsonlTailer {
	constructor(filePath) {
		this.filePath = filePath;
		this.offset = 0;
		this.buf = "";
	}
	readNew() {
		const size = fs.statSync(this.filePath).size;
		if (size <= this.offset) return [];
		const fd = fs.openSync(this.filePath, "r");
		const chunk = Buffer.alloc(size - this.offset);
		fs.readSync(fd, chunk, 0, chunk.length, this.offset);
		fs.closeSync(fd);
		this.offset = size;
		this.buf += chunk.toString("utf8");
		const out = [];
		let i;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
		}
		return out;
	}
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit** — `Child transcript discovery and incremental JSONL tailer`.

### Task 12: Prompts and the orchestrator role in `send_mail`

**Files:**
- Create: `prompts/orchestrator.md`, `prompts/worker.md` (replace the placeholders from Task 7)
- Modify: `ext/mail-ext.ts`
- Test: `test/mail-ext-render.test.mjs`

**Interfaces:**
- Produces: `send_mail` for `AGENT_NAME=orchestrator`, `PEER=supervisor` offers kinds `status, done, probe`; `done` is described as claiming the shared workspace complete; `probe` text identical to the critic's.
- Consumes: `lib/text.mjs` cap is not used here (the extension caps bodies at `MAX_BODY` already).

- [ ] **Step 1: Write the failing render test**

`test/mail-ext-render.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PI = "C:/Users/user/open_harnessess/pi/pi";
function render(agent, peer) {
	const driver = path.join(os.tmpdir(), `mail-render-${process.pid}-${agent}.mjs`);
	fs.writeFileSync(driver, `
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/mail-ext.ts"))}).href + "?" + ${JSON.stringify(agent)});
		mod.default({ registerTool: (t) => console.log(JSON.stringify({ description: t.description, kinds: t.parameters.properties.kind.anyOf.map((k) => k.const) })) });
	`);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], { encoding: "utf8", env: { ...process.env, AGENT_NAME: agent, PEER: peer, BUS_FILE: "", NODE_PATH: `${PI}/node_modules` } });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout.trim());
}

test("builder has no probe kind", () => {
	assert.ok(!render("builder", "critic").kinds.includes("probe"));
});
test("critic has probe", () => {
	assert.ok(render("critic", "builder").kinds.includes("probe"));
});
test("orchestrator has probe and done, addressed to the supervisor", () => {
	const t = render("orchestrator", "supervisor");
	assert.deepEqual(t.kinds.sort(), ["done", "probe", "status"]);
	assert.match(t.description, /shared workspace/);
	assert.match(t.description, /host-side/);
});
```

- [ ] **Step 2: Run to verify failure** → the orchestrator test FAILS (kinds are the generic set).

- [ ] **Step 3: Edit `ext/mail-ext.ts`**

Change `PROBE_KIND` and `PROBE_HINT` conditions from `ME === "critic"` to `ME === "critic" || ME === "orchestrator"`. Add an orchestrator branch to `DONE_HINT` before the `SOLO` branch:
```ts
: ME === "orchestrator"
	? 'kind="done" claims the shared workspace is complete and triggers the hidden acceptance test. It only goes through if you have probed the workspace as it currently stands and no worker is mid-edit — the supervisor tells you why if it does not, and the fix is always a fresh probe, never resending the same claim.'
```
Restrict the kind enum per role: replace the `Type.Union([...])` list with
```ts
Type.Union((ME === "orchestrator" ? ["status", "done", "probe"] : ["question", "answer", "proposal", "status", "done", ...(PROBE_KIND.length ? ["probe"] : [])]).map((k) => Type.Literal(k)), { description: "What this message is doing." })
```
and delete the `...PROBE_KIND` spread it replaces.

- [ ] **Step 4: Run the test** → PASS.

- [ ] **Step 5: Write `prompts/orchestrator.md`**

```md
You are ORCHESTRATOR. You own a task whose specification is given below under SPECIFICATION. You do not write code. You break the task into pieces, delegate each piece to a worker, check what comes back, and claim completion when the shared workspace satisfies the specification.

What you have:
- `read`, `ls`, `grep` on the shared workspace (`src/` holds the deliverable). You can look; you cannot edit.
- `subagent` (subagent_type "worker"): starts a worker with a brief you write. Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.
- `steer_subagent` / `get_subagent_result`: continue or query a worker you already started. A worker keeps its context, so continuing one is cheaper than starting another for follow-up work.
- `send_mail` to the supervisor: `kind="probe"` runs specific inputs against the real code in the workspace, host-side, and returns the real values — this is how you verify, since a worker's report is its own claim. `kind="done"` claims completion; the supervisor accepts it only if your last probe matches the current, quiet workspace.

The supervisor is a program, not a model: it reports facts (probe results, test counts, remaining time) and does not converse.
```

- [ ] **Step 6: Write `prompts/worker.md`**

```md
You are a WORKER on a small JavaScript project (see README.md). An orchestrator has briefed you on one piece of work; the brief is your specification. Build it under `src/`, test it yourself (`node --test` or `node -e`, always with an explicit `timeout`), and finish your turn with a short report of exactly what you implemented and how you tested it — that report is what the orchestrator sees.

Only modify files under `src/`. Do not create configuration files, dot-directories, or anything outside `src/`.

If the brief is missing something you need, say precisely what is missing in your report rather than guessing silently.
```

- [ ] **Step 7: Commit** — `Orchestrator role in send_mail; orchestrator and worker prompts`.

### Task 13: `lib/worker-def.mjs` — generated worker agent definition

**Files:**
- Create: `lib/worker-def.mjs`, `test/worker-def.test.mjs`

**Interfaces:**
- Produces: `export function workerDefinition({ provider, model, tools, prompt, maxTurns = 60, background = false }) → string` (markdown with frontmatter keys `name: worker`, `description`, `tools` (comma-separated), `model: <provider>/<model>`, `max_turns`, `run_in_background`; body = prompt). `export function writeWorkerDefinition(workspaceDir, opts) → string` writes `<workspaceDir>/.pi/agents/worker.md` and `<workspaceDir>/.pi/subagents.json` (`{ "maxConcurrent": opts.max ?? 1 }`), returns the definition path.
- Consumes: frontmatter keys read by `node_modules/@gotgenes/pi-subagents/src/config/custom-agents.ts` (`fm.tools`, `fm.model`, `fm.max_turns`, `fm.run_in_background`, `fm.description`); settings file `<cwd>/.pi/subagents.json` key `maxConcurrent` (`src/settings.ts:3,196`).

- [ ] **Step 1: Write the failing tests**

`test/worker-def.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workerDefinition, writeWorkerDefinition } from "../lib/worker-def.mjs";

test("definition has the frontmatter pi-subagents reads", () => {
	const md = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read", "bash"], prompt: "Build it.", maxTurns: 12 });
	assert.match(md, /^---\nname: worker\n/);
	assert.match(md, /\ntools: read,bash\n/);
	assert.match(md, /\nmodel: llama\.cpp\/qwen3-27b\n/);
	assert.match(md, /\nmax_turns: 12\n/);
	assert.match(md, /\nrun_in_background: false\n---\nBuild it\.\n$/);
});
test("writeWorkerDefinition creates the agent file and the concurrency setting", () => {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-ws-"));
	const p = writeWorkerDefinition(ws, { provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x", max: 1 });
	assert.equal(p, path.join(ws, ".pi", "agents", "worker.md"));
	assert.ok(fs.existsSync(p));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, ".pi", "subagents.json"), "utf8")), { maxConcurrent: 1 });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Create `lib/worker-def.mjs`**

```js
import fs from "node:fs";
import path from "node:path";

// pi-subagents loads agent definitions from <cwd>/.pi/agents/*.md and its settings
// from <cwd>/.pi/subagents.json (src/config/custom-agents.ts, src/settings.ts). The
// workspace is the orchestrator's cwd, so both live there. Only src/ is ever copied
// to the oracle, so .pi/ never reaches a test.
export function workerDefinition({ provider, model, tools, prompt, maxTurns = 60, background = false }) {
	return [
		"---",
		"name: worker",
		"description: Builds one piece of the task from the orchestrator's brief.",
		`tools: ${tools.join(",")}`,
		`model: ${provider}/${model}`,
		`max_turns: ${maxTurns}`,
		`run_in_background: ${background}`,
		"---",
		prompt.trimEnd(),
		"",
	].join("\n");
}

export function writeWorkerDefinition(workspaceDir, opts) {
	const dir = path.join(workspaceDir, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "worker.md");
	fs.writeFileSync(file, workerDefinition(opts));
	fs.writeFileSync(path.join(workspaceDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: opts.max ?? 1 }));
	return file;
}
```

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit** — `Worker agent-definition generator with maxConcurrent setting`.

### Task 14: Wire the orchestrator pattern into `supervisor.mjs`

**Files:**
- Modify: `supervisor.mjs` — `launch()`, the go-section, `runProbe()`/`handleApproval()`/`runOracle()` workspace references, `checkIdle()`, `finish()`; new functions `pumpLifecycle()`, `pumpChildTranscripts()`, `orchestratorKickoff()`

**Interfaces:**
- Consumes: `lib/patterns.mjs` (`ORCHESTRATOR_TOOLS`, `WORKER_TOOLS`), `lib/worker-def.mjs`, `lib/child-transcripts.mjs`, `lib/session-adapter.mjs`, `lib/agents.mjs`, `ext/subagents-bridge.ts`.
- Produces: audit event types `spawn`, `resume`, `report`, `decide`, `worker_failed`; `summary.json` fields `orchestratorProbedBeforeDone` (boolean, orchestrator pattern only) and `workers` (count).

- [ ] **Step 1: The shared workspace is `WS.workspace`**

Rename `WS.builder` → `WS.workspace` throughout (`runProbe`, `handleApproval`, `runOracle`, `maybeQuiescentOracle`, `finish` archive loop, `launch` cwd). Keep the archive copying it into `RUN/ws-builder` for tool compatibility (Task 2's `extractRun` reads `ws-builder/src`). Drop `WS.critic` (an empty dir nobody used); `launch()` uses `cwd: WS.workspace` for every role.

- [ ] **Step 2: Orchestrator launch flags**

In `launch(name)`, after building `args`, add:
```js
if (name === "orchestrator") {
	const idx = args.indexOf("-e");
	args.splice(idx, 0,
		"-e", path.join(here, "node_modules/@gotgenes/pi-subagents/src/index.ts"),
		"-e", path.join(here, "ext", "subagents-bridge.ts"),
	);
}
```
and pass `ARBITER_LIFECYCLE_FILE: LIFECYCLE` in the spawn env, where `const LIFECYCLE = path.join(RUN, "lifecycle.jsonl");` is defined next to `BUS`. Before launching, when `PATTERN === "orchestrator"`:
```js
writeWorkerDefinition(WS.workspace, {
	provider: ROLES.worker.provider, model: ROLES.worker.model, tools: WORKER_TOOLS,
	prompt: fs.readFileSync(path.join(here, "prompts", "worker.md"), "utf8"),
	maxTurns: 60, background: ROLES.worker.background, max: ROLES.worker.max,
});
```

- [ ] **Step 3: Tail the lifecycle file**

```js
const lifecycleTail = PATTERN === "orchestrator" ? new JsonlTailer(LIFECYCLE) : null;
let pendingDecisionFor = null; // worker id whose report the orchestrator has just received
function pumpLifecycle() {
	if (!lifecycleTail || finished || !fs.existsSync(LIFECYCLE)) return;
	for (const { ev, data } of lifecycleTail.readNew()) {
		const wid = data?.id ? `worker:${data.id}` : null;
		lastActivity = Date.now();
		switch (ev) {
			case "subagents:created":
				if (wid && !state[wid]) { state[wid] = createAgentState({ id: wid, role: "worker" }); state[wid].name = wid; state[wid].ready = true; }
				log({ agent: "orchestrator", type: "spawn", msg: `spawn ${wid}: ${String(data.prompt ?? data.brief ?? "").replace(/\s+/g, " ").slice(0, 300)}` });
				timeline.push({ ts: Date.now(), from: "orchestrator", to: wid, kind: "spawn", body: String(data.prompt ?? data.brief ?? "") });
				break;
			case "subagents:started": if (wid && state[wid]) state[wid].status = "running"; break;
			case "subagents:resuming": case "subagents:resumed": case "subagents:steered":
				if (wid && state[wid]) state[wid].status = "running";
				log({ agent: "orchestrator", type: "resume", msg: `${ev.slice("subagents:".length)} ${wid}` });
				timeline.push({ ts: Date.now(), from: "orchestrator", to: wid, kind: "resume", body: String(data.message ?? data.prompt ?? "") });
				break;
			case "subagents:update":
				log({ agent: wid, type: "report", msg: `update: ${String(data.message ?? data.text ?? JSON.stringify(data)).replace(/\s+/g, " ").slice(0, 300)}` });
				timeline.push({ ts: Date.now(), from: wid, to: "orchestrator", kind: "report", body: String(data.message ?? data.text ?? "") });
				break;
			case "subagents:completed":
				if (wid && state[wid]) state[wid].status = "completed";
				log({ agent: wid, type: "report", msg: `completed: ${String(data.result ?? "").replace(/\s+/g, " ").slice(0, 300)}` });
				timeline.push({ ts: Date.now(), from: wid, to: "orchestrator", kind: "report", body: String(data.result ?? "") });
				pendingDecisionFor = wid;
				break;
			case "subagents:failed":
				if (wid && state[wid]) state[wid].status = "failed";
				log({ agent: wid, type: "worker_failed", msg: `failed: ${String(data.error ?? data.reason ?? JSON.stringify(data)).slice(0, 300)}` });
				pendingDecisionFor = wid;
				break;
		}
	}
}
```
(`data` field names — `id`, `prompt`, `result`, `message`, `error` — are taken from the spike's captured `subagents:record` entry (`{id, status, result}`) and the package's observer; Step 7's smoke run confirms them, and unknown fields degrade to `JSON.stringify(data)`.)

In `handle()`, at the top of `case "tool_execution_start"`, add:
```js
if (name === "orchestrator" && pendingDecisionFor) {
	log({ agent: "orchestrator", type: "decide", msg: `after ${pendingDecisionFor}: ${ev.toolName}${ev.toolName === "send_mail" ? `(${(ev.args ?? {}).kind})` : ""}` });
	pendingDecisionFor = null;
}
```

- [ ] **Step 4: Tail child transcripts**

```js
const childTails = new Map(); // transcript path -> JsonlTailer
function pumpChildTranscripts() {
	if (PATTERN !== "orchestrator" || finished) return;
	const dir = childTranscriptDir(path.join(RUN, "sessions", "orchestrator"));
	if (!dir || !fs.existsSync(dir)) return;
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
		const p = path.join(dir, f);
		if (!childTails.has(p)) childTails.set(p, new JsonlTailer(p));
		const wid = `worker:${workerIdFromTranscript(p)}`;
		if (!state[wid]) { state[wid] = createAgentState({ id: wid, role: "worker" }); state[wid].name = wid; state[wid].ready = true; state[wid].status = "running"; }
		if (!state[wid].raw) state[wid].raw = fs.createWriteStream(path.join(RUN, `raw-${wid.replace(":", "_")}.jsonl`), { flags: "a" });
		for (const entry of childTails.get(p).readNew()) {
			for (const ev of sessionEntryToEvents(entry)) {
				state[wid].raw.write(`${JSON.stringify(ev)}\n`);
				handle(wid, ev);
			}
		}
	}
}
```
`handle()` must tolerate agents with no `child` process: in `send()` the existing guard `if (!s || s.child.exitCode !== null)` becomes `if (!s || !s.child || s.child.exitCode !== null)`; `deliver()` to a worker id is never called (workers are steered by the orchestrator, not the supervisor) — add `if (s.role === "worker") return;` at the top of `deliver()`. The bash watchdog's abort for a worker cannot use RPC; in `checkBashTimeout()` when `s.role === "worker"` log the timeout and `deliver("orchestrator", "[SUPERVISOR] Worker <id> has had a bash command running for Ns; steer it to stop or wait.", "worker bash timeout")` instead of `send(..., abort)`.

- [ ] **Step 5: Timers, kickoff, quiescence, summary**

Add `setInterval(pumpLifecycle, 200); setInterval(pumpChildTranscripts, 500);`. Kickoff for the orchestrator (in the ready timer, `PATTERN === "orchestrator"` branch):
```js
deliver("orchestrator", '[SUPERVISOR] Session start. The specification is in your system prompt. Read README.md and src/, decide how to split the work, and start a worker with subagent_type "worker". Verify with kind="probe" before you claim kind="done".', "kickoff");
```
In `maybeQuiescentOracle()` (now used for solo and orchestrator), add the condition `liveWorkers(Object.values(state)).length === 0`. `finish()` adds to `summary`: `workers: Object.values(state).filter((s) => s.role === "worker").length` and, when `PATTERN === "orchestrator"`, `orchestratorProbedBeforeDone: probeCountAtFirstOracle > 0` where `let probeCountAtFirstOracle = null;` is set to `probeCount` the first time `runOracle()` runs. Worker raw streams are closed in `finish()` alongside the agents' streams.

- [ ] **Step 6: Verify statically**

`node --check supervisor.mjs && node --test test/` → PASS.

- [ ] **Step 7: Live smoke of the orchestrator pattern**

Create `configs/smoke-orch.json`:
```json
{ "task": "glob", "pattern": "orchestrator",
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-27b" }, "worker": { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 } },
  "caps": { "wallSec": 240, "toolCalls": 40 } }
```
Run: `timeout 300 node supervisor.mjs --config configs/smoke-orch.json 2>&1 | tail -40`
Expected within 240 s: banner shows `pattern orchestrator`; `orchestrator: <- kickoff`; an `orchestrator: spawn worker:<id>: ...` line; `worker:<id>: read ...` / `write ...` lines from the transcript tailer; either a `report` line or the wall cap. `RUN/lifecycle.jsonl` exists with at least `subagents:created`; `RUN/raw-worker_<id>.jsonl` exists; `summary.json` has `"workers": 1` and `"orchestratorProbedBeforeDone"`. If the lifecycle `data` field names differ from Step 3's assumptions, adjust the `data.x ?? data.y` fallbacks to the observed names and re-run. Delete the smoke run dir afterwards.

- [ ] **Step 8: Commit** — `Orchestrator pattern: pi-subagents workers observed via lifecycle file and transcripts, gated on the shared workspace`.

### Task 15: Instrumentation: delegation tree in the transcript, first-run configs

**Files:**
- Modify: `supervisor.mjs` `finish()` (transcript rendering), `tools/extract-runs.mjs` (worker events already flow; add `spawn`/`resume`/`report`/`decide`/`worker_failed` audit types to the event mapping as kind `"delegation"`), `tools/console.template.html` (render `delegation` events as a distinct row style; agent lanes keyed by role prefix)
- Create: `configs/orch-orbit-flash.json`, `configs/orch-orbit-glm.json`, `configs/orch-orbit-gpt54mini.json`, `configs/orch-orbit-sonnet5.json`, `configs/orch-orbit-qwen9b.json`, `configs/solo-glob-local.json`, `configs/dyad-glob-local.json`

**Interfaces:**
- Consumes: the timeline entries with kinds `spawn`, `resume`, `report` from Task 14.

- [ ] **Step 1: Delegation tree in `transcript.md`**

In `finish()`, before writing `transcript.md`, when `PATTERN === "orchestrator"` prepend a section:
```js
if (PATTERN === "orchestrator") {
	md.push("## Delegation", "");
	const byWorker = new Map();
	for (const m of timeline) {
		if (m.kind === "spawn") byWorker.set(m.to, [`- **${m.to}** spawned at ${((m.ts - startedAt) / 1000).toFixed(0)}s — brief: ${m.body.replace(/\s+/g, " ").slice(0, 200)}`]);
		if ((m.kind === "resume" || m.kind === "report") && byWorker.has(m.kind === "resume" ? m.to : m.from)) {
			byWorker.get(m.kind === "resume" ? m.to : m.from).push(`  - ${m.kind} at ${((m.ts - startedAt) / 1000).toFixed(0)}s: ${m.body.replace(/\s+/g, " ").slice(0, 160)}`);
		}
	}
	for (const lines of byWorker.values()) md.push(...lines);
	md.push("");
}
```

- [ ] **Step 2: Extraction and console**

In `tools/extract-runs.mjs`'s audit mapping add: `else if (["spawn","resume","report","decide","worker_failed"].includes(a.type)) events.push({ t: Number(a.t), kind: "delegation", agent: a.agent ?? null, sub: a.type, text: a.msg });`. In the console template's feed renderer add a branch for `kind === "delegation"` that renders like a `tool` row but with an amber left border and the `sub` label as its tag; in the facet list add `{ key: "delegation", label: "DELEGATION" }`. Agent colour: any agent id starting with `worker:` uses the builder colour (klein); `orchestrator` uses the critic colour (amber).

- [ ] **Step 3: Run configs**

`configs/orch-orbit-flash.json`:
```json
{ "task": "orbit", "pattern": "orchestrator",
  "roles": { "orchestrator": { "provider": "llama.cpp", "model": "qwen3-flash" }, "worker": { "provider": "llama.cpp", "model": "qwen3-flash", "max": 1 } },
  "caps": { "toolCalls": 250, "wallSec": 6000, "usd": 5, "doneAttempts": 5 } }
```
`configs/orch-orbit-glm.json`: same with `"orchestrator": { "provider": "zai", "model": "glm-5.3-flash" }`, `"worker": { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1 }`.
`configs/orch-orbit-gpt54mini.json`: orchestrator `{ "provider": "openai", "model": "gpt-5.4-mini" }`, same worker.
`configs/orch-orbit-sonnet5.json`: orchestrator `{ "provider": "anthropic", "model": "claude-sonnet-5" }`, same worker.
`configs/orch-orbit-qwen9b.json`: orchestrator `{ "provider": "llama.cpp", "model": "qwen3.5-9b" }`, same worker (requires the 9B download and a `models.ini` entry — noted in the file's `"_note"` field).
`configs/solo-glob-local.json` and `configs/dyad-glob-local.json`: the two smoke configs used in Task 7, with the normal 6000 s / 1500 s caps.

- [ ] **Step 4: Rebuild the console over all runs and check the new run renders**

Run: `node tools/extract-runs.mjs && node tools/build-console.mjs` and open `tools/console.html`; select the Task 14 smoke run if it was kept, or the first real run after Task 16. Delegation rows appear in the feed and the DELEGATION facet toggles them.

- [ ] **Step 5: Commit** — `Delegation tree in transcript, delegation events in console, first-run configs`.

### Task 16: First real run — Flash-Next as orchestrator and worker

**Files:**
- Modify: nothing in the repo (a run). If `qwen3-flash` does not resolve in pi's llama.cpp catalog, add it to `~/.pi/agent/models.json` (`providers["llama.cpp"].models`, per `<PI>/packages/coding-agent/src/core/model-config.ts:199-214`) — outside the repo.

- [ ] **Step 1: Confirm the model resolves**

The router (`--models-max 1`) serves `qwen3-flash` from `models.ini` on demand. Run: `cd <PI> && node node_modules/tsx/dist/cli.mjs packages/coding-agent/src/cli.ts --no-session -ne -na -ns -np -nc --provider llama.cpp --model qwen3-flash -p "Reply with exactly: ok"`. Expected: `ok` (first call loads the model, allow ~60 s). If the model id is rejected, add a `models.json` entry with `id: "qwen3-flash"`, `contextWindow: 65536`, `reasoning: true` and retry.

- [ ] **Step 2: Launch**

Run: `cd /c/Users/user/open_harnessess/pi/arbiter && node supervisor.mjs --config configs/orch-orbit-flash.json > runs-orch-flash.log 2>&1 &` and monitor `runs-orch-flash.log` for `spawn`, `report`, `decide`, `probe #`, `Approval not accepted`, `Oracle run`, `FINISH`, `model error`, `stalled`.

- [ ] **Step 3: Record the result**

After `FINISH`: `node tools/extract-runs.mjs && node tools/build-console.mjs && node tools/kpi.mjs | tail -3`. Read `summary.json` for `orchestratorProbedBeforeDone`, `workers`, `reason`, `wallSec`, and `transcript.md`'s Delegation section. Note the three behaviours the spec scores by hand: did it probe before `done`; did it probe after any report; did it resume a worker or spawn fresh ones. Add these as a short entry at the end of the spec (§6) under a "Results" heading, then commit: `First orchestrator run (Flash-Next): <one-line result>`.

- [ ] **Step 4: Continue the matrix**

Repeat Steps 2–3 for `orch-orbit-glm.json`, `orch-orbit-gpt54mini.json`, `orch-orbit-sonnet5.json` once their provider keys are in `~/.pi/agent/auth.json` (`type: "api_key"`), each preceded by the provider's one-line smoke test from the setup checklist. `orch-orbit-qwen9b.json` waits for the 9B download and the 27B's context reduced to 64k in `models.ini` (its `[qwen3-27b]` section: `ctx-size = 65536`) so both fit in VRAM.

---

## Self-review notes (done while writing)

- Spec §2 rename + config → Tasks 1, 7. §3 tools per role → Tasks 7, 12, 13 (worker tools are the frontmatter list; `notify_parent`/`ask_parent` are injected by the package). §4 substrate, observation, per-agent state, gate, oracle flag, one-live-worker (resolved: `maxConcurrent` in `.pi/subagents.json`, Task 13), reporting caps (bridge `cap()`, Task 8), lifetime → Tasks 8–14. §5 instrumentation → Tasks 14 (events, `decide`, summary fields), 15 (transcript tree, console). §6 first runs → Tasks 15, 16. §7 tests → every lib task; substrate smoke Task 9; live smokes Tasks 1, 7, 14. §8 failure handling → Task 14 Step 4 (worker bash timeout, missing child process), lifecycle `failed` handling, existing caps. §9 phase two → not built; recorded. §10 open items → 1 resolved (Task 13), 2 sidestepped (workers report via package tools), 3 written (Task 12), 4 done (Task 2), 5 done before this plan (`git init`).
- `oracle.reportFailingInputs` is parsed (Task 7) but the oracle change to emit failing inputs is intentionally not in this plan: the spec keeps it off for the first runs; implementing it is a one-task follow-up (`runOracle` parses `not ok N - <title>` lines from the TAP output and appends them to the builder/orchestrator verdict when the flag is set).
- Names used consistently: `handleApproval` (renamed from `handleCriticApproval` in Task 6), `WS.workspace` (Task 14), `createAgentState`, `lastEditAcross`, `liveWorkers`, `routeMail`, `decideApproval`, `truncateForMail`, `sessionEntryToEvents`, `childTranscriptDir`, `JsonlTailer`, `workerIdFromTranscript`, `workerDefinition`, `writeWorkerDefinition`, `loadConfig`, `parseArgs`, `PATTERNS`, `ORCHESTRATOR_TOOLS`, `WORKER_TOOLS`, `BUILDER_TOOLS`, `LIFECYCLE_EVENTS`.
