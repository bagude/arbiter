# Per-Role Thinking Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a run config set a thinking level per role, pass it to pi (`--thinking`) and to pi-subagents (worker frontmatter), give the local Qwen3 models the one switch pi can actually reach, and measure the worker's thinking share in a paired run.

**Architecture:** `roles.<role>.thinking` is validated in `lib/config.mjs`; supervisor-launched roles get `--thinking <level>`; the worker definition gets a `thinking:` line. The local `llama.cpp` models are declared non-reasoning in the user's pi models store, so pi sends no reasoning parameter for them — a five-minute curl spike (Task 1) confirms which per-request switch llama-server honours for Qwen3, and Task 3 implements the one pi can reach: the `/no_think` soft switch appended to the role's system prompt when `thinking` is `off` on that provider.

**Tech Stack:** Node 26 (`node:test`), pi CLI (`--thinking`, valid levels `off, minimal, low, medium, high, xhigh, max`), `@gotgenes/pi-subagents` (frontmatter `thinking:`, valid levels the same list without `max`), llama-server router on port 8080.

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-borrowings-design.md` §2

## Global Constraints

- Work in `C:\Users\user\open_harnessess\pi\arbiter` on `master`. Never touch `C:\Users\user\open_harnessess\pi\pi`. Never edit `~/.pi/agent/models-store.json` from a plan step; if a step would need it, stop and ask.
- Precondition: `git status --short` clean before Task 2 (the pre-spawn-compact work from 2026-09-14 is the user's to commit first; if it is still there, stop and ask). Task 1 writes nothing.
- Commit with `git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"`; never write git config.
- Run tests with `npm test`. All existing tests keep passing.
- The llama router key file is `.llama-api-key` next to `serve.ps1` in `C:\Users\user\Downloads\claude_playground\os\qwen-flash`. Read it into a shell variable or a `$(cat …)` header; never print it, never paste it into a file.
- Nothing changes for a config without `thinking`: no flag, no frontmatter line, no prompt suffix.
- While the paired batch runs, do not edit `supervisor.mjs`, `lib/` or `ext/`.

---

## File map

| File | Responsibility |
|---|---|
| `lib/config.mjs` (modify) | `THINKING_LEVELS`, `WORKER_THINKING_LEVELS`, `roles.<role>.thinking`, env `ROLE_<name>_THINKING` |
| `lib/worker-def.mjs` (modify) | `thinking:` frontmatter line; `thinkingSuffix({ provider, model, thinking })` |
| `supervisor.mjs` (modify) | `AGENTS[role].thinking`, `--thinking` on launch, `launch` audit line, prompt suffix for supervisor-launched roles, worker definition inputs |
| `configs/orch-dw-explore-real-27b-nothink.json` (new) | the treatment |
| `test/config.test.mjs`, `test/worker-def.test.mjs` (modify) | tests |
| `docs/batch/thinking-level.md` (new), `docs/backlog.md` (modify) | the measurement and the backlog note |

---

### Task 1: Spike — which per-request switch does llama-server honour for Qwen3?

**Files:** none written. Output: three numbers in the terminal, recorded in Task 5's report.

Why: pi only sends `reasoning_effort` for a model declared `reasoning: true` with `compat.supportsReasoningEffort: true`; the user's `llama.cpp` entries in `~/.pi/agent/models-store.json` say `false` for both. The thinking in worker transcripts is Qwen3's own `<think>` output, relayed by llama-server as `reasoning_content` and parsed by pi into thinking blocks. So `--thinking` changes nothing locally unless something else does.

- [ ] **Step 1: Confirm the router is up and the 27B model is loaded**

```bash
KEY=$(cat /c/Users/user/open_harnessess/pi/qwen-flash/.llama-api-key)
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8080/v1/models | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log((JSON.parse(s).data||[]).map(m=>m.id)))"
```

Expected: a list including `qwen3-27b`. If the router is down, start it (`PRESET=router` in `qwen-flash/serve.ps1`) and wait for the model to load.

- [ ] **Step 2: Three requests, same prompt, different switches** — run each and print the length of `reasoning_content`:

```bash
ask() { curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" http://127.0.0.1:8080/v1/chat/completions -d "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const m=j.choices?.[0]?.message??{};console.log(JSON.stringify({reasoning_chars:(m.reasoning_content||m.reasoning||'').length,content_head:String(m.content||'').slice(0,60),error:j.error?.message}))})"; }
ask '{"model":"qwen3-27b","max_tokens":200,"messages":[{"role":"user","content":"What is 17*23? Answer with the number only."}]}'
ask '{"model":"qwen3-27b","max_tokens":200,"messages":[{"role":"user","content":"What is 17*23? Answer with the number only. /no_think"}]}'
ask '{"model":"qwen3-27b","max_tokens":200,"chat_template_kwargs":{"enable_thinking":false},"messages":[{"role":"user","content":"What is 17*23? Answer with the number only."}]}'
ask '{"model":"qwen3-27b","max_tokens":200,"reasoning_effort":"low","messages":[{"role":"user","content":"What is 17*23? Answer with the number only."}]}'
```

Expected (to be confirmed, this is the spike): the first shows `reasoning_chars` in the hundreds; the `/no_think` and `enable_thinking:false` requests show 0 or near 0; `reasoning_effort` shows either an `error` or the same as the first. Record all four lines.

- [ ] **Step 3: Decide** — write the four results into the terminal summary and pick:
  - `/no_think` works → Task 3 as written (the suffix).
  - only `enable_thinking:false` works → pi cannot send it; Task 3 is dropped, and the report in Task 5 records that per-role thinking on the local stack needs a server-level switch (a second router alias with `--reasoning-budget 0`), which is outside arbiter. Tasks 2 and 4 still ship (hosted providers honour the level).
  - neither works → same as above.

---

### Task 2: Config key `roles.<role>.thinking`

**Files:**
- Modify: `lib/config.mjs` (exports at the top, the `roles` loop)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`, `WORKER_THINKING_LEVELS` (same without `max`); `roles.<role>.thinking` present only when set; env `ROLE_<name>_THINKING`.

- [ ] **Step 1: Write the failing test** — append to `test/config.test.mjs`:

```js
test("roles.<role>.thinking: absent by default, validated, the worker rejects max, env overrides", () => {
	const roles = { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" }, worker: { provider: "llama.cpp", model: "qwen3-27b" } };
	const none = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: {} });
	assert.equal("thinking" in none.roles.worker, false);
	assert.equal("thinking" in none.roles.orchestrator, false);
	const set = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { orchestrator: { ...roles.orchestrator, thinking: "max" }, worker: { ...roles.worker, thinking: "low" } } }), env: {} });
	assert.equal(set.roles.orchestrator.thinking, "max");
	assert.equal(set.roles.worker.thinking, "low");
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, worker: { ...roles.worker, thinking: "max" } } }), env: {} }), /roles\.worker\.thinking must be one of off, minimal, low, medium, high, xhigh in/);
	assert.throws(() => loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles: { ...roles, orchestrator: { ...roles.orchestrator, thinking: "lots" } } }), env: {} }), /roles\.orchestrator\.thinking must be one of off, minimal, low, medium, high, xhigh, max in/);
	const env = loadConfig({ configPath: tmpConfig({ task: "orbit", pattern: "orchestrator", roles }), env: { ROLE_worker_THINKING: "off" } });
	assert.equal(env.roles.worker.thinking, "off");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `thinking` is never set and junk is not rejected.

- [ ] **Step 3: Implement** — in `lib/config.mjs`, below the `CAP_ENV` line add:

```js
// pi's thinking levels (cli/args.js VALID_THINKING_LEVELS). pi-subagents reads the same
// list minus "max" from a worker definition's `thinking:` line (src/config/thinking-level.ts)
// and silently drops an unknown value — so the worker's is checked here, loudly.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WORKER_THINKING_LEVELS = THINKING_LEVELS.filter((l) => l !== "max");
```

and inside the `for (const name of def.roles)` loop, directly after `roles[name] = { provider, model };`, add:

```js
		const thinking = env[`ROLE_${name}_THINKING`] || r?.thinking;
		if (thinking != null) {
			const allowed = name === "worker" ? WORKER_THINKING_LEVELS : THINKING_LEVELS;
			if (!allowed.includes(thinking)) throw new Error(`roles.${name}.thinking must be one of ${allowed.join(", ")} in ${configPath}, got ${JSON.stringify(thinking)}`);
			roles[name].thinking = thinking;
		}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs test/config.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "config: roles.<role>.thinking (pi levels; worker without max; env ROLE_<name>_THINKING)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 3: Worker definition line and the local `off` switch

**Files:**
- Modify: `lib/worker-def.mjs` (`workerDefinition`, new `thinkingSuffix`)
- Test: `test/worker-def.test.mjs`

Skip the `thinkingSuffix` half if Task 1 showed `/no_think` does not work; keep the frontmatter half regardless.

**Interfaces:**
- Produces: `workerDefinition({ ..., thinking = null })` writes `thinking: <level>` after the `model:` line when set; `thinkingSuffix({ provider, model, thinking }) → "" | "\n\n/no_think"` (only for provider `llama.cpp`, a model id starting with `qwen3`, and `thinking === "off"`).

- [ ] **Step 1: Write the failing tests** — append to `test/worker-def.test.mjs` (add `thinkingSuffix` to the import at the top):

```js
test("definition carries a thinking line only when a level is set", () => {
	const none = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x" });
	assert.doesNotMatch(none, /\nthinking:/);
	const low = workerDefinition({ provider: "llama.cpp", model: "qwen3-27b", tools: ["read"], prompt: "x", thinking: "low" });
	assert.match(low, /\nmodel: llama\.cpp\/qwen3-27b\nthinking: low\nmax_turns: 60\n/);
});

test("thinkingSuffix: the Qwen3 soft switch only for llama.cpp + qwen3 + off", () => {
	assert.equal(thinkingSuffix({ provider: "llama.cpp", model: "qwen3-27b", thinking: "off" }), "\n\n/no_think");
	assert.equal(thinkingSuffix({ provider: "llama.cpp", model: "qwen3-flash", thinking: "off" }), "\n\n/no_think");
	assert.equal(thinkingSuffix({ provider: "llama.cpp", model: "qwen3-27b", thinking: "low" }), "");
	assert.equal(thinkingSuffix({ provider: "llama.cpp", model: "glm-flash", thinking: "off" }), "");
	assert.equal(thinkingSuffix({ provider: "anthropic", model: "claude-sonnet-5", thinking: "off" }), "");
	assert.equal(thinkingSuffix({ provider: "llama.cpp", model: "qwen3-27b" }), "");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/worker-def.test.mjs`
Expected: FAIL — no thinking line; `thinkingSuffix` not exported.

- [ ] **Step 3: Implement** — in `lib/worker-def.mjs`, change the `workerDefinition` signature to `export function workerDefinition({ provider, model, tools, prompt, maxTurns = 60, background = false, thinking = null }) {` and, in the array, directly after the `` `model: ${provider}/${model}`, `` line, add `...(thinking ? [\`thinking: ${thinking}\`] : []),`. Then add, above `resolveWorkerPrompt`:

```js
/**
 * The local models are declared non-reasoning in ~/.pi/agent/models-store.json, so pi
 * sends no reasoning parameter for them; Qwen3's thinking is its own <think> output.
 * The one switch pi can reach per role is Qwen3's soft switch — `/no_think` in the
 * prompt, which the chat template turns into an empty think block. Deterministic at
 * the template, not an instruction the model weighs. Levels other than `off` have no
 * effect on this provider and get no suffix.
 */
export function thinkingSuffix({ provider, model, thinking = null }) {
	return provider === "llama.cpp" && /^qwen3/i.test(String(model)) && thinking === "off" ? "\n\n/no_think" : "";
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/worker-def.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/worker-def.mjs test/worker-def.test.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "worker-def: thinking frontmatter line; Qwen3 /no_think suffix for llama.cpp + off" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 4: Supervisor wiring and a capped smoke

**Files:**
- Modify: `supervisor.mjs` — the `AGENTS` loop, `launch()` args and the line after `state[name] = s;`, the `--system-prompt` value, the `writeWorkerDefinition` call and the worker prompt.

- [ ] **Step 1: Import** — add `thinkingSuffix` to the `./lib/worker-def.mjs` import: `import { writeWorkerDefinition, installWorkspaceExtension, resolveWorkerPrompt, thinkingSuffix } from "./lib/worker-def.mjs";`

- [ ] **Step 2: Agents and launch** — in the `for (const role of PDEF.roles)` loop change the `AGENTS[role] = {...}` line to

```js
	AGENTS[role] = { tools, peer: PDEF.peer[role], provider: ROLES[role].provider, model: ROLES[role].model, thinking: ROLES[role].thinking ?? null };
```

In `launch()`, in the `args` array directly after `cfg.model,` add `...(cfg.thinking ? ["--thinking", cfg.thinking] : []),`; change the `--system-prompt` value from `prompts[name],` to `prompts[name] + thinkingSuffix({ provider: cfg.provider, model: cfg.model, thinking: cfg.thinking }),`; and directly after `state[name] = s;` add

```js
	log({ agent: name, type: "launch", msg: `${cfg.provider}/${cfg.model}${cfg.thinking ? ` thinking=${cfg.thinking}` : ""} tools=${cfg.tools}` });
```

- [ ] **Step 3: Worker** — in the `if (PATTERN === "orchestrator")` block, change `writeWorkerDefinition(WS.workspace, { ... prompt: workerPrompt.prompt, ...` to pass `prompt: workerPrompt.prompt + thinkingSuffix({ provider: ROLES.worker.provider, model: ROLES.worker.model, thinking: ROLES.worker.thinking ?? null }),` and add `thinking: ROLES.worker.thinking ?? null,` after `maxTurns: 60,`.

- [ ] **Step 4: Tests, then a 60-second capped smoke with both roles at `off`** (router up)

Run: `npm test`
Expected: PASS.

Run: `ROLE_worker_THINKING=off ROLE_orchestrator_THINKING=off ARBITER_CAP_WALL=60 node supervisor.mjs --config configs/smoke-orch.json`; with `<id>` the new run:

```bash
grep '"type":"launch"' runs/<id>/audit.jsonl
grep -n -E "^thinking:|^model:" runs/<id>/ws-builder/.pi/agents/worker.md
tail -c 200 runs/<id>/ws-builder/.pi/agents/worker.md
```

Expected: the launch line says `llama.cpp/qwen3-27b thinking=off`; the worker definition has `thinking: off` after `model:`; the worker prompt ends with `/no_think`. (The `.pi` directory is archived with the workspace; if it is not there, the unit tests in Task 3 already pin the file's content and the launch line proves the flag.)

- [ ] **Step 5: Commit**

```bash
git add supervisor.mjs
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "supervisor: per-role thinking — --thinking on launch, worker frontmatter, Qwen3 suffix, launch audit line" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```

---

### Task 5: The paired batch, the report, the backlog

**Files:**
- Create: `configs/orch-dw-explore-real-27b-nothink.json`, `docs/batch/thinking-level.md`
- Modify: `docs/backlog.md`

- [ ] **Step 1: The treatment config** — copy `configs/orch-dw-explore-real-27b.json` to `configs/orch-dw-explore-real-27b-nothink.json`, change the worker role to `"worker": { "provider": "llama.cpp", "model": "qwen3-27b", "max": 1, "thinking": "off" }` (orchestrator unchanged — the judgement seat is not the variable), and set `"_note": "Paired with orch-dw-explore-real-27b.json (2026-09-14): worker thinking off via Qwen3's /no_think soft switch; measures the worker's thinking share, wall, oracle and E_excl."`.

- [ ] **Step 2: Run the pair as one batch** (about 25–45 minutes each; background; no edits to `supervisor.mjs`, `lib/`, `ext/` meanwhile)

Run: `node tools/batch.mjs thinking-2026-09-14 configs/orch-dw-explore-real-27b.json configs/orch-dw-explore-real-27b-nothink.json`
Expected: `docs/batch/thinking-2026-09-14.md` with two rows.

- [ ] **Step 3: Measure the thinking share per role** — for each run id:

```bash
node -e "const fs=require('fs');const dir='runs/'+process.argv[1];for(const f of fs.readdirSync(dir).filter(f=>/^raw-.*\.jsonl$/.test(f))){let t=0,x=0,n=0;for(const l of fs.readFileSync(dir+'/'+f,'utf8').split('\n')){if(!l)continue;let e;try{e=JSON.parse(l)}catch{continue}if(e.type!=='message_end'||e.message?.role!=='assistant')continue;n++;for(const c of e.message.content||[]){if(c.type==='thinking')t+=String(c.thinking??c.text??'').length;else if(c.type==='text')x+=String(c.text??'').length}}console.log(f,{turns:n,thinkingChars:t,textChars:x,share:t+x?(t/(t+x)).toFixed(2):'n/a'})}" <id>
node -e "const s=require('./runs/<id>/summary.json');console.log(JSON.stringify({reason:s.reason,wall:s.wallSec,tokens:s.tokens,contextPeak:s.contextPeak,probes:s.mailByKind?.probe,compactions:s.compactions?.length},null,1))"
node tools/kpi.mjs | grep -E "<id>|E_excl"
```

Expected on the treatment run: the worker's `share` well under the baseline's 0.36–0.39; the orchestrator's unchanged. Record both, plus oracle outcome, wall, `E_excl`, and context peaks.

- [ ] **Step 4: Write `docs/batch/thinking-level.md`** — the four spike lines from Task 1 (which switch llama-server honoured), a two-row table (config, run id, outcome, oracle score, wall s, fresh tokens, worker thinking share, orchestrator thinking share, worker context peak, `E_excl`), and a paragraph on whether the oracle still passed without worker thinking. N=1; say what a second pair would settle. If Task 1 showed `/no_think` does not work, the report says so and the table has the baseline only.

- [ ] **Step 5: Backlog** — append to the section `## From Claude Code's Workflow tool (2026-09-14 — …)` in `docs/backlog.md` (create it if the other two plans have not):

```markdown
26. **Per-role thinking level** — done 2026-09-14 (`roles.<role>.thinking` → pi `--thinking` and the worker's `thinking:` frontmatter; local Qwen3 gets `/no_think` for `off` because the llama.cpp entries in the pi models store are declared non-reasoning; `docs/batch/thinking-level.md`). Open: levels between off and on have no effect locally — a second router alias with `--reasoning-budget` would be the server-side route; hosted providers honour the level as sent.
```

- [ ] **Step 6: Commit**

```bash
git add configs/orch-dw-explore-real-27b-nothink.json docs/batch/thinking-2026-09-14.md docs/batch/thinking-level.md docs/backlog.md memory/
git -c user.name="bagude" -c user.email="45043048+bagude@users.noreply.github.com" commit -m "thinking level: paired dw-explore-real batch (worker off), report, backlog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01MWkhSZsRjU8L3V3TWfwTLz"
```
