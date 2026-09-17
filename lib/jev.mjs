// jev — the pure half of the TypeSafe.ai "System One" shadow head. Renders a captured (or
// live) orchestrator provider payload as the plain-text state Jev takes, builds the four typed
// questions we already score our local decision head on (tools/decision-replay.mjs), sends
// them, and scores the answers against a recorded decision point. No filesystem, no timers;
// the network call is injected so ext/jev-shadow.ts and tools/jev-replay.mjs share every line
// and the tests run without a key.
//
// Verified against the API on 2026-09-17: POST https://api.typesafe.ai/v1/systemone, Bearer
// key, one state + several questions per call, ~0.4–0.6 s regardless of size; a state of
// ~30k tokens is accepted, ~33k refused with 400 {"detail":{"error_type":"max_tokens_exceeded"}}
// and nothing is silently truncated. Answers carry a probability per option and a confidence.
import { ACTION_CLASSES, SUBSTANTIVE, modeOf } from "../tools/decision-points.mjs";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** ~30k tokens at ~4 chars/token; the API refuses somewhere past 32k tokens. */
export const DEFAULT_MAX_STATE_CHARS = 110_000;

export const SUBSTANTIVE_CLASSES = ["spawn", "resume", "collect", "probe", "done"];

// Same wording as the local head's router message, so the two heads answer the same question.
export const DESCRIBE = {
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

/** One message as text: role header, string or array content flattened, tool calls named. */
export function renderMessage(m) {
	const parts = [];
	if (typeof m.content === "string") parts.push(m.content);
	else if (Array.isArray(m.content)) {
		for (const c of m.content) {
			if (c == null) continue;
			if (typeof c === "string") parts.push(c);
			else if (typeof c.text === "string") parts.push(c.text);
			else if (c.type === "tool_result") parts.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? ""));
			else parts.push(JSON.stringify(c));
		}
	}
	if (Array.isArray(m.tool_calls)) {
		for (const t of m.tool_calls) parts.push(`TOOL_CALL ${t.function?.name ?? t.name ?? "?"} ${t.function?.arguments ?? JSON.stringify(t.arguments ?? {})}`);
	}
	return `## ${String(m.role ?? "?").toUpperCase()}\n${parts.join("\n")}`;
}

/**
 * The state Jev sees: every message rendered, system prompt first, joined by blank lines.
 * Over `maxChars`, the OLDEST non-system messages are dropped until it fits — the tail is
 * where the decision lives — and the kept fraction is reported so a row can say it was cut.
 */
export function renderState(payload, { maxChars = DEFAULT_MAX_STATE_CHARS } = {}) {
	const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
	const system = msgs.filter((m) => m.role === "system");
	const rest = msgs.filter((m) => m.role !== "system");
	const join = (list) => list.map(renderMessage).join("\n\n");
	let dropped = 0;
	let text = join([...system, ...rest]);
	while (text.length > maxChars && dropped < rest.length) {
		dropped += 1;
		text = join([...system, ...rest.slice(dropped)]);
	}
	return { state: text, truncated: dropped > 0, kept: rest.length ? (rest.length - dropped) / rest.length : 1, dropped, messages: msgs.length };
}

/** The four questions. `valid` (a class→bool mask) narrows the literal question when known. */
export function buildQuestions({ valid = null, pendingReply = null } = {}) {
	const literalClasses = valid ? ACTION_CLASSES.filter((c) => valid[c]) : ACTION_CLASSES;
	const substantiveClasses = valid ? SUBSTANTIVE_CLASSES.filter((c) => valid[c]) : SUBSTANTIVE_CLASSES;
	const pending = pendingReply ? ` A ${pendingReply === "done" ? "done claim" : pendingReply === "probe" ? "probe" : "message"} the orchestrator sent to the supervisor has not been answered yet.` : "";
	const criteria = (classes) => Object.fromEntries(classes.map((c) => [c, DESCRIBE[c]]));
	const q = {
		literal: { type: "choice", instructions: `The state is an orchestrator's transcript so far (system prompt, then every message and tool result). Which kind of action will the orchestrator take next?${pending}`, criteria: criteria(literalClasses) },
		mode: { type: "choice", instructions: "Will the orchestrator's next action GATHER information (read, list, search memory, probe, checkpoint, answer in text) or ACT on the task (spawn or resume a worker, collect a result, claim done)?", criteria: { gather: "gather information first", act: "act now" } },
		pending: { type: "noul", instructions: "A reply the orchestrator is waiting for from the supervisor (a probe result, an oracle verdict, or a worker result) is still outstanding at the end of the transcript." },
	};
	if (substantiveClasses.length >= 2) {
		q.substantive = { type: "choice", instructions: `Which state-changing action will the orchestrator take next, ignoring any reads, memory lookups or checkpoints it might do first?${pending}`, criteria: criteria(substantiveClasses) };
	}
	return q;
}

/** POST one state + questions. `fetchImpl` is injectable; the key never leaves the header. */
export async function askJev({ state, questions, key, fetchImpl = globalThis.fetch, model = JEV_MODEL, url = JEV_URL }) {
	const t0 = Date.now();
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model, state, questions }),
	});
	const text = await res.text();
	let body = null;
	try { body = JSON.parse(text); } catch { body = null; }
	const ms = Date.now() - t0;
	if (res.status !== 200) {
		const errorType = body?.detail?.error_type ?? body?.error ?? text.slice(0, 200);
		return { ok: false, status: res.status, errorType, ms };
	}
	return { ok: true, status: 200, ms, model: body.model, answers: body.answers ?? {}, usage: body.usage ?? null };
}

/**
 * Ask once; on max_tokens_exceeded, cut the state to 80% (oldest messages first) and ask
 * once more. Returns the answer plus how the state was rendered.
 */
export async function askWithRetry({ payload, key, valid = null, pendingReply = null, maxChars = DEFAULT_MAX_STATE_CHARS, fetchImpl }) {
	const questions = buildQuestions({ valid, pendingReply });
	let rendered = renderState(payload, { maxChars });
	let r = await askJev({ state: rendered.state, questions, key, fetchImpl });
	if (!r.ok && r.errorType === "max_tokens_exceeded") {
		rendered = renderState(payload, { maxChars: Math.floor(rendered.state.length * 0.8) });
		r = await askJev({ state: rendered.state, questions, key, fetchImpl });
	}
	return { ...r, questions: Object.keys(questions), stateChars: rendered.state.length, truncated: rendered.truncated, kept: rendered.kept };
}

/** Renormalise a probability map over the classes a mask allows. */
export function maskProbabilities(probabilities, valid) {
	const entries = Object.entries(probabilities ?? {}).filter(([c]) => !valid || valid[c]);
	const mass = entries.reduce((s, [, p]) => s + p, 0);
	return { pValid: Object.fromEntries(entries.map(([c, p]) => [c, mass > 0 ? p / mass : 0])), validMass: mass };
}

const argmax = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/**
 * Score one answer set against a recorded decision point (a decisions.jsonl row). Every
 * flag mirrors tools/decision-replay.mjs so the tables line up: agree, top-2, log loss on the
 * recorded class, masked pick, mode, pending, and the substantive horizon when asked.
 */
export function scoreAnswers(answers, point) {
	const out = {};
	const lit = answers?.literal;
	if (lit?.probabilities) {
		const raw = lit.probabilities;
		const { pValid, validMass } = maskProbabilities(raw, point.valid ?? null);
		const pick = argmax(pValid);
		const ranked = Object.entries(pValid).sort((a, b) => b[1] - a[1]).map(([c]) => c);
		const pChosen = pValid[point.action?.cls] ?? 0;
		out.literal = {
			pick, confidence: lit.confidence ?? null, pPick: pValid[pick] ?? 0,
			agree: pick === point.action?.cls, agreeTop2: ranked.slice(0, 2).includes(point.action?.cls),
			pChosen, logLoss: -Math.log(Math.max(pChosen, 1e-6)), validMass, rawPick: lit.choice ?? argmax(raw),
			pAct: Object.entries(pValid).filter(([c]) => modeOf(c) === "act").reduce((s, [, p]) => s + p, 0),
		};
	}
	const sub = answers?.substantive;
	if (sub?.probabilities && point.substantive?.cls) {
		const { pValid } = maskProbabilities(sub.probabilities, point.valid ?? null);
		const pick = argmax(pValid);
		const pChosen = pValid[point.substantive.cls] ?? 0;
		out.substantive = { pick, confidence: sub.confidence ?? null, pPick: pValid[pick] ?? 0, agree: pick === point.substantive.cls, pChosen, logLoss: -Math.log(Math.max(pChosen, 1e-6)) };
	}
	const mode = answers?.mode;
	if (mode?.probabilities) {
		const pick = mode.choice ?? argmax(mode.probabilities);
		const recorded = point.action?.mode ?? (point.action?.cls ? modeOf(point.action.cls) : null);
		out.mode = { pick, pAct: mode.probabilities.act ?? 0, confidence: mode.confidence ?? null, agree: recorded ? pick === recorded : null };
	}
	if (typeof answers?.pending?.noul === "number") {
		const recorded = Boolean(point.state?.pendingReply);
		out.pending = { p: answers.pending.noul, pick: answers.pending.noul >= 0.5, agree: (answers.pending.noul >= 0.5) === recorded };
	}
	return out;
}

/** Bucketed calibration and the τ-curve the local head prints, over rows with a `literal` (or `substantive`) score. */
export function summarise(rows, key = "literal") {
	const scored = rows.filter((r) => r.score?.[key]);
	const n = scored.length;
	if (!n) return { n: 0 };
	const agree = scored.filter((r) => r.score[key].agree).length;
	const top2 = key === "literal" ? scored.filter((r) => r.score[key].agreeTop2).length : null;
	const logLoss = scored.reduce((s, r) => s + r.score[key].logLoss, 0) / n;
	const buckets = [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.01]].map(([lo, hi]) => {
		const inB = scored.filter((r) => r.score[key].pPick >= lo && r.score[key].pPick < hi);
		return { lo, hi: Math.min(hi, 1), n: inB.length, agree: inB.length ? inB.filter((r) => r.score[key].agree).length / inB.length : null };
	});
	const tau = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98].map((t) => {
		const covered = scored.filter((r) => r.score[key].pPick >= t);
		return { tau: t, coverage: covered.length / n, agreement: covered.length ? covered.filter((r) => r.score[key].agree).length / covered.length : null, falseConfident: covered.filter((r) => !r.score[key].agree).length };
	});
	const byClass = {};
	for (const r of scored) {
		const cls = key === "literal" ? r.point.action?.cls : r.point.substantive?.cls;
		const b = (byClass[cls] ??= { n: 0, agree: 0, pSum: 0 });
		b.n += 1; b.agree += r.score[key].agree ? 1 : 0; b.pSum += r.score[key].pChosen;
	}
	const confWrong = scored.filter((r) => (r.score[key].confidence ?? 0) >= 0.9 && !r.score[key].agree).length;
	return { n, agree, top2, logLoss, buckets, tau, byClass, confWrong, msMean: rows.reduce((s, r) => s + (r.ms ?? 0), 0) / Math.max(rows.length, 1) };
}

export function formatSummary(s, key) {
	if (!s.n) return `${key}: no scored points`;
	const pct = (x) => `${(100 * x).toFixed(1)}%`;
	const lines = [];
	lines.push(`${key}: ${s.n} points · agreement ${pct(s.agree / s.n)}${s.top2 != null ? ` · top-2 ${pct(s.top2 / s.n)}` : ""} · mean log loss ${s.logLoss.toFixed(3)} · jev ${s.msMean.toFixed(0)} ms/point · confident(≥.9)-and-wrong ${s.confWrong}`);
	lines.push("by actual class: " + Object.entries(s.byClass).map(([c, b]) => `${c} n=${b.n} agree=${pct(b.agree / b.n)} p̄=${(b.pSum / b.n).toFixed(2)}`).join("  "));
	lines.push("calibration: " + s.buckets.map((b) => `${b.lo.toFixed(2)}–${b.hi.toFixed(2)}: n=${b.n}${b.agree != null ? ` agree=${pct(b.agree)}` : ""}`).join("  "));
	lines.push("τ      coverage  agreement  false-confident");
	for (const t of s.tau) lines.push(`${t.tau.toFixed(2).padEnd(7)}${pct(t.coverage).padStart(7)}  ${t.agreement == null ? "—".padStart(9) : pct(t.agreement).padStart(9)}  ${t.falseConfident}`);
	return lines.join("\n");
}
