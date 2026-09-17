#!/usr/bin/env node
// Shadow decision-head replay: put the exact state the orchestrator saw at each
// inference (runs/<id>/requests/NNNN.json, from ext/replay-capture.ts) in front of a
// one-token constrained head, and compare its distribution over action classes with
// what the generative orchestrator chose (runs/<id>/decisions.jsonl, from
// tools/decision-points.mjs). No harness behaviour changes; this is measurement.
//
//   node tools/decision-replay.mjs <runId> [...]  [--server http://127.0.0.1:8080] [--key <file>] [--limit N]
//
// Writes runs/<id>/decisions-replay.jsonl (one record per decision point with the
// head's distribution, its pick, agreement, log loss, entropy, latency) and prints
// the aggregate: agreement, top-2 agreement, mean log loss, calibration by confidence
// bucket, and the threshold curve — coverage, agreement, decoded tokens and inference
// seconds the generative path spent on the covered points, and the false-confidence
// cases (confident, disagreeing, and the run's outcome for inspection).
//
// Symbols are fixed per class (A spawn … I answer) so a letter means the same thing at
// every point; only the actions valid at that point are listed in the question, and
// the distribution is reported both raw (all nine letters) and renormalised over the
// valid set — P(a|s) and P(a|s, a ∈ valid) — since a confident pick among two legal
// actions is not the same as one among nine.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_CLASSES, SYMBOLS, ACT, modeOf } from "./decision-points.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DESCRIBE = {
	spawn: "spawn a new worker (subagent)",
	resume: "resume an existing worker (subagent with resume)",
	collect: "collect a background worker's result (get_subagent_result)",
	probe: "send a probe to the supervisor (send_mail kind=probe)",
	done: "claim the task is done (send_mail kind=done)",
	inspect: "inspect the workspace yourself (read, ls, grep)",
	memory: "consult memory (memory_search, memory_get) or record a memory candidate",
	checkpoint: "checkpoint or check context usage",
	answer: "answer in text without calling any tool",
};
const LETTERS = Object.values(SYMBOLS);
const BY_LETTER = Object.fromEntries(ACTION_CLASSES.map((c) => [SYMBOLS[c], c]));

const SUBSTANTIVE_CLASSES = ["spawn", "resume", "collect", "probe", "done"];
function routingQuestion(valid, { horizon = "literal", state = null } = {}) {
	const classes = horizon === "substantive" ? SUBSTANTIVE_CLASSES : ACTION_CLASSES;
	const lines = classes.filter((c) => valid[c]).map((c) => `${SYMBOLS[c]}. ${DESCRIBE[c]}`);
	const pending = state?.pendingReply ? `\n(A ${state.pendingReply === "done" ? "done claim" : state.pendingReply === "probe" ? "probe" : "message"} you sent to the supervisor has not been answered yet.)` : "";
	const ask = horizon === "substantive"
		? "which state-changing action will you take next, ignoring any reads, memory lookups or checkpoints you might do first?"
		: "which kind of action will you take next?";
	return `[ROUTER] Before you continue: ${ask} Reply with exactly one capital letter and nothing else.${pending}\n${lines.join("\n")}`;
}

// Mode A (default): thinking off, one decoded token, P(action | state). Mode B
// (`thinking: true`): P(action | state, generated reasoning), in two calls — see
// askThinking. Same state (tool schemas kept), same alphabet, so the two modes separate
// "the abstraction is wrong" from "it needed to reason".
export function headRequest(payload, valid, { thinking = false, horizon = "literal", state = null } = {}) {
	const messages = [...payload.messages, { role: "user", content: routingQuestion(valid, { horizon, state }) }];
	return {
		model: payload.model,
		messages,
		tools: payload.tools,
		stream: false,
		max_tokens: thinking ? 2048 : 1,
		temperature: 0,
		logprobs: true,
		top_logprobs: 20,
		cache_prompt: true,
		chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: thinking },
	};
}

/** Distribution over the nine letters from the top logprobs of one scored token. */
export function distributionFrom(choice) {
	const top = choice?.logprobs?.content?.[0]?.top_logprobs ?? [];
	const raw = Object.fromEntries(LETTERS.map((l) => [l, 0]));
	let other = 0;
	for (const t of top) {
		const tok = String(t.token).trim();
		const p = Math.exp(t.logprob);
		if (tok in raw) raw[tok] += p; else other += p;
	}
	return { raw, other, sampled: String(choice?.message?.content ?? "").trim() };
}

/** The reasoning text of a thinking reply, without the tags. */
export function reasoningOf(message) {
	return String(message?.reasoning_content ?? "").replace(/^\s*<think>\n?/, "").replace(/<\/think>\s*$/, "").trim();
}

/**
 * Mode B in two calls, because with speculative decoding the server attaches
 * probabilities only to tokens the target model sampled itself, so the letter at the
 * end of a long thinking answer usually carries none. Call 1: the same state, thinking
 * on, lets the model reason and answer. Call 2: render the same messages and tools
 * through the model's chat template (/apply-template), append the reasoning it just
 * produced as the open think block's content, close the block, and score exactly one
 * token with pre-sampling top probabilities (/completion). The distribution is then
 * P(action | state, that reasoning), and the prefix cache pays for most of call 2.
 */
export async function askThinking(server, key, payload, valid, { horizon = "literal", state = null } = {}) {
	const t0 = Date.now();
	const req = headRequest(payload, valid, { thinking: true, horizon, state });
	delete req.logprobs; delete req.top_logprobs;
	const first = await post(server, key, "/v1/chat/completions", req);
	const reasoning = reasoningOf(first.choices?.[0]?.message);
	const thinkTokens = first.usage?.completion_tokens ?? null;
	const rendered = await post(server, key, "/apply-template", { model: req.model, messages: req.messages, tools: req.tools, chat_template_kwargs: req.chat_template_kwargs });
	let prompt = String(rendered.prompt ?? "");
	if (!prompt) throw new Error("apply-template returned no prompt");
	if (!prompt.endsWith("<think>\n")) prompt += "<think>\n";
	prompt += `${reasoning}\n</think>\n\n`;
	const scored = await post(server, key, "/completion", { model: req.model, prompt, n_predict: 1, temperature: 0, n_probs: 20, post_sampling_probs: false, cache_prompt: true });
	const cp = scored.completion_probabilities?.[0] ?? {};
	const choice = { message: { content: cp.token ?? "" }, logprobs: { content: [{ token: cp.token ?? "", top_logprobs: cp.top_logprobs ?? [] }] } };
	return {
		choice, wallMs: Date.now() - t0, thinkTokens, thought: reasoning.slice(0, 600), firstAnswer: String(first.choices?.[0]?.message?.content ?? "").trim().slice(0, 8),
		predictedMs: first.timings?.predicted_ms ?? null, promptMs: (first.timings?.prompt_ms ?? 0) + (scored.timings?.prompt_ms ?? 0),
		cachedTokens: scored.timings?.cache_n ?? null, promptTokens: (scored.timings?.cache_n ?? 0) + (scored.timings?.prompt_n ?? 0),
	};
}

async function post(server, key, route, body) {
	const res = await fetch(`${server}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`${route} ${res.status} ${await res.text()}`);
	return res.json();
}

export function scorePoint(point, dist, { horizon = "literal" } = {}) {
	const offered = horizon === "substantive" ? SUBSTANTIVE_CLASSES : ACTION_CLASSES;
	const validLetters = offered.filter((c) => point.valid[c]).map((c) => SYMBOLS[c]);
	const mass = validLetters.reduce((s, l) => s + dist.raw[l], 0);
	const pValid = Object.fromEntries(validLetters.map((l) => [l, mass > 0 ? dist.raw[l] / mass : 1 / validLetters.length]));
	const ranked = [...validLetters].sort((a, b) => pValid[b] - pValid[a]);
	// the target: the literal next call, or the next substantive action when that is the question asked
	const chosen = horizon === "substantive" ? (point.substantive?.symbol ?? null) : point.action.symbol;
	const chosenValid = validLetters.includes(chosen);
	const pChosen = chosenValid ? pValid[chosen] : 0;
	const entropy = -validLetters.reduce((s, l) => (pValid[l] > 0 ? s + pValid[l] * Math.log(pValid[l]) : s), 0);
	// the two coarser horizons: next substantive action, and gather-vs-act as a binary
	const substantive = point.substantive?.symbol ?? null;
	const pAct = validLetters.filter((l) => ACT.has(BY_LETTER[l])).reduce((s, l) => s + pValid[l], 0);
	const modePick = pAct >= 0.5 ? "act" : "gather";
	return {
		pick: ranked[0], pickClass: BY_LETTER[ranked[0]], confidence: pValid[ranked[0]],
		top2: ranked.slice(0, 2), agree: ranked[0] === chosen, agreeTop2: ranked.slice(0, 2).includes(chosen),
		agreeSubstantive: substantive != null && ranked[0] === substantive,
		pAct, modePick, agreeMode: modePick === (point.action.mode ?? modeOf(point.action.cls)),
		chosenValid, pChosen, logLoss: -Math.log(Math.max(pChosen, 1e-6)), entropy, validMass: mass, pValid,
	};
}

async function ask(server, key, body) {
	const t0 = Date.now();
	const res = await fetch(`${server}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	const json = await res.json();
	return { json, wallMs: Date.now() - t0 };
}

export async function replayRun(runId, { server, key, limit = Infinity, thinking = false, horizon = "literal", log = () => {} }) {
	const dir = path.join(ROOT, "runs", runId);
	const decisionsFile = path.join(dir, "decisions.jsonl");
	const reqDir = path.join(dir, "requests");
	if (!fs.existsSync(decisionsFile)) throw new Error(`${runId}: no decisions.jsonl (run tools/decision-points.mjs first)`);
	if (!fs.existsSync(reqDir)) throw new Error(`${runId}: no requests/ (captured only for runs after ext/replay-capture.ts landed)`);
	const points = fs.readFileSync(decisionsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const out = [];
	for (const p of points.slice(0, limit)) {
		const f = path.join(reqDir, `${String(p.i + 1).padStart(4, "0")}.json`);
		if (!fs.existsSync(f)) { out.push({ ...p, head: null, skipped: "no captured request" }); continue; }
		const { payload } = JSON.parse(fs.readFileSync(f, "utf8"));
		if (horizon === "substantive" && !p.substantive?.symbol) { out.push({ ...p, head: null, skipped: "no substantive action follows" }); continue; }
		let head;
		if (thinking) {
			const r = await askThinking(server, key, payload, p.valid, { horizon, state: p.state });
			const dist = distributionFrom(r.choice);
			const score = scorePoint(p, dist, { horizon });
			head = { mode: "B", horizon, ...score, raw: dist.raw, other: dist.other, sampled: dist.sampled, firstAnswer: r.firstAnswer, thinkTokens: r.thinkTokens, thought: r.thought, wallMs: r.wallMs, promptMs: r.promptMs, predictedMs: r.predictedMs, cachedTokens: r.cachedTokens, promptTokens: r.promptTokens };
		} else {
			const { json, wallMs } = await ask(server, key, headRequest(payload, p.valid, { horizon, state: p.state }));
			const dist = distributionFrom(json.choices?.[0]);
			const score = scorePoint(p, dist, { horizon });
			head = { mode: "A", horizon, ...score, raw: dist.raw, other: dist.other, sampled: dist.sampled, thinkTokens: 0, thought: null, wallMs, promptMs: json.timings?.prompt_ms ?? null, predictedMs: json.timings?.predicted_ms ?? null, cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? null, promptTokens: json.usage?.prompt_tokens ?? null };
		}
		out.push({ ...p, head });
		log(`${runId} #${String(p.i + 1).padStart(3)} ${p.action.cls.padEnd(10)}→${String(p.substantive?.cls ?? "-").padEnd(8)} head ${head.pickClass.padEnd(10)} p=${head.confidence.toFixed(2)} ${head.agree ? "=" : head.agreeSubstantive ? "≈" : "≠"}${thinking ? ` think ${head.thinkTokens}` : ""}  ${Math.round(head.wallMs)} ms (cached ${head.cachedTokens}/${head.promptTokens})`);
	}
	const file = `decisions-replay${horizon === "substantive" ? "-substantive" : ""}${thinking ? "-thinking" : ""}.jsonl`;
	fs.writeFileSync(path.join(dir, file), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
	return out;
}

export function summarize(rows) {
	const scored = rows.filter((r) => r.head);
	const n = scored.length;
	const agree = scored.filter((r) => r.head.agree).length;
	const top2 = scored.filter((r) => r.head.agreeTop2).length;
	const agreeSub = scored.filter((r) => r.head.agreeSubstantive).length;
	const agreeMode = scored.filter((r) => r.head.agreeMode).length;
	const gatherPts = scored.filter((r) => r.action.mode === "gather");
	const gatherHeadSaysAct = gatherPts.filter((r) => r.head.modePick === "act").length;
	const thinkTokens = scored.reduce((s, r) => s + (r.head.thinkTokens ?? 0), 0);
	const logLoss = scored.reduce((s, r) => s + r.head.logLoss, 0) / Math.max(1, n);
	const totalDecoded = scored.reduce((s, r) => s + r.decoded, 0);
	const totalInfer = scored.reduce((s, r) => s + r.inferenceMs, 0);
	const buckets = [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.01]].map(([lo, hi]) => {
		const b = scored.filter((r) => r.head.confidence >= lo && r.head.confidence < hi);
		return { bucket: `${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`, n: b.length, agreement: b.length ? b.filter((r) => r.head.agree).length / b.length : null };
	});
	const curve = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98].map((tau) => {
		const covered = scored.filter((r) => r.head.confidence >= tau);
		const dis = covered.filter((r) => !r.head.agree);
		return {
			tau, coverage: covered.length / Math.max(1, n), agreement: covered.length ? (covered.length - dis.length) / covered.length : null,
			decodedAvoided: covered.reduce((s, r) => s + r.decoded, 0) / Math.max(1, totalDecoded),
			inferAvoidedS: Math.round(covered.reduce((s, r) => s + r.inferenceMs, 0) / 1000),
			falseConfident: dis.map((r) => ({ run: r.run, i: r.i + 1, head: r.head.pickClass, actual: r.action.cls, p: Number(r.head.confidence.toFixed(2)), runOk: r.outcome.runOk })),
		};
	});
	const byClass = {};
	for (const r of scored) { const c = (byClass[r.action.cls] ??= { n: 0, agree: 0, meanP: 0 }); c.n++; c.agree += r.head.agree ? 1 : 0; c.meanP += r.head.pChosen; }
	for (const c of Object.values(byClass)) { c.agreement = c.agree / c.n; c.meanP = c.meanP / c.n; delete c.agree; }
	return { n, agreement: agree / Math.max(1, n), top2: top2 / Math.max(1, n), agreementSubstantive: agreeSub / Math.max(1, n), agreementMode: agreeMode / Math.max(1, n), gatherPoints: gatherPts.length, gatherHeadSaysAct, thinkTokens, meanLogLoss: logLoss, meanHeadMs: scored.reduce((s, r) => s + r.head.wallMs, 0) / Math.max(1, n), totalDecoded, totalInferS: Math.round(totalInfer / 1000), buckets, curve, byClass };
}

/** Three horizons × the modes present: the matrix. Rows read from replay files already on disk. */
export function matrix(runIds) {
	const load = (id, f) => { const p = path.join(ROOT, "runs", id, f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.head) : []; };
	const modes = { A: runIds.flatMap((id) => load(id, "decisions-replay.jsonl")), B: runIds.flatMap((id) => load(id, "decisions-replay-thinking.jsonl")) };
	const cell = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
	const rows = [
		["literal next action", (r) => r.head.agree],
		["next substantive action", (r) => r.head.agreeSubstantive],
		["gather vs act", (r) => r.head.agreeMode],
	];
	const out = { n: { A: modes.A.length, B: modes.B.length }, cells: {}, thinkTokensPerPoint: modes.B.length ? modes.B.reduce((s, r) => s + (r.head.thinkTokens ?? 0), 0) / modes.B.length : null, msPerPoint: { A: modes.A.length ? modes.A.reduce((s, r) => s + r.head.wallMs, 0) / modes.A.length : null, B: modes.B.length ? modes.B.reduce((s, r) => s + r.head.wallMs, 0) / modes.B.length : null } };
	for (const [name, f] of rows) out.cells[name] = { A: cell(modes.A, f), B: cell(modes.B, f) };
	// where did reasoning move the binary? points whose gather-vs-act pick differs between modes
	if (modes.A.length && modes.B.length) {
		const byKey = new Map(modes.A.map((r) => [`${r.run}:${r.i}`, r]));
		const paired = modes.B.map((b) => [byKey.get(`${b.run}:${b.i}`), b]).filter(([a]) => a);
		out.paired = paired.length;
		out.modeFlipped = paired.filter(([a, b]) => a.head.modePick !== b.head.modePick).length;
		out.flippedToCorrect = paired.filter(([a, b]) => a.head.modePick !== b.head.modePick && b.head.agreeMode).length;
		out.meanConfidence = { A: paired.reduce((s, [a]) => s + a.head.confidence, 0) / paired.length, B: paired.reduce((s, [, b]) => s + b.head.confidence, 0) / paired.length };
	}
	return out;
}

function printMatrix(m) {
	const pct = (x) => (x == null ? "    —" : (x * 100).toFixed(0).padStart(4) + "%");
	console.log(`\nagreement matrix · A: P(action | state), n=${m.n.A} · B: P(action | state, reasoning), n=${m.n.B}${m.thinkTokensPerPoint != null ? ` · B thought ${Math.round(m.thinkTokensPerPoint)} tokens/point` : ""} · ${Math.round(m.msPerPoint.A ?? 0)} ms vs ${Math.round(m.msPerPoint.B ?? 0)} ms per point`);
	console.log("horizon                    A       B");
	for (const [name, c] of Object.entries(m.cells)) console.log(`${name.padEnd(24)} ${pct(c.A)}   ${pct(c.B)}`);
	if (m.paired) console.log(`paired points ${m.paired}: reasoning flipped gather-vs-act on ${m.modeFlipped} (${m.flippedToCorrect} to the orchestrator's choice) · mean confidence A ${m.meanConfidence.A.toFixed(2)} → B ${m.meanConfidence.B.toFixed(2)}`);
}

function printSummary(s) {
	console.log(`\n${s.n} decision points · literal agreement ${(s.agreement * 100).toFixed(1)}% · top-2 ${(s.top2 * 100).toFixed(1)}% · next-substantive agreement ${(s.agreementSubstantive * 100).toFixed(1)}% · gather-vs-act agreement ${(s.agreementMode * 100).toFixed(1)}% (${s.gatherHeadSaysAct} of ${s.gatherPoints} gather points: head says act) · mean log loss ${s.meanLogLoss.toFixed(3)} · head ${Math.round(s.meanHeadMs)} ms/point${s.thinkTokens ? ` · head thought ${s.thinkTokens} tokens` : ""} · generative path: ${s.totalDecoded} decoded tokens, ${s.totalInferS} s inference`);
	console.log("by actual class:", Object.entries(s.byClass).map(([k, v]) => `${k} n=${v.n} agree=${(v.agreement * 100).toFixed(0)}% p̄=${v.meanP.toFixed(2)}`).join("  "));
	console.log("calibration:", s.buckets.map((b) => `${b.bucket}: n=${b.n}${b.agreement == null ? "" : ` agree=${(b.agreement * 100).toFixed(0)}%`}`).join("  "));
	console.log("τ      coverage  agreement  decoded-avoided  infer-avoided  false-confident");
	for (const c of s.curve) console.log(`${c.tau.toFixed(2).padEnd(6)} ${(c.coverage * 100).toFixed(0).padStart(6)}%  ${c.agreement == null ? "     —" : (c.agreement * 100).toFixed(0).padStart(6) + "%"}  ${(c.decodedAvoided * 100).toFixed(0).padStart(13)}%  ${String(c.inferAvoidedS).padStart(11)} s  ${c.falseConfident.length}`);
}

async function main() {
	const args = process.argv.slice(2);
	const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
	const server = opt("--server", "http://127.0.0.1:8080");
	const keyFile = opt("--key", "C:/Users/user/Downloads/claude_playground/os/qwen-flash/.llama-api-key");
	const limit = Number(opt("--limit", "Infinity"));
	const thinking = args.includes("--thinking");
	const horizon = args.includes("--substantive") ? "substantive" : "literal";
	const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
	const ids = args.filter((a, i) => !a.startsWith("--") && !["--server", "--key", "--limit"].includes(args[i - 1]));
	if (!ids.length) { console.error("usage: node tools/decision-replay.mjs <runId> [...] [--server url] [--key file] [--limit N] [--thinking] [--substantive] [--matrix]"); process.exit(1); }
	if (args.includes("--matrix")) { printMatrix(matrix(ids)); return; }
	const all = [];
	for (const id of ids) all.push(...(await replayRun(id, { server, key, limit, thinking, horizon, log: console.log })));
	printSummary(summarize(all));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
