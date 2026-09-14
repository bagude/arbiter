# Thinking level: paired dw-explore-real run (worker off, 2026-09-14)

`roles.<role>.thinking` now flows to pi's `--thinking` flag and to a spawned worker's `thinking:` frontmatter. This report pairs one `tasks/dw-explore-real` run with the worker's thinking off against one with it on, and records which local switch actually turns Qwen3.8-27B's thinking off.

## Which switch llama-server honours

Task 1's spike sent the same prompt through llama-server five ways and measured the reasoning-channel length in the response:

- baseline request: 139 reasoning chars.
- Qwen3's own soft switch, `/no_think` in the user turn: 530 reasoning chars and **empty** content — the Qwen3.8 chat template does not implement the soft switch, it just breaks the response.
- `/no_think` in the system turn: 89 reasoning chars — some effect, not off.
- `chat_template_kwargs.enable_thinking=false`: 0 reasoning chars, correct answer.
- `reasoning_effort: low`: 110 reasoning chars — ignored.

So the working local switch is pi's chat-template `enable_thinking` compat path, not Qwen3's `/no_think`. pi only sends `enable_thinking` (via `compat.thinkingFormat: "chat-template"`) for a model entry marked `reasoning: true`; the user's `qwen3-27b` entry in `~/.pi/agent/models-store.json` is `reasoning: false`. With the user's approval, `~/.pi/agent/models.json` now carries a `modelOverrides.qwen3-27b` entry (`reasoning: true`, `thinkingFormat: "chat-template"`, `chatTemplateKwargs: { enable_thinking: { "$var": "thinking.enabled" } }`) so the role's `thinking` setting reaches the template.

Verification smokes on the orchestrator role: default launch (no thinking key) — run `2026-09-14T17-14-15`, 172 thinking chars / 0 text; `ROLE_*_THINKING=off` — run `2026-09-14T17-15-16`, 0 thinking chars / 100 text chars, launch line logs `thinking=off`. pi's own default thinking level is `medium`, so a run that omits the key keeps thinking on by default.

## The pair

Not a single two-run batch: the baseline reuses an already-passing budgeted-campaign run and the treatment is a fresh one-row batch, both against the unmodified `configs/orch-dw-explore-real-27b.json` pattern (only the worker's `thinking` key differs):

- **Baseline** — run `2026-09-14T17-16-44`, produced by the budgeted campaign `campaigns/dw-explore-real.json` from `configs/orch-dw-explore-real-27b.json` (worker thinking unset, i.e. default/on).
- **Treatment** — run `2026-09-14T17-31-33`, produced by `node tools/batch.mjs thinking-2026-09-14 configs/orch-dw-explore-real-27b-nothink.json` (`docs/batch/thinking-2026-09-14.md`, one row); the config is identical except `"roles.worker.thinking": "off"`, and the worker's rendered `ws-builder/.pi/agents/worker.md` shows `thinking: off` in its frontmatter.

Same config file (bar the one flag), same code, same pi build with the `models.json` override, consecutive on the same router — a paired comparison by construction, even though the two runs came through two different driver scripts (campaign vs. batch) rather than one shared batch invocation.

## Thinking share, defined

`share` here is thinking characters divided by (thinking + text characters) of a role's assistant **output**, summed across every `message_end` event in that role's `raw-*.jsonl` for the whole run (see command below). This is a different denominator from the 36–39% figure in the memory-retrieval slice-3 report, which was thinking's share of the worker's **context** (how much of what it read back was thinking tokens) — a context-composition measure, not an output-composition one. The two numbers are not comparable.

```
node -e "const fs=require('fs');const dir='runs/'+process.argv[1];for(const f of fs.readdirSync(dir).filter(f=>/^raw-.*\.jsonl$/.test(f))){let t=0,x=0,n=0;for(const l of fs.readFileSync(dir+'/'+f,'utf8').split('\n')){if(!l)continue;let e;try{e=JSON.parse(l)}catch{continue}if(e.type!=='message_end'||e.message?.role!=='assistant')continue;n++;for(const c of e.message.content||[]){if(c.type==='thinking')t+=String(c.thinking??c.text??'').length;else if(c.type==='text')x+=String(c.text??'').length}}console.log(f,{turns:n,thinkingChars:t,textChars:x,share:t+x?(t/(t+x)).toFixed(2):'n/a'})}" <id>
```

## Results

| config | run id | outcome | oracle | wall (s) | fresh tokens | worker thinking share | orchestrator thinking share | worker context peak | `E_excl`(1k) |
|---|---|---|---|---|---|---|---|---|---|
| `orch-dw-explore-real-27b.json` (baseline, worker thinking on) | `2026-09-14T17-16-44` | SUCCESS: oracle passed | 14/14 | 861.1 | 331210 | 0.98 (4 turns, 46736 thinking / 1172 text chars) | 0.98 (23 turns) | 19492 | 3.019 |
| `orch-dw-explore-real-27b-nothink.json` (treatment, worker thinking off) | `2026-09-14T17-31-33` | SUCCESS: oracle passed | 14/14 | 568 | 202357 | 0.00 (25 turns, 0 thinking / 4484 text chars) | 0.99 (14 turns) | 23181 | 4.942 |

`E_excl`(1k) recomputed per run the way `tools/kpi.mjs` computes it (`successes per 1k fresh tokens`, fresh = input + output from `lib/usage.mjs` `tokenTotals`, excluding cache reads) since the tool prints no run-id column: baseline `input 240137 + output 91073 = 331210` fresh tokens → `1000/(331210/1000) = 3.019`; treatment `input 157968 + output 44389 = 202357` → `4.942`. Both match the corresponding row in `node tools/kpi.mjs`'s full listing.

## The oracle still passed without worker thinking

Turning the worker's thinking off did not cost the oracle score: both runs passed 14/14 on the same task and contract. Everything else moved together with it in this one pair — wall time fell from 861.1 s to 568 s (34% less), fresh tokens fell from 331210 to 202357 (39% less), and `E_excl` rose from 3.019 to 4.942 (64% higher) — but the *shape* of the work changed too, not just its cost. The worker went from 4 long turns (46736 thinking chars, 1172 text chars) to 25 short turns (0 thinking, 4484 text chars): without a thinking channel to reason in, it appears to have spread the same work across many more, plainer tool-call turns instead of fewer turns each preceded by a long reasoning block. The orchestrator's own probing dropped from 6 probes to 2, even though its thinking share was unchanged (0.98 vs 0.99, as expected — only the worker's flag moved) — consistent with a worker report that needed less orchestrator-side re-verification, though on N=1 that could as easily be the specific exploration path this run happened to take. One compaction fired in the treatment run (`compact-1` at 545 s, `boundary: "worker … reported"`) versus zero in the baseline, and the worker's own context peak was *higher* without thinking (23181 vs 19492) despite carrying no thinking tokens at all — plausibly because 25 turns of tool calls and results accumulate more raw context than 4 turns do, even without the thinking blocks that would otherwise dominate that budget.

N=1 per arm, one task, one seed of whatever nondeterminism the router and the exploration path carry. No general claim that worker thinking is unnecessary follows from this — only that on this run, this task, this contract, it was not necessary and was markedly more expensive. A second pair on `dw-explore-real` would settle whether the wall/token/`E_excl` gap and the turn-count/probe-count shift are the thinking flag's doing or path noise (the worker-report batch on `orbit` found wall-time variance at this footprint can be large from other causes alone). A pair on a task with a different kind of oracle load — `tasks/orbit`, where the worker writes non-trivial coordinate-transform code rather than largely transcribing analysis the orchestrator's own probes already verified — would test whether the result holds when the worker's role is closer to reasoning-shaped work than to typist-shaped work.
