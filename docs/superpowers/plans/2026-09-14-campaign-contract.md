# Campaign Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a campaign a validated JSON document run by one generic driver, with a per-run token cap in the supervisor and a per-campaign token ceiling that skips rounds instead of starving them, plus `--from` for crash recovery.

**Architecture:** `lib/campaign.mjs` holds every decision (loader and validator, legacy-args shim, `decideRound`, the novelty tally and its seeding); `lib/usage.mjs` holds token accounting shared by the KPI and the driver; the supervisor gains `caps.tokens` and `summary.tokens`. `tools/campaign.mjs` is rewritten as the only driver; `tools/research.mjs` is deleted and its three phases become `campaigns/spe162910.json`.

**Tech Stack:** Node 26 (`node:test`, `node:child_process`), the existing supervisor and run layout (`runs/<id>/summary.json`, `raw-*.jsonl`, `ws-builder/src/<deliverable>`).

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-borrowings-design.md` §4

## Global Constraints

- Work in `C:\Users\user\open_harnessess\pi\arbiter` on `master`. Never touch `C:\Users\user\open_harnessess\pi\pi`.
- Precondition: `git status --short` clean before Task 1 (the pre-spawn-compact work from 2026-09-14 is the user's to commit first; if it is still there, stop and ask).
- Commit with `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"`; never write git config.
- Run tests with `npm test`. All existing tests keep passing.
- Bash heredocs on this Windows Git Bash mangle backslashes; write files containing a backslash with the Write/Edit tools.
- Token numbers are fresh input + output per assistant `message_end`, never cache reads — the same definition `E_excl` uses in `tools/kpi.mjs`.
- `caps.tokens` defaults to 0 (off). No existing config changes meaning.
- Live runs need the local llama router up (`qwen-flash/serve.ps1`, `PRESET=router`, port 8080). While a campaign runs, do not edit `supervisor.mjs`, `lib/` or `ext/`.
- Deliverable names are exactly the four `supervisor.mjs` retention looks for: `exploration.json`, `study.json`, `report.json`, `watchlist.json`.

---

## File map

| File | Responsibility |
|---|---|
| `lib/usage.mjs` (new) | `tokenTotals(runDir)` (moved from `tools/kpi.mjs`), `freshTokens(runDir)` |
| `tools/kpi.mjs` (modify) | import `tokenTotals` from the library |
| `lib/config.mjs` (modify) | `caps.tokens` default 0, env `ARBITER_CAP_TOKENS` |
| `lib/agents.mjs` (modify) | `tokens: 0` in per-agent state |
| `supervisor.mjs` (modify) | per-agent token accounting, `totals().tokens`, the cap, `summary.tokens`, the FINISH line |
| `lib/campaign.mjs` (new) | `DELIVERABLES`, `loadCampaign`, `validateCampaign`, `legacyCampaign`, `median`, `decideRound`, `noveltyTally`, `findingsWithRows`, `seedTally` |
| `tools/campaign.mjs` (rewrite) | the one driver: JSON or legacy args, `--from`, `--tokens`, `--dry`, report, rows sidecar |
| `tools/research.mjs` (delete) | replaced by `campaigns/spe162910.json` |
| `campaigns/spe162910.json`, `campaigns/dw-explore-real.json` (new) | the two campaigns that exist today, as data |
| `test/usage.test.mjs`, `test/campaign.test.mjs`, `test/campaign-driver.test.mjs` (new); `test/config.test.mjs` (modify) | tests |
| `docs/backlog.md` (modify), `docs/batch/campaign-dw-explore-real.md` (produced by the live check) | notes and the measurement |

---

### Task 1: `lib/usage.mjs` — token totals as a library

**Files:**
- Create: `lib/usage.mjs`
- Modify: `tools/kpi.mjs` (delete its local `tokenTotals`, import it; drop the now-unused `readJsonl` import)
- Test: `test/usage.test.mjs`

**Interfaces:**
- Produces: `tokenTotals(dir) → { input, output, cacheRead, cacheWrite, turns, byRole }`; `freshTokens(dir) → input + output`.

- [ ] **Step 1: Write the failing test** — create `test/usage.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenTotals, freshTokens } from "../lib/usage.mjs";

test("tokenTotals sums fresh input and output per assistant message_end across raw-*.jsonl, by role", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-usage-"));
	const line = (role, input, output, cacheRead = 0) => JSON.stringify({ type: "message_end", message: { role, usage: { input, output, cacheRead, cacheWrite: 0 } } });
	fs.writeFileSync(path.join(dir, "raw-orchestrator.jsonl"), [line("assistant", 100, 20), line("user", 999, 999), line("assistant", 50, 5, 400), JSON.stringify({ type: "tool_call" })].join("\n") + "\n");
	fs.writeFileSync(path.join(dir, "raw-worker_abc.jsonl"), line("assistant", 30, 10) + "\n");
	fs.writeFileSync(path.join(dir, "audit.jsonl"), "{}\n");
	assert.deepEqual(tokenTotals(dir), { input: 180, output: 35, cacheRead: 400, cacheWrite: 0, turns: 3, byRole: { orchestrator: 175, worker: 40 } });
	assert.equal(freshTokens(dir), 215);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/usage.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `lib/usage.mjs`:

```js
// Token accounting from a run's raw-*.jsonl streams (one per agent process, one per
// child transcript): fresh input + output per assistant message_end, plus cache reads,
// split by role. Shared by tools/kpi.mjs (E_excl) and tools/campaign.mjs (the budget),
// so both count the same thing.
import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";

export function tokenTotals(dir) {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		turns = 0;
	const byRole = {};
	const rawFiles = fs.readdirSync(dir).filter((f) => /^raw-.*\.jsonl$/.test(f));
	for (const f of rawFiles) {
		const role = f.slice(4).split(/[_.]/)[0];
		for (const ev of readJsonl(path.join(dir, f))) {
			if (ev.type !== "message_end") continue;
			const m = ev.message;
			if (!m || m.role !== "assistant" || !m.usage) continue;
			input += m.usage.input || 0;
			output += m.usage.output || 0;
			cacheRead += m.usage.cacheRead || 0;
			cacheWrite += m.usage.cacheWrite || 0;
			turns++;
			byRole[role] = (byRole[role] || 0) + (m.usage.input || 0) + (m.usage.output || 0);
		}
	}
	return { input, output, cacheRead, cacheWrite, turns, byRole };
}

/** What a hosted API would bill for the run: fresh input + generated output, no cache reads. */
export function freshTokens(dir) {
	const t = tokenTotals(dir);
	return t.input + t.output;
}
```

Then in `tools/kpi.mjs`: delete the local `function tokenTotals(dir) { ... }`, replace `import { readJsonl } from "../lib/jsonl.mjs";` with `import { tokenTotals } from "../lib/usage.mjs";`.

- [ ] **Step 4: Run the tests and the KPI**

Run: `node --test test/usage.test.mjs && node tools/kpi.mjs | head -5`
Expected: PASS; the KPI prints its header and rows as before.

- [ ] **Step 5: Commit**

```bash
git add lib/usage.mjs tools/kpi.mjs test/usage.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "usage: tokenTotals as a library shared by the KPI and the campaign driver" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 2: Per-run token cap

**Files:**
- Modify: `lib/config.mjs` (`CAP_DEFAULTS`, `CAP_ENV`), `lib/agents.mjs` (`createAgentState`), `supervisor.mjs` (`message_end` accounting, `totals()`, `checkCaps()`, `finish()`)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `CAPS.tokens` (0 = off); per-agent `s.tokens`; `totals().tokens`; `summary.tokens`; finish reason `CAP: tokens N >= M`; env `ARBITER_CAP_TOKENS`.

- [ ] **Step 1: Write the failing test** — append to `test/config.test.mjs`:

```js
test("caps.tokens: off by default, set from the file, env ARBITER_CAP_TOKENS overrides", () => {
	const roles = { builder: { provider: "llama.cpp", model: "qwen3-27b" } };
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles }), env: {} }).caps.tokens, 0);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, caps: { tokens: 250000 } }), env: {} }).caps.tokens, 250000);
	assert.equal(loadConfig({ configPath: tmpConfig({ task: "glob", pattern: "solo", roles, caps: { tokens: 250000 } }), env: { ARBITER_CAP_TOKENS: "1000" } }).caps.tokens, 1000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `caps.tokens` is `undefined`.

- [ ] **Step 3: Implement**

`lib/config.mjs`: in `CAP_DEFAULTS` add `tokens: 0` (after `bashTimeoutSec: 90`), in `CAP_ENV` add `tokens: "ARBITER_CAP_TOKENS"`, and extend the comment above `CAP_DEFAULTS` with: `// tokens 0 = no token cap; otherwise fresh input + output across every agent ends the run the way usd does (tools/campaign.mjs passes a campaign's remainder here).`

`lib/agents.mjs`: in `createAgentState`, change `cost: 0,` to `cost: 0, tokens: 0,`.

`supervisor.mjs`:
- in the `message_end` case, after `s.cost += m.usage?.cost?.total ?? 0;` add `s.tokens += (m.usage?.input ?? 0) + (m.usage?.output ?? 0);`
- in `totals()`, after the `cost:` line add `tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0),`
- in `checkCaps()`, after the `usd` line add `if (CAPS.tokens && t.tokens >= CAPS.tokens) return finish(\`CAP: tokens ${t.tokens} >= ${CAPS.tokens}\`);`
- in `finish()`, after `summary.snapshot = SNAPSHOT;` add `summary.tokens = t.tokens;`
- in the FINISH log line, after `| $${t.cost.toFixed(3)}` add `| ${t.tokens} tokens`.

- [ ] **Step 4: Run the tests, then a 60-second capped smoke and a token-capped smoke** (router up)

Run: `npm test`
Expected: PASS.

Run: `ARBITER_CAP_WALL=60 node supervisor.mjs --config configs/smoke-orch.json`; then with `<id>` the new run: `node -e "const s=require('./runs/<id>/summary.json');console.log(s.reason, s.tokens)"`
Expected: `CAP: wall ...` and a positive token count.

Run: `ARBITER_CAP_TOKENS=1500 ARBITER_CAP_WALL=600 node supervisor.mjs --config configs/smoke-orch.json`; then the same one-liner.
Expected: reason starts with `CAP: tokens` and `tokens >= 1500`.

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs lib/agents.mjs supervisor.mjs test/config.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "caps.tokens: per-run fresh-token cap (env ARBITER_CAP_TOKENS); summary.tokens" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 3: `lib/campaign.mjs` — loader, validator, legacy shim

**Files:**
- Create: `lib/campaign.mjs`
- Test: `test/campaign.test.mjs`

**Interfaces:**
- Produces: `DELIVERABLES`; `loadCampaign(file, { root })` and `validateCampaign(raw, { root, file })` → `{ name, phases: [{ phase, config, rounds, file }], brake: { minNovelty, sameTitle }, budget: null | { tokens } }`; `legacyCampaign(argv, { root })` → the same shape or `null` when `argv[0]` ends with `.json`.

- [ ] **Step 1: Write the failing tests** — create `test/campaign.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCampaign, validateCampaign, legacyCampaign } from "../lib/campaign.mjs";

function root() {
	const r = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-camp-"));
	fs.mkdirSync(path.join(r, "configs"));
	fs.writeFileSync(path.join(r, "configs", "a.json"), JSON.stringify({ task: "orbit" }));
	fs.writeFileSync(path.join(r, "configs", "b.json"), JSON.stringify({ task: "orbit" }));
	return r;
}
const good = { name: "demo", phases: [{ phase: "study", config: "configs/a.json", rounds: 2, file: "study.json" }, { phase: "apply", config: "configs/b.json", rounds: 1 }], brake: { minNovelty: 0.6 }, budget: { tokens: 1000 } };

test("a valid campaign loads with defaults filled", () => {
	const r = root();
	const file = path.join(r, "demo.json");
	fs.writeFileSync(file, JSON.stringify(good));
	const c = loadCampaign(file, { root: r });
	assert.equal(c.name, "demo");
	assert.deepEqual(c.phases, [{ phase: "study", config: "configs/a.json", rounds: 2, file: "study.json" }, { phase: "apply", config: "configs/b.json", rounds: 1, file: null }]);
	assert.deepEqual(c.brake, { minNovelty: 0.6, sameTitle: 0.4 });
	assert.deepEqual(c.budget, { tokens: 1000 });
	assert.equal(validateCampaign({ name: "x", phases: [{ phase: "p", config: "configs/a.json", rounds: 1 }] }, { root: r }).budget, null);
});

test("every malformed shape fails at load with the field named", () => {
	const r = root();
	const bad = (patch, re) => assert.throws(() => validateCampaign({ ...good, ...patch }, { root: r, file: "t.json" }), re);
	bad({ phases: [] }, /phases must be a non-empty list/);
	bad({ phases: [{ phase: "p", config: "configs/nope.json", rounds: 1 }] }, /config "configs\/nope\.json" not found/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 0 }] }, /rounds must be an integer >= 1/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1, extra: 1 }] }, /phases\[0\]: unknown key "extra"/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1, file: "notes.json" }] }, /file must be one of exploration\.json, study\.json, report\.json, watchlist\.json/);
	bad({ phases: [{ phase: "p", config: "configs/a.json", rounds: 1 }, { phase: "p", config: "configs/b.json", rounds: 1 }] }, /phase "p" appears twice/);
	bad({ name: "bad name" }, /name must match/);
	bad({ budget: { tokens: 1.5 } }, /budget\.tokens must be an integer >= 1/);
	bad({ budget: { usd: 5 } }, /unknown budget key "usd"/);
	bad({ brake: { minNovelty: 2 } }, /brake\.minNovelty must be between 0 and 1/);
	bad({ surprise: true }, /unknown key "surprise"/);
});

test("legacy args become a one-phase campaign; a .json first argument is not legacy", () => {
	const r = root();
	const c = legacyCampaign(["explore-3", "configs/a.json", "--rounds", "4", "--min-novelty", "0.3"], { root: r });
	assert.equal(c.name, "explore-3");
	assert.deepEqual(c.phases, [{ phase: "explore", config: "configs/a.json", rounds: 4, file: "exploration.json" }]);
	assert.deepEqual(c.brake, { minNovelty: 0.3, sameTitle: 0.4 });
	assert.equal(c.budget, null);
	assert.equal(legacyCampaign(["campaigns/x.json"], { root: r }), null);
	assert.equal(legacyCampaign([], { root: r }), null);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/campaign.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `lib/campaign.mjs` (this task's part; Tasks 4 and 5 append to it):

```js
// A campaign is data: phases run in order, each a run config repeated for up to
// `rounds` rounds, with a novelty brake and an optional token budget. Validated the
// way lib/config.mjs validates a run config — unknown keys are errors and every config
// path must exist — so a hand-edited or model-authored campaign fails at load, not two
// hours in. Every decision the driver makes lives here so it can be tested without
// spawning a supervisor.
import fs from "node:fs";
import path from "node:path";
import { findingsOf } from "./memory.mjs";

// The deliverable names supervisor.mjs retention looks for, in the same order.
export const DELIVERABLES = ["exploration.json", "study.json", "report.json", "watchlist.json"];
const NAME = /^[\w.-]+$/;
const BRAKE_DEFAULTS = { minNovelty: 0.5, sameTitle: 0.4 };

export function loadCampaign(file, { root }) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`campaign ${file}: ${err.message}`);
	}
	return validateCampaign(raw, { root, file });
}

export function validateCampaign(raw, { root, file = "(inline)" }) {
	const where = `campaign ${file}`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
	for (const k of Object.keys(raw)) if (!["name", "phases", "brake", "budget", "_note"].includes(k)) throw new Error(`${where}: unknown key "${k}"`);
	if (typeof raw.name !== "string" || !NAME.test(raw.name)) throw new Error(`${where}: name must match ${NAME}`);
	if (!Array.isArray(raw.phases) || !raw.phases.length) throw new Error(`${where}: phases must be a non-empty list`);
	const phases = raw.phases.map((p, i) => {
		const at = `${where}: phases[${i}]`;
		if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`${at}: not an object`);
		for (const k of Object.keys(p)) if (!["phase", "config", "rounds", "file"].includes(k)) throw new Error(`${at}: unknown key "${k}"`);
		if (typeof p.phase !== "string" || !NAME.test(p.phase)) throw new Error(`${at}: phase must match ${NAME}`);
		if (typeof p.config !== "string" || !fs.existsSync(path.resolve(root, p.config))) throw new Error(`${at}: config "${p.config}" not found under ${root}`);
		if (!Number.isInteger(p.rounds) || p.rounds < 1) throw new Error(`${at}: rounds must be an integer >= 1`);
		if (p.file != null && !DELIVERABLES.includes(p.file)) throw new Error(`${at}: file must be one of ${DELIVERABLES.join(", ")}`);
		return { phase: p.phase, config: p.config, rounds: p.rounds, file: p.file ?? null };
	});
	const dup = phases.map((p) => p.phase).find((n, i, a) => a.indexOf(n) !== i);
	if (dup) throw new Error(`${where}: phase "${dup}" appears twice`);
	const brake = { ...BRAKE_DEFAULTS };
	if (raw.brake != null) {
		if (typeof raw.brake !== "object" || Array.isArray(raw.brake)) throw new Error(`${where}: brake must be an object`);
		for (const k of Object.keys(raw.brake)) {
			if (!(k in BRAKE_DEFAULTS)) throw new Error(`${where}: unknown brake key "${k}"`);
			const v = Number(raw.brake[k]);
			if (!(v >= 0 && v <= 1)) throw new Error(`${where}: brake.${k} must be between 0 and 1`);
			brake[k] = v;
		}
	}
	let budget = null;
	if (raw.budget != null) {
		if (typeof raw.budget !== "object" || Array.isArray(raw.budget)) throw new Error(`${where}: budget must be an object`);
		for (const k of Object.keys(raw.budget)) if (k !== "tokens") throw new Error(`${where}: unknown budget key "${k}" (only tokens)`);
		if (!Number.isInteger(raw.budget.tokens) || raw.budget.tokens < 1) throw new Error(`${where}: budget.tokens must be an integer >= 1`);
		budget = { tokens: raw.budget.tokens };
	}
	return { name: raw.name, phases, brake, budget };
}

/**
 * `node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]`
 * — the form every campaign report before 2026-09-14 was produced with. Returns null
 * when the first argument is a campaign file (the new form) or is missing.
 */
export function legacyCampaign(argv, { root }) {
	const [name, config] = argv;
	if (!name || !config || name.endsWith(".json")) return null;
	const opt = (flag, dflt) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? Number(argv[i + 1]) : dflt;
	};
	return validateCampaign(
		{ name, phases: [{ phase: "explore", config, rounds: opt("--rounds", 3), file: "exploration.json" }], brake: { minNovelty: opt("--min-novelty", 0.5), sameTitle: opt("--same-title", 0.4) } },
		{ root, file: "(legacy args)" },
	);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/campaign.test.mjs`
Expected: PASS (three tests).

- [ ] **Step 5: Commit**

```bash
git add lib/campaign.mjs test/campaign.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "campaign: loader/validator for campaigns/<name>.json and the legacy-args shim" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 4: `median` and `decideRound`

**Files:**
- Modify: `lib/campaign.mjs` (append)
- Test: `test/campaign.test.mjs` (append)

**Interfaces:**
- Produces: `median(nums) → number | null`; `decideRound({ budgetTokens = null, spentTokens = 0, roundTokens = [] }) → { run, remaining, reason }`.

- [ ] **Step 1: Write the failing tests** — append to `test/campaign.test.mjs` (add `median, decideRound` to the import):

```js
test("median: empty is null, odd and even lengths, ignores non-finite", () => {
	assert.equal(median([]), null);
	assert.equal(median([5]), 5);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([1, NaN, 3]), 2);
});

test("decideRound: no budget always runs; exhausted skips; below the median round skips; otherwise runs with the remainder", () => {
	assert.deepEqual(decideRound({}), { run: true, remaining: null, reason: null });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 1000 }), { run: false, remaining: 0, reason: "budget exhausted (1000 of 1000 tokens spent)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 1200, roundTokens: [1200] }), { run: false, remaining: 0, reason: "budget exhausted (1200 of 1000 tokens spent)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 700, roundTokens: [200, 300] }), { run: true, remaining: 300, reason: null });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 800, roundTokens: [400, 400] }), { run: false, remaining: 200, reason: "remaining 200 tokens below the median round (400)" });
	assert.deepEqual(decideRound({ budgetTokens: 1000, spentTokens: 0, roundTokens: [] }), { run: true, remaining: 1000, reason: null });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/campaign.test.mjs`
Expected: FAIL — `median`/`decideRound` not exported.

- [ ] **Step 3: Implement** — append to `lib/campaign.mjs`:

```js
export function median(nums) {
	const s = [...nums].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!s.length) return null;
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Whether the next round runs. No budget: always. Otherwise skip when nothing is left,
 * or when what is left is below the median cost of the rounds already run — a round
 * that would be starved fails its oracle and leaves a partial episode in memory; a
 * round that is skipped leaves nothing, and the report says why. `remaining` is what
 * the round that does run gets as its own caps.tokens.
 */
export function decideRound({ budgetTokens = null, spentTokens = 0, roundTokens = [] } = {}) {
	if (budgetTokens == null) return { run: true, remaining: null, reason: null };
	const remaining = Math.max(0, budgetTokens - spentTokens);
	if (remaining <= 0) return { run: false, remaining, reason: `budget exhausted (${spentTokens} of ${budgetTokens} tokens spent)` };
	const med = median(roundTokens);
	if (med !== null && remaining < med) return { run: false, remaining, reason: `remaining ${remaining} tokens below the median round (${med})` };
	return { run: true, remaining, reason: null };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/campaign.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/campaign.mjs test/campaign.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "campaign: decideRound — skip a round the budget cannot afford, never starve it" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 5: The novelty tally and its seeding

**Files:**
- Modify: `lib/campaign.mjs` (append)
- Test: `test/campaign.test.mjs` (append)

**Interfaces:**
- Consumes: `findingsOf(doc)` from `lib/memory.mjs` (index-aligned with `doc.observations` for explorer deliverables).
- Produces: `findingsWithRows(doc)`; `noveltyTally({ sameTitle }) → { absorb(findings), absorbTitles(titles), isKnown(o), size() }`; `seedTally(tally, { runsDir, memoryLog, tasks, scopes }) → { runs, findings, fromMemory }`.

- [ ] **Step 1: Write the failing tests** — append to `test/campaign.test.mjs` (add `noveltyTally, findingsWithRows, seedTally` to the import):

```js
test("noveltyTally: same normalised query, identical rows, similar title, or novel", () => {
	const t = noveltyTally({ sameTitle: 0.4 });
	assert.equal(t.absorb([{ title: "Water cut rises sharply in county 421 after 2019", query: "SELECT a FROM t;", result: [{ a: 1 }] }]), 1);
	assert.equal(t.isKnown({ title: "something else entirely", query: "select   a from t" }), "same query");
	assert.equal(t.isKnown({ title: "something else entirely", query: "SELECT b FROM u", result: [{ a: 1 }] }), "same result");
	assert.equal(t.isKnown({ title: "Water cut rises sharply in county 421 after 2020", query: "SELECT c FROM v", result: [{ c: 9 }] }), "similar title");
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county", query: "SELECT c FROM v", result: [{ c: 9 }] }), null);
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county" }), null, "no query and no rows: title only");
	assert.equal(t.absorbTitles(["Gas oil ratio flat in Lea county"]), 1);
	assert.equal(t.isKnown({ title: "Gas oil ratio flat in Lea county" }), "similar title");
	assert.equal(t.size(), 2);
});

test("findingsWithRows carries each observation's query and rows next to the retention-shaped finding", () => {
	const doc = { observations: [{ id: "O1", title: "T1", claim: "observed", observation: "x", query: "SELECT 1", result: [{ n: 1 }] }] };
	const [f] = findingsWithRows(doc);
	assert.equal(f.title, "T1");
	assert.equal(f.query, "SELECT 1");
	assert.deepEqual(f.result, [{ n: 1 }]);
	assert.deepEqual(findingsWithRows(null), []);
});

test("seedTally reads earlier runs' deliverables for the campaign's tasks and semantic titles for its scopes", () => {
	const r = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-seed-"));
	const runs = path.join(r, "runs");
	const mk = (id, task, name, doc) => {
		fs.mkdirSync(path.join(runs, id, "ws-builder", "src"), { recursive: true });
		fs.writeFileSync(path.join(runs, id, "summary.json"), JSON.stringify({ task }));
		fs.writeFileSync(path.join(runs, id, "ws-builder", "src", name), JSON.stringify(doc));
	};
	mk("2026-09-01T00-00-00", "dw-explore-real", "exploration.json", { observations: [{ id: "O1", title: "Alpha beta gamma delta", query: "SELECT 1", result: [] }] });
	mk("2026-09-02T00-00-00", "other-task", "exploration.json", { observations: [{ id: "O1", title: "Epsilon zeta eta theta", query: "SELECT 2", result: [] }] });
	fs.mkdirSync(path.join(runs, ".campaign-x"));
	const log = path.join(r, "records.jsonl");
	fs.writeFileSync(log, [JSON.stringify({ scope: "repo:dw", kind: "semantic", summary: "Iota kappa lambda mu" }), JSON.stringify({ scope: "repo:elsewhere", kind: "semantic", summary: "Nu xi omicron pi" }), JSON.stringify({ scope: "repo:dw", kind: "episodic", text: "..." }), JSON.stringify({ scope: "repo:dw", op: "tombstone" })].join("\n") + "\n");
	const t = noveltyTally();
	assert.deepEqual(seedTally(t, { runsDir: runs, memoryLog: log, tasks: ["dw-explore-real"], scopes: ["repo:dw"] }), { runs: 1, findings: 1, fromMemory: 1 });
	assert.equal(t.isKnown({ title: "Alpha beta gamma delta" }), "similar title");
	assert.equal(t.isKnown({ title: "Epsilon zeta eta theta" }), null, "other task's run is not a seed");
	assert.equal(t.isKnown({ title: "Iota kappa lambda mu" }), "similar title");
	assert.equal(t.isKnown({ title: "Nu xi omicron pi" }), null, "other scope is not a seed");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/campaign.test.mjs`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — append to `lib/campaign.mjs`:

```js
// Novelty is judged on three signals, any of which marks a finding as already found:
// the same normalised query was run before; the result rows are identical to an
// earlier finding's (the same fact in other words — titles paraphrase, rows do not);
// or the title is similar (Jaccard on content words; 0.4 not 0.5 — at 0.5 paraphrases
// passed as novel in campaign explore-2).
const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be", "are", "than", "no", "not", "only"]);
const tokens = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9_.%-]+/).filter((t) => t.length > 1 && !STOP.has(t)));
export function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}
const normSql = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
const fingerprint = (rows) => JSON.stringify(rows ?? []);

/** findingsOf() plus each observation's query and result rows, which the tally needs and the retention shape drops. */
export function findingsWithRows(doc) {
	return findingsOf(doc).map((o, i) => ({ ...o, title: String(o.title ?? ""), query: doc?.observations?.[i]?.query, result: doc?.observations?.[i]?.result }));
}

export function noveltyTally({ sameTitle = 0.4 } = {}) {
	const seen = { queries: new Set(), results: new Set(), titles: [] };
	return {
		absorb(findings) {
			let n = 0;
			for (const o of Array.isArray(findings) ? findings : []) {
				if (!o || typeof o !== "object") continue;
				if (o.query) seen.queries.add(normSql(o.query));
				if (Array.isArray(o.result) && o.result.length) seen.results.add(fingerprint(o.result));
				seen.titles.push(tokens(o.title));
				n++;
			}
			return n;
		},
		absorbTitles(titles) {
			for (const t of titles) seen.titles.push(tokens(t));
			return titles.length;
		},
		isKnown(o) {
			if (o?.query && seen.queries.has(normSql(o.query))) return "same query";
			if (Array.isArray(o?.result) && o.result.length && seen.results.has(fingerprint(o.result))) return "same result";
			if (seen.titles.some((prev) => jaccard(tokens(o?.title), prev) >= sameTitle)) return "similar title";
			return null;
		},
		size() {
			return seen.titles.length;
		},
	};
}

/**
 * Seed the tally from every earlier run's deliverable for the campaign's tasks (a
 * seed-data exploration must not brake a real-data one, so tasks are matched exactly)
 * and from the semantic record titles in its memory scopes (runs whose directories
 * are gone). The legacy "Findings digest" blobs are not parsed: migrateDigests()
 * already turned them into semantic records.
 */
export function seedTally(tally, { runsDir, memoryLog, tasks, scopes }) {
	let runs = 0;
	let findings = 0;
	let fromMemory = 0;
	const readJson = (p) => {
		try {
			return JSON.parse(fs.readFileSync(p, "utf8"));
		} catch {
			return null;
		}
	};
	for (const d of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
		if (!/^\d{4}-/.test(d)) continue;
		const s = readJson(path.join(runsDir, d, "summary.json"));
		if (!s || !tasks.includes(s.task)) continue;
		for (const name of DELIVERABLES) {
			const doc = readJson(path.join(runsDir, d, "ws-builder", "src", name));
			if (!doc) continue;
			runs++;
			findings += tally.absorb(findingsWithRows(doc));
			break;
		}
	}
	if (fs.existsSync(memoryLog)) {
		for (const line of fs.readFileSync(memoryLog, "utf8").split("\n")) {
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (!r || r.op || !scopes.includes(r.scope) || r.kind !== "semantic" || !r.summary) continue;
			fromMemory += tally.absorbTitles([r.summary]);
		}
	}
	return { runs, findings, fromMemory };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/campaign.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/campaign.mjs test/campaign.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "campaign: novelty tally and seeding as library code with tests" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 6: The driver, the two campaign files, the deletion

**Files:**
- Rewrite: `tools/campaign.mjs`
- Create: `campaigns/spe162910.json`, `campaigns/dw-explore-real.json`
- Delete: `tools/research.mjs`
- Test: `test/campaign-driver.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `supervisor.mjs --config <file>` with env `ARBITER_CAP_TOKENS`; `summary.tokens`.
- Produces: `docs/batch/campaign-<name>.md`; `runs/.campaign-<name>/rows.json` (or `dry.json`); stdout lines prefixed `[campaign <name>]`.

- [ ] **Step 1: Write the failing test** — create `test/campaign-driver.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The driver's control flow with nothing spawned: --dry lists every round and the
// caps.tokens each would get, honours --from, and writes no report.
test("--dry plans every round, honours --from, runs nothing", () => {
	const name = `drytest-${process.pid}`;
	const camp = path.join(os.tmpdir(), `${name}.json`);
	fs.writeFileSync(camp, JSON.stringify({ name, phases: [{ phase: "a", config: "configs/smoke-orch.json", rounds: 2 }, { phase: "b", config: "configs/smoke-orch.json", rounds: 1, file: "report.json" }], budget: { tokens: 1000 } }));
	const r = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry"], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /a round 1\/2: would run smoke-orch\.json with caps\.tokens=1000/);
	assert.match(r.stdout, /a round 2\/2: would run/);
	assert.match(r.stdout, /b round 1\/1: would run/);
	assert.match(r.stdout, /dry run: 3 round\(s\) planned/);
	assert.ok(!fs.existsSync(path.join("docs", "batch", `campaign-${name}.md`)), "no report on a dry run");
	const plan = JSON.parse(fs.readFileSync(path.join("runs", `.campaign-${name}`, "dry.json"), "utf8"));
	assert.deepEqual(plan.rows.map((x) => [x.phase, x.round, x.skipped]), [["a", 1, "dry run"], ["a", 2, "dry run"], ["b", 1, "dry run"]]);

	const from = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry", "--from", "b:1"], { encoding: "utf8" });
	assert.equal(from.status, 0, from.stderr);
	const plan2 = JSON.parse(fs.readFileSync(path.join("runs", `.campaign-${name}`, "dry.json"), "utf8"));
	assert.deepEqual(plan2.rows.map((x) => [x.phase, x.round, x.skipped]), [["a", 1, "before --from b:1"], ["a", 2, "before --from b:1"], ["b", 1, "dry run"]]);

	const bad = spawnSync(process.execPath, ["tools/campaign.mjs", camp, "--dry", "--from", "zzz:1"], { encoding: "utf8" });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /--from must be <phase>:<round>/);
	fs.rmSync(path.join("runs", `.campaign-${name}`), { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/campaign-driver.test.mjs`
Expected: FAIL — the current driver treats the first argument as a name and prints usage.

- [ ] **Step 3: Rewrite `tools/campaign.mjs`** (Write tool; replace the whole file):

```js
// One driver for every campaign: phases in order, each a run config repeated for up
// to `rounds` rounds; round N+1 recalls what round N retained into memory. Brakes,
// per phase: a round that fails its oracle ends the phase, and so does a round whose
// findings are no longer novel (same query, identical rows, or a similar title against
// everything found before). A phase with no passing round ends the campaign. Budget:
// with `budget.tokens` (or --tokens), a round is skipped — and listed as skipped — when
// the budget is exhausted or the remainder is below the median round so far; a round
// that does run gets the remainder as its own caps.tokens, so one run cannot overshoot.
//
//   node tools/campaign.mjs campaigns/<name>.json [--from <phase>:<round>] [--tokens N] [--dry]
//   node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]
//
// --from starts partway (crash recovery; earlier rounds are listed as skipped, the
// novelty tally still seeds from disk and memory). --dry prints the round plan and the
// seed counts and runs nothing. Per-round logs in runs/.campaign-<name>/; the report in
// docs/batch/campaign-<name>.md; the rows in runs/.campaign-<name>/rows.json.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCampaign, legacyCampaign, decideRound, noveltyTally, seedTally, findingsWithRows, DELIVERABLES } from "../lib/campaign.mjs";
import { freshTokens } from "../lib/usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const camp = argv[0]?.endsWith(".json") ? loadCampaign(path.resolve(ROOT, argv[0]), { root: ROOT }) : legacyCampaign(argv, { root: ROOT });
if (!camp) {
	console.error("usage: node tools/campaign.mjs campaigns/<name>.json [--from <phase>:<round>] [--tokens N] [--dry]\n       node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]");
	process.exit(1);
}
const budgetTokens = opt("--tokens") != null ? Number(opt("--tokens")) : (camp.budget?.tokens ?? null);
if (budgetTokens != null && !(Number.isInteger(budgetTokens) && budgetTokens > 0)) {
	console.error("--tokens must be a positive integer");
	process.exit(1);
}
let from = null;
if (opt("--from") != null) {
	const m = /^([\w.-]+):(\d+)$/.exec(opt("--from"));
	if (!m || !camp.phases.some((p) => p.phase === m[1])) {
		console.error(`--from must be <phase>:<round> with a phase from the campaign (${camp.phases.map((p) => p.phase).join(", ")})`);
		process.exit(1);
	}
	from = { phase: m[1], round: Number(m[2]) };
}
const DRY = flag("--dry");
const logDir = path.join(ROOT, "runs", `.campaign-${camp.name}`);
fs.mkdirSync(logDir, { recursive: true });
const say = (s) => console.log(`[campaign ${camp.name}] ${s}`);
const readJson = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

const phases = camp.phases.map((p) => ({ ...p, cfg: readJson(path.resolve(ROOT, p.config)) ?? {} }));
const tasks = [...new Set(phases.map((p) => p.cfg.task).filter(Boolean))];
const scopes = [...new Set(phases.map((p) => (p.cfg.repo ? `repo:${p.cfg.repo}` : `task:${p.cfg.task}`)))];
const tally = noveltyTally({ sameTitle: camp.brake.sameTitle });
const seeded = seedTally(tally, { runsDir: path.join(ROOT, "runs"), memoryLog: path.join(ROOT, "memory", "records.jsonl"), tasks, scopes });
say(`novelty tally seeded: ${seeded.findings} finding(s) from ${seeded.runs} earlier run(s) on disk (tasks ${tasks.join(", ")}), ${seeded.fromMemory} title(s) from memory (${scopes.join(", ")})`);

function runOne(phase, round, config, env) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(path.join(logDir, `${phase}-${round}.log`), "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, ...env } });
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}
function deliverableOf(runId, file) {
	const dir = path.join(ROOT, "runs", runId, "ws-builder", "src");
	for (const name of file ? [file] : DELIVERABLES) {
		const doc = readJson(path.join(dir, name));
		if (doc) return doc;
	}
	return null;
}

const t0 = Date.now();
const rows = [];
const roundTokens = [];
let spent = 0;
let stopped = null;
let beforeFrom = Boolean(from);
for (const ph of phases) {
	if (stopped) break;
	let passed = 0;
	for (let round = 1; round <= ph.rounds; round++) {
		if (beforeFrom && !(ph.phase === from.phase && round >= from.round)) {
			rows.push({ phase: ph.phase, round, skipped: `before --from ${from.phase}:${from.round}` });
			continue;
		}
		beforeFrom = false;
		const d = decideRound({ budgetTokens, spentTokens: spent, roundTokens });
		if (!d.run) {
			rows.push({ phase: ph.phase, round, skipped: d.reason });
			say(`${ph.phase} round ${round}: skipped — ${d.reason}`);
			continue;
		}
		const caps = d.remaining != null ? ` with caps.tokens=${d.remaining}` : "";
		if (DRY) {
			rows.push({ phase: ph.phase, round, skipped: "dry run" });
			say(`${ph.phase} round ${round}/${ph.rounds}: would run ${path.basename(ph.config)}${caps}`);
			continue;
		}
		say(`${new Date().toISOString()} ${ph.phase} round ${round}/${ph.rounds} start (${path.basename(ph.config)}${caps})`);
		const { runId, code } = await runOne(ph.phase, round, path.resolve(ROOT, ph.config), d.remaining != null ? { ARBITER_CAP_TOKENS: String(d.remaining) } : {});
		const s = runId ? readJson(path.join(ROOT, "runs", runId, "summary.json")) : null;
		const tokens = runId ? (typeof s?.tokens === "number" ? s.tokens : freshTokens(path.join(ROOT, "runs", runId))) : 0;
		spent += tokens;
		roundTokens.push(tokens);
		const doc = runId ? deliverableOf(runId, ph.file) : null;
		const findings = findingsWithRows(doc);
		const verdicts = findings.map((o) => ({ id: o.id, claim: o.claim, title: o.title, known: tally.isKnown(o) }));
		const fresh = verdicts.filter((v) => !v.known);
		const novelty = findings.length ? fresh.length / findings.length : 0;
		const mem = s?.memory?.calls ?? {};
		const row = {
			phase: ph.phase, round, runId, exit: code, reason: s?.reason ?? "(no summary)", wallSec: s?.wallSec ?? "", tokens, probes: s?.mailByKind?.probe ?? 0,
			searches: mem.searches ?? 0, gets: mem.gets ?? 0, refused: mem.refused ?? 0, compactions: s?.compactions?.length ?? 0,
			findings: findings.length, fresh: fresh.length, novelty, verdicts, open: [...(doc?.next_questions ?? []), ...(doc?.unresolved ?? [])],
		};
		rows.push(row);
		say(`${ph.phase} round ${round}: ${row.reason} in ${row.wallSec}s, ${tokens} tokens${budgetTokens != null ? ` (${spent}/${budgetTokens} spent)` : ""}; ${findings.length} findings, ${fresh.length} novel (novelty ${novelty.toFixed(2)}); memory ${row.searches}/${row.gets}/${row.refused}; ${row.compactions} compaction(s)`);
		tally.absorb(findings);
		if (!String(row.reason).startsWith("SUCCESS")) {
			say(`stop ${ph.phase}: round ${round} did not pass the oracle`);
			break;
		}
		passed++;
		if (round < ph.rounds && novelty < camp.brake.minNovelty) {
			say(`stop ${ph.phase}: novelty ${novelty.toFixed(2)} < ${camp.brake.minNovelty} — the phase has converged`);
			break;
		}
	}
	// A phase that ran and never passed ends the campaign; a phase that was skipped
	// entirely (--from, budget) does not — the next phase decides for itself.
	const ran = rows.filter((r) => r.phase === ph.phase && r.runId).length;
	if (ran && !passed) stopped = `phase ${ph.phase} had no passing round`;
}
if (stopped) say(`campaign stopped: ${stopped}`);

const lastPhase = phases[phases.length - 1].phase;
const last = [...rows].reverse().find((r) => r.runId && r.phase === lastPhase && String(r.reason).startsWith("SUCCESS"));
const reportPath = last ? path.join(ROOT, "runs", last.runId, "ws-builder", "src", "report.md") : null;
const reportMd = reportPath && fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8").trim() : null;
const md = [
	`# Campaign ${camp.name} — ${phases.map((p) => `${p.phase} ×${p.rounds} (${path.basename(p.config)})`).join(" → ")}`,
	"",
	`${rows.filter((r) => r.runId).length} round(s) run, ${rows.filter((r) => r.skipped).length} skipped, ${((Date.now() - t0) / 3600_000).toFixed(2)} h. Brake per phase: oracle failure, or novelty < ${camp.brake.minNovelty} (same query, identical rows, or title Jaccard ≥ ${camp.brake.sameTitle} against everything found before; seeded from ${seeded.findings} finding(s) in ${seeded.runs} run(s) on disk and ${seeded.fromMemory} title(s) in memory).${budgetTokens != null ? ` Budget: ${spent} of ${budgetTokens} tokens spent.` : " No token budget."}${stopped ? ` Campaign stopped: ${stopped}.` : ""}`,
	"",
	"| phase | round | run | outcome | wall s | tokens | probes | mem search/get/refused | compactions | findings | novel | novelty |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|",
	...rows.map((r) => (r.skipped ? `| ${r.phase} | ${r.round} | — | skipped: ${r.skipped} | | | | | | | | |` : `| ${r.phase} | ${r.round} | ${r.runId ?? "—"} | ${r.reason} | ${r.wallSec} | ${r.tokens} | ${r.probes} | ${r.searches}/${r.gets}/${r.refused} | ${r.compactions} | ${r.findings} | ${r.fresh} | ${r.novelty.toFixed(2)} |`)),
	"",
	...rows.filter((r) => r.runId).flatMap((r) => [`## ${r.phase} round ${r.round} — ${r.runId}`, "", ...r.verdicts.map((v) => `- ${v.id ?? ""} [${v.claim ?? "?"}]${v.known ? ` (${v.known})` : ""} ${v.title}`), "", ...(r.open.length ? ["Left open:", "", ...r.open.map((q) => `- ${q}`), ""] : [])]),
	...(reportMd ? ["## The report (final phase, verbatim)", "", reportMd, ""] : []),
];
if (!DRY) {
	fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
	fs.writeFileSync(path.join(ROOT, "docs", "batch", `campaign-${camp.name}.md`), md.join("\n"));
}
fs.writeFileSync(path.join(logDir, DRY ? "dry.json" : "rows.json"), JSON.stringify({ campaign: camp, budgetTokens, spent, rows }, null, 2));
say(DRY ? `dry run: ${rows.filter((r) => r.skipped === "dry run").length} round(s) planned, plan in ${path.relative(ROOT, path.join(logDir, "dry.json"))}` : `report: docs/batch/campaign-${camp.name}.md`);
```

- [ ] **Step 4: The two campaign files** — create `campaigns/spe162910.json`:

```json
{
  "name": "spe162910",
  "_note": "Deep research on SPE 162910 as a campaign (was tools/research.mjs until 2026-09-14): a cited reading, the paper's models on real wells, one synthesis whose citations the oracle resolves. Memory scope repo:research-162910. First run 2026-09-13: 5/5 rounds passed, report docs/batch/research-spe162910.md.",
  "phases": [
    { "phase": "study",     "config": "configs/orch-dw-paper-study-27b.json",     "rounds": 2, "file": "study.json" },
    { "phase": "apply",     "config": "configs/orch-dw-paper-apply-27b.json",     "rounds": 3, "file": "exploration.json" },
    { "phase": "synthesis", "config": "configs/orch-dw-paper-synthesis-27b.json", "rounds": 1, "file": "report.json" }
  ],
  "brake": { "minNovelty": 0.5, "sameTitle": 0.4 }
}
```

and `campaigns/dw-explore-real.json`:

```json
{
  "name": "dw-explore-real",
  "_note": "Self-recursive exploration of the real warehouse (93 M rows): each round recalls what the last retained. The budget admits about one round at 27B (a round is roughly 400k fresh tokens); raise it for a longer campaign.",
  "phases": [
    { "phase": "explore", "config": "configs/orch-dw-explore-real-27b.json", "rounds": 3, "file": "exploration.json" }
  ],
  "budget": { "tokens": 500000 }
}
```

Then delete `tools/research.mjs` (`git rm tools/research.mjs`).

- [ ] **Step 5: Run the tests**

Run: `node --test test/campaign-driver.test.mjs test/campaign.test.mjs && npm test`
Expected: PASS everywhere; the driver test leaves no `runs/.campaign-drytest-*` directory behind.

Also: `node tools/campaign.mjs campaigns/spe162910.json --dry`
Expected: six planned rounds (2 + 3 + 1), seed counts for scope `repo:research-162910`, no report written.

- [ ] **Step 6: Commit**

```bash
git add tools/campaign.mjs campaigns/ test/campaign-driver.test.mjs
git rm -q tools/research.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "campaign: one driver for campaigns/<name>.json (token budget, --from, --dry); research.mjs becomes campaigns/spe162910.json" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 7: Live check — a budget that admits one round — and the backlog

**Files:**
- Produced: `docs/batch/campaign-dw-explore-real.md`, `runs/.campaign-dw-explore-real/rows.json`
- Modify: `docs/backlog.md`

- [ ] **Step 1: Dry run first**

Run: `node tools/campaign.mjs campaigns/dw-explore-real.json --dry`
Expected: `explore round 1/3: would run orch-dw-explore-real-27b.json with caps.tokens=500000`, then rounds 2 and 3 likewise (nothing spent yet), and the seed line naming task `dw-explore-real` and scope `repo:data-warehousers-real`.

- [ ] **Step 2: The real run** (router up; about 25–45 minutes; run in the background; do not edit `supervisor.mjs`, `lib/` or `ext/` meanwhile)

Run: `node tools/campaign.mjs campaigns/dw-explore-real.json`
Expected stdout, in order: round 1 runs and reports its token count; round 2 is either `skipped — remaining N tokens below the median round (M)` (the usual case, one round costs about 400k) or runs with `caps.tokens=<remainder>` and ends `CAP: tokens …` if the first round was unusually cheap; the report path at the end.

- [ ] **Step 3: Read the result**

```bash
sed -n '1,12p' docs/batch/campaign-dw-explore-real.md
node -e "const r=require('./runs/.campaign-dw-explore-real/rows.json');console.log(JSON.stringify(r.rows.map(x=>({phase:x.phase,round:x.round,runId:x.runId,reason:x.reason,tokens:x.tokens,skipped:x.skipped})),null,1),'spent',r.spent,'of',r.budgetTokens)"
```

Expected: one `SUCCESS` row with a token count equal to that run's `summary.tokens`, at least one `skipped:` row with a reason, and the header line `Budget: <spent> of 500000 tokens spent.`

- [ ] **Step 4: Backlog** — append to the section `## From Claude Code's Workflow tool (2026-09-14 — …)` in `docs/backlog.md` (create the section if the worker-report plan has not yet):

```markdown
25. **Campaign contract** — done 2026-09-14 (`lib/campaign.mjs`, `tools/campaign.mjs`, `campaigns/*.json`; `tools/research.mjs` deleted). Per-run `caps.tokens` + per-campaign `budget.tokens`: a round is skipped, never starved, when the remainder is below the median round; `--from` for crash recovery, no cached rounds by design (rounds read and write memory). First budgeted run: `docs/batch/campaign-dw-explore-real.md`. Next: a Claude Code seat emitting the campaign document (the model writes the script; the oracle still gates every round).
```

- [ ] **Step 5: Commit**

```bash
git add docs/backlog.md docs/batch/campaign-dw-explore-real.md memory/
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "campaign: first budgeted dw-explore-real run, backlog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```
