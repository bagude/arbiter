import { test } from "node:test";
import assert from "node:assert/strict";
import { headRequest, distributionFrom, scorePoint, summarize, matrix } from "../tools/decision-replay.mjs";

const VALID_EARLY = { spawn: true, resume: false, collect: false, probe: false, done: false, inspect: true, memory: true, checkpoint: true, answer: true };

test("headRequest keeps the captured state, disables thinking, asks one token, lists only valid actions with their fixed letters", () => {
	const payload = { model: "qwen3-27b", stream: true, max_tokens: 100000, messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: [{ type: "function", function: { name: "read" } }], chat_template_kwargs: { enable_thinking: true } };
	const req = headRequest(payload, VALID_EARLY);
	assert.equal(req.stream, false);
	assert.equal(req.max_tokens, 1);
	assert.equal(req.temperature, 0);
	assert.equal(req.logprobs, true);
	assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false });
	assert.deepEqual(req.tools, payload.tools);
	assert.equal(req.messages.length, 3);
	assert.deepEqual(req.messages.slice(0, 2), payload.messages, "the captured messages are untouched");
	const q = req.messages[2];
	assert.equal(q.role, "user");
	assert.match(q.content, /^\[ROUTER\]/);
	assert.match(q.content, /\nA\. spawn/);
	assert.doesNotMatch(q.content, /\nB\. resume/, "resume is not valid at this point, so it is not offered");
	assert.match(q.content, /\nF\. inspect/);
	assert.match(q.content, /\nI\. answer/);
});

test("distributionFrom reads the nine letters out of top_logprobs and pools everything else", () => {
	const choice = { message: { content: "D" }, logprobs: { content: [{ token: "D", logprob: Math.log(0.5), top_logprobs: [
		{ token: "D", logprob: Math.log(0.5) }, { token: "A", logprob: Math.log(0.3) }, { token: " F", logprob: Math.log(0.1) }, { token: "<tool_call>", logprob: Math.log(0.05) }, { token: "The", logprob: Math.log(0.05) },
	] }] } };
	const d = distributionFrom(choice);
	assert.equal(d.sampled, "D");
	assert.ok(Math.abs(d.raw.D - 0.5) < 1e-9 && Math.abs(d.raw.A - 0.3) < 1e-9 && Math.abs(d.raw.F - 0.1) < 1e-9, "a leading space on a letter token is tolerated");
	assert.equal(d.raw.B, 0);
	assert.ok(Math.abs(d.other - 0.1) < 1e-9);
});

test("scorePoint renormalises over the valid set, agrees when the top valid letter is the chosen action, and reports log loss and entropy", () => {
	const point = { action: { cls: "spawn", symbol: "A" }, valid: VALID_EARLY };
	const raw = { A: 0.4, B: 0.3, C: 0, D: 0, E: 0, F: 0.1, G: 0.05, H: 0.05, I: 0 };
	const s = scorePoint(point, { raw, other: 0.1 });
	// B is not valid, so the valid mass is A+F+G+H+I = 0.6 and A renormalises to 0.667
	assert.equal(s.pick, "A");
	assert.equal(s.pickClass, "spawn");
	assert.ok(Math.abs(s.confidence - 0.4 / 0.6) < 1e-9);
	assert.equal(s.agree, true);
	assert.equal(s.agreeTop2, true);
	assert.deepEqual(s.top2, ["A", "F"]);
	assert.ok(Math.abs(s.logLoss + Math.log(0.4 / 0.6)) < 1e-9);
	assert.ok(s.entropy > 0 && s.entropy < Math.log(5));
	assert.ok(Math.abs(s.validMass - 0.6) < 1e-9);
	const disagree = scorePoint({ action: { cls: "inspect", symbol: "F" }, valid: VALID_EARLY }, { raw, other: 0.1 });
	assert.equal(disagree.agree, false);
	assert.equal(disagree.agreeTop2, true);
	const invalidChoice = scorePoint({ action: { cls: "resume", symbol: "B" }, valid: VALID_EARLY }, { raw, other: 0.1 });
	assert.equal(invalidChoice.chosenValid, false, "the orchestrator did something the mask calls invalid: recorded, scored as p=0");
	assert.equal(invalidChoice.pChosen, 0);
});

test("summarize builds the threshold curve with coverage, agreement, and the generative cost avoided", () => {
	const mk = (cls, symbol, conf, pick, decoded, inferenceMs) => ({ run: "r", i: 0, action: { cls, symbol }, decoded, inferenceMs, outcome: { runOk: true }, head: { agree: pick === symbol, agreeTop2: true, confidence: conf, pickClass: pick === "A" ? "spawn" : "probe", pChosen: pick === symbol ? conf : 1 - conf, logLoss: -Math.log(pick === symbol ? conf : 1 - conf), wallMs: 100 } });
	const rows = [mk("spawn", "A", 0.97, "A", 1000, 10000), mk("probe", "D", 0.96, "A", 3000, 30000), mk("inspect", "F", 0.6, "A", 500, 5000)];
	const s = summarize(rows);
	assert.equal(s.n, 3);
	assert.ok(Math.abs(s.agreement - 1 / 3) < 1e-9);
	const at95 = s.curve.find((c) => c.tau === 0.95);
	assert.ok(Math.abs(at95.coverage - 2 / 3) < 1e-9);
	assert.equal(at95.agreement, 0.5);
	assert.ok(Math.abs(at95.decodedAvoided - 4000 / 4500) < 1e-9);
	assert.equal(at95.inferAvoidedS, 40);
	assert.equal(at95.falseConfident.length, 1);
	assert.equal(at95.falseConfident[0].actual, "probe");
	assert.equal(s.byClass.probe.agreement, 0);
});

test("mode B asks for thinking with a grammar that ends on one letter; the distribution comes from the last token", () => {
	const payload = { model: "m", messages: [{ role: "user", content: "U" }], tools: [], chat_template_kwargs: { enable_thinking: true } };
	const req = headRequest(payload, VALID_EARLY, { thinking: true });
	assert.equal(req.chat_template_kwargs.enable_thinking, true);
	assert.ok(req.max_tokens > 1);
	assert.match(req.grammar, /<think>/);
	assert.match(req.grammar, /\[A-I\]$/);
	const choice = { message: { content: "<think>reasoning here</think>\n\nA" }, logprobs: { content: [
		{ token: "<think>", logprob: 0, top_logprobs: [] }, { token: "reasoning", logprob: 0, top_logprobs: [] }, { token: "</think>", logprob: 0, top_logprobs: [] },
		{ token: "A", logprob: Math.log(0.9), top_logprobs: [{ token: "A", logprob: Math.log(0.9) }, { token: "F", logprob: Math.log(0.1) }] },
	] } };
	const d = distributionFrom(choice);
	assert.equal(d.sampled, "A");
	assert.equal(d.thinkTokens, 3);
	assert.equal(d.thought, "reasoning here");
	assert.ok(Math.abs(d.raw.A - 0.9) < 1e-9 && Math.abs(d.raw.F - 0.1) < 1e-9);
});

test("scorePoint scores the substantive horizon and the gather-vs-act binary alongside the literal label", () => {
	const point = { action: { cls: "inspect", symbol: "F", mode: "gather" }, substantive: { cls: "spawn", symbol: "A", gatherSteps: 2 }, valid: VALID_EARLY };
	const s = scorePoint(point, { raw: { A: 0.7, B: 0, C: 0, D: 0, E: 0, F: 0.2, G: 0.05, H: 0.05, I: 0 }, other: 0 });
	assert.equal(s.agree, false, "literal: the orchestrator inspected");
	assert.equal(s.agreeSubstantive, true, "horizon: the next substantive action was the spawn the head predicted");
	assert.ok(Math.abs(s.pAct - 0.7) < 1e-9);
	assert.equal(s.modePick, "act");
	assert.equal(s.agreeMode, false);
	// a probe is gather for the binary: P(act) excludes it
	const later = { spawn: true, resume: true, collect: false, probe: true, done: true, inspect: true, memory: true, checkpoint: true, answer: true };
	const p2 = scorePoint({ action: { cls: "probe", symbol: "D", mode: "gather" }, substantive: { cls: "probe", symbol: "D", gatherSteps: 0 }, valid: later }, { raw: { A: 0.1, B: 0.1, C: 0, D: 0.6, E: 0.1, F: 0.1, G: 0, H: 0, I: 0 }, other: 0 });
	assert.ok(Math.abs(p2.pAct - 0.3) < 1e-9);
	assert.equal(p2.modePick, "gather");
	assert.equal(p2.agreeMode, true);
	assert.equal(p2.agreeSubstantive, true);
});

test("matrix reads both replay files per run and reports three horizons × two modes with the reasoning cost", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
	const id = `_matrix-test-${process.pid}`;
	const dir = path.join(root, "runs", id);
	fs.mkdirSync(dir, { recursive: true });
	const row = (i, head) => JSON.stringify({ run: id, i, action: { cls: "inspect", symbol: "F", mode: "gather" }, head: { agree: false, agreeSubstantive: true, agreeMode: false, modePick: "act", confidence: 0.6, wallMs: 100, thinkTokens: 0, ...head } });
	try {
		fs.writeFileSync(path.join(dir, "decisions-replay.jsonl"), [row(0, {}), row(1, { agree: true, agreeMode: true, modePick: "gather" })].join("\n") + "\n");
		fs.writeFileSync(path.join(dir, "decisions-replay-thinking.jsonl"), [row(0, { agreeMode: true, modePick: "gather", confidence: 0.95, thinkTokens: 300, wallMs: 4000 }), row(1, { agree: true, agreeMode: true, modePick: "gather", thinkTokens: 100, wallMs: 2000 })].join("\n") + "\n");
		const m = matrix([id]);
		assert.deepEqual(m.n, { A: 2, B: 2 });
		assert.equal(m.cells["literal next action"].A, 0.5);
		assert.equal(m.cells["next substantive action"].B, 1);
		assert.equal(m.cells["gather vs act"].A, 0.5);
		assert.equal(m.cells["gather vs act"].B, 1);
		assert.equal(m.thinkTokensPerPoint, 200);
		assert.equal(m.paired, 2);
		assert.equal(m.modeFlipped, 1);
		assert.equal(m.flippedToCorrect, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
