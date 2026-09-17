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
import { ACTION_CLASSES, SYMBOLS, SUBSTANTIVE, modeOf } from "./decision-points.mjs";

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

function routingQuestion(valid) {
	const lines = ACTION_CLASSES.filter((c) => valid[c]).map((c) => `${SYMBOLS[c]}. ${DESCRIBE[c]}`);
	return `[ROUTER] Before you continue: which kind of action will you take next? Reply with exactly one capital letter and nothing else.\n${lines.join("\n")}`;
}

// Mode A (default): thinking off, one decoded token. Mode B (`thinking: true`): the
// model reasons first, then a grammar forces exactly one letter after </think>; the
// distribution is read from that last token's logprobs. Same state, same alphabet, so
// the two modes separate "the abstraction is wrong" from "it needed to reason".
const THINK_GRAMMAR = String.raw`root ::= "<think>" ( [^<] | "<" [^/] )* "</think>" [ \n]* [A-I]`;
export function headRequest(payload, valid, { thinking = false } = {}) {
	const messages = [...payload.messages, { role: "user", content: routingQuestion(valid) }];
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
		...(thinking ? { grammar: THINK_GRAMMAR } : {}),
		chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: thinking },
	};
}

/** Distribution over the nine letters from a chat-completions logprobs block. */
export function distributionFrom(choice) {
	const toks = choice?.logprobs?.content ?? [];
	const last = toks[toks.length - 1];
	const top = last?.top_logprobs ?? [];
	const thinkTokens = Math.max(0, toks.length - 1);
	const raw = Object.fromEntries(LETTERS.map((l) => [l, 0]));
	let other = 0;
	for (const t of top) {
		const tok = String(t.token).trim();
		const p = Math.exp(t.logprob);
		if (tok in raw) raw[tok] += p; else other += p;
	}
	const content = String(choice?.message?.content ?? "").trim();
	return { raw, other, sampled: content.slice(-1), thinkTokens, thought: thinkTokens ? content.replace(/^<think>|<\/think>[\s\S]*$/g, "").trim().slice(0, 600) : null };
}

export function scorePoint(point, dist) {
	const validLetters = ACTION_CLASSES.filter((c) => point.valid[c]).map((c) => SYMBOLS[c]);
	const mass = validLetters.reduce((s, l) => s + dist.raw[l], 0);
	const pValid = Object.fromEntries(validLetters.map((l) => [l, mass > 0 ? dist.raw[l] / mass : 1 / validLetters.length]));
	const ranked = [...validLetters].sort((a, b) => pValid[b] - pValid[a]);
	const chosen = point.action.symbol;
	const chosenValid = validLetters.includes(chosen);
	const pChosen = chosenValid ? pValid[chosen] : 0;
	const entropy = -validLetters.reduce((s, l) => (pValid[l] > 0 ? s + pValid[l] * Math.log(pValid[l]) : s), 0);
	// the two coarser horizons: next substantive action, and gather-vs-act as a binary
	const substantive = point.substantive?.symbol ?? null;
	const pAct = validLetters.filter((l) => SUBSTANTIVE.has(BY_LETTER[l])).reduce((s, l) => s + pValid[l], 0);
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

export async function replayRun(runId, { server, key, limit = Infinity, thinking = false, log = () => {} }) {
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
		const { json, wallMs } = await ask(server, key, headRequest(payload, p.valid, { thinking }));
		const dist = distributionFrom(json.choices?.[0]);
		const score = scorePoint(p, dist);
		const head = { mode: thinking ? "B" : "A", ...score, raw: dist.raw, other: dist.other, sampled: dist.sampled, thinkTokens: dist.thinkTokens, thought: dist.thought, wallMs, promptMs: json.timings?.prompt_ms ?? null, predictedMs: json.timings?.predicted_ms ?? null, cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? null, promptTokens: json.usage?.prompt_tokens ?? null };
		out.push({ ...p, head });
		log(`${runId} #${String(p.i + 1).padStart(3)} ${p.action.cls.padEnd(10)}→${String(p.substantive?.cls ?? "-").padEnd(8)} head ${score.pickClass.padEnd(10)} p=${score.confidence.toFixed(2)} ${score.agree ? "=" : score.agreeSubstantive ? "≈" : "≠"}${thinking ? ` think ${dist.thinkTokens}` : ""}  ${Math.round(wallMs)} ms (cached ${head.cachedTokens}/${head.promptTokens})`);
	}
	fs.writeFileSync(path.join(dir, thinking ? "decisions-replay-thinking.jsonl" : "decisions-replay.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
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
	const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
	const ids = args.filter((a, i) => !a.startsWith("--") && !["--server", "--key", "--limit"].includes(args[i - 1]));
	if (!ids.length) { console.error("usage: node tools/decision-replay.mjs <runId> [...] [--server url] [--key file] [--limit N] [--thinking]"); process.exit(1); }
	const all = [];
	for (const id of ids) all.push(...(await replayRun(id, { server, key, limit, thinking, log: console.log })));
	printSummary(summarize(all));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
