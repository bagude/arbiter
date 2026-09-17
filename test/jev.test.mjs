import { test } from "node:test";
import assert from "node:assert/strict";
import { renderState, renderMessage, buildQuestions, askJev, askWithRetry, maskProbabilities, scoreAnswers, summarise, formatSummary } from "../lib/jev.mjs";
import { comparisonTable } from "../tools/jev-replay.mjs";

const payload = {
	messages: [
		{ role: "system", content: "You are the orchestrator." },
		{ role: "user", content: "[SUPERVISOR] Session start." },
		{ role: "assistant", content: [{ type: "text", text: "Reading." }], tool_calls: [{ function: { name: "ls", arguments: "{\"path\":\".\"}" } }] },
		{ role: "tool", content: [{ type: "tool_result", content: "README.md\nsrc/" }] },
		{ role: "assistant", content: "Now I will spawn." },
	],
};

test("renderState puts the system prompt first, flattens array content and names tool calls", () => {
	const r = renderState(payload);
	assert.ok(r.state.startsWith("## SYSTEM\nYou are the orchestrator."));
	assert.match(r.state, /## ASSISTANT\nReading\.\nTOOL_CALL ls \{"path":"\."\}/);
	assert.match(r.state, /## TOOL\nREADME\.md\nsrc\//);
	assert.equal(r.truncated, false);
	assert.equal(r.kept, 1);
	assert.equal(renderMessage({ role: "user", content: [{ type: "image" }] }), '## USER\n{"type":"image"}');
});

test("renderState drops the oldest non-system messages first and reports the kept fraction", () => {
	const full = renderState(payload).state.length;
	const r = renderState(payload, { maxChars: full - 10 });
	assert.equal(r.truncated, true);
	assert.equal(r.dropped, 1);
	assert.equal(r.kept, 3 / 4);
	assert.ok(r.state.startsWith("## SYSTEM"), "the system prompt is never dropped");
	assert.ok(!r.state.includes("Session start"), "the oldest user message went first");
	assert.ok(r.state.includes("Now I will spawn"), "the tail is kept");
	// Nothing fits: everything but the system prompt goes, and the state is still returned.
	const tiny = renderState(payload, { maxChars: 1 });
	assert.equal(tiny.dropped, 4);
	assert.ok(tiny.state.startsWith("## SYSTEM"));
});

test("buildQuestions offers only the valid classes for literal and the five for substantive", () => {
	const valid = { spawn: true, resume: false, collect: false, probe: false, done: false, inspect: true, memory: true, checkpoint: true, answer: true };
	const q = buildQuestions({ valid });
	assert.deepEqual(Object.keys(q.literal.criteria), ["spawn", "inspect", "memory", "checkpoint", "answer"]);
	assert.equal(q.substantive, undefined, "one valid substantive class is not a question");
	const all = buildQuestions();
	assert.equal(Object.keys(all.literal.criteria).length, 9);
	assert.deepEqual(Object.keys(all.substantive.criteria), ["spawn", "resume", "collect", "probe", "done"]);
	assert.deepEqual(Object.keys(all.mode.criteria), ["gather", "act"]);
	assert.equal(all.pending.type, "noul");
	assert.match(buildQuestions({ pendingReply: "probe" }).literal.instructions, /A probe the orchestrator sent .* has not been answered yet/);
});

const fakeFetch = (handler) => async (url, init) => {
	const body = JSON.parse(init.body);
	const out = handler(body, init);
	return { status: out.status ?? 200, text: async () => JSON.stringify(out.body) };
};

test("askJev sends the bearer key, the model and the questions; non-200 returns the error type", async () => {
	let seen = null;
	const ok = await askJev({ state: "S", questions: { q: { type: "noul", instructions: "x" } }, key: "k1", fetchImpl: fakeFetch((b, init) => { seen = { b, auth: init.headers.Authorization }; return { body: { model: "jev-1", answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 3, output_tokens: 1 } } }; }) });
	assert.equal(seen.auth, "Bearer k1");
	assert.equal(seen.b.model, "jev-latest");
	assert.equal(seen.b.state, "S");
	assert.equal(ok.ok, true);
	assert.equal(ok.answers.q.noul, 0.7);
	const bad = await askJev({ state: "S", questions: {}, key: "k", fetchImpl: fakeFetch(() => ({ status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } })) });
	assert.equal(bad.ok, false);
	assert.equal(bad.errorType, "max_tokens_exceeded");
});

test("askWithRetry cuts the state to 80% once on max_tokens_exceeded and records it", async () => {
	const sizes = [];
	const r = await askWithRetry({ payload, key: "k", fetchImpl: fakeFetch((b) => { sizes.push(b.state.length); return sizes.length === 1 ? { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } } : { body: { model: "jev-1", answers: {}, usage: null } }; }) });
	assert.equal(sizes.length, 2);
	assert.ok(sizes[1] < sizes[0]);
	assert.equal(r.ok, true);
	assert.equal(r.truncated, true);
	assert.ok(r.kept < 1);
	assert.deepEqual(r.questions, ["literal", "mode", "pending", "substantive"]);
});

test("scoreAnswers masks to the valid classes, mirrors the local head's flags and scores every question", () => {
	const point = {
		action: { cls: "inspect", mode: "gather" }, substantive: { cls: "spawn" },
		valid: { spawn: true, resume: false, collect: false, probe: false, done: false, inspect: true, memory: true, checkpoint: true, answer: true },
		state: { pendingReply: null },
	};
	const answers = {
		literal: { type: "choice", choice: "resume", confidence: 0.9, probabilities: { resume: 0.5, inspect: 0.3, spawn: 0.15, memory: 0.05 } },
		substantive: { type: "choice", choice: "spawn", confidence: 0.8, probabilities: { spawn: 0.6, resume: 0.3, probe: 0.1 } },
		mode: { type: "choice", choice: "gather", confidence: 0.7, probabilities: { gather: 0.8, act: 0.2 } },
		pending: { type: "noul", noul: 0.2 },
	};
	const s = scoreAnswers(answers, point);
	// resume is invalid here: masked, inspect wins and the pick agrees with the record.
	assert.equal(s.literal.rawPick, "resume");
	assert.equal(s.literal.pick, "inspect");
	assert.equal(s.literal.agree, true);
	assert.ok(Math.abs(s.literal.pPick - 0.6) < 1e-9);
	assert.ok(Math.abs(s.literal.validMass - 0.5) < 1e-9);
	assert.ok(Math.abs(s.literal.pAct - 0.3) < 1e-9, "spawn is the only act class left");
	assert.equal(s.substantive.pick, "spawn");
	assert.equal(s.substantive.agree, true);
	assert.equal(s.mode.agree, true);
	assert.equal(s.pending.agree, true);
	assert.deepEqual(maskProbabilities({ a: 0.2, b: 0.2 }, { a: true, b: false }), { pValid: { a: 1 }, validMass: 0.2 });
});

test("summarise counts agreement, τ coverage and confident-and-wrong the way the local head does", () => {
	const mk = (agree, p, conf, cls = "probe") => ({ ok: true, ms: 400, point: { action: { cls } }, score: { literal: { agree, agreeTop2: true, pPick: p, pChosen: agree ? p : 1 - p, logLoss: 0.1, confidence: conf } } });
	const rows = [mk(true, 0.99, 0.95), mk(false, 0.96, 0.92), mk(true, 0.6, 0.4), mk(false, 0.55, 0.3, "done")];
	const s = summarise(rows, "literal");
	assert.equal(s.n, 4);
	assert.equal(s.agree, 2);
	assert.equal(s.confWrong, 1);
	const t95 = s.tau.find((t) => t.tau === 0.95);
	assert.equal(t95.coverage, 0.5);
	assert.equal(t95.agreement, 0.5);
	assert.equal(t95.falseConfident, 1);
	assert.equal(s.byClass.done.n, 1);
	assert.match(formatSummary(s, "literal"), /literal: 4 points · agreement 50\.0% · top-2 100\.0%/);
});

test("comparisonTable joins the local head's substantive rows by index and totals the disagreements", () => {
	const rows = [
		{ i: 0, point: { action: { cls: "inspect" }, substantive: { cls: "spawn" } }, score: { substantive: { pick: "spawn", pPick: 0.9, confidence: 0.95, agree: true } } },
		{ i: 1, point: { action: { cls: "done" }, substantive: { cls: "done" } }, score: { substantive: { pick: "probe", pPick: 0.8, confidence: 0.92, agree: false } } },
	];
	const head = [{ i: 0, head: { pickClass: "spawn", confidence: 0.99, agreeSubstantive: true } }, { i: 1, head: { pickClass: "probe", confidence: 0.97, agreeSubstantive: false } }];
	const t = comparisonTable(rows, head);
	assert.match(t, /\| 1 \| inspect \| spawn \| spawn \(0\.99\) \| spawn \(0\.90, 0\.95\) \| = \| = \| yes \|/);
	assert.match(t, /27B agrees with the record 1\/2, jev 1\/2, heads agree with each other 2\/2; confident-and-wrong: 27B \(p≥\.95\) 1, jev \(conf≥\.9\) 1/);
});
