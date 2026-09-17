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
import { ACTION_CLASSES, modeOf } from "../tools/decision-points.mjs";

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
	// Each message is rendered once; the cut is found by one cumulative scan from the tail
	// (the separator between kept messages counts too), so a long transcript costs O(n).
	const sysText = system.map(renderMessage);
	const restText = rest.map(renderMessage);
	const sep = 2; // "\n\n"
	let budget = maxChars - sysText.reduce((s, t) => s + t.length + sep, 0);
	let keep = 0;
	for (let k = restText.length - 1; k >= 0; k--) {
		const cost = restText[k].length + sep;
		if (cost > budget) break;
		budget -= cost;
		keep += 1;
	}
	const dropped = rest.length - keep;
	const text = [...sysText, ...restText.slice(dropped)].join("\n\n");
	return { state: text, truncated: dropped > 0, kept: rest.length ? keep / rest.length : 1, dropped, messages: msgs.length };
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
	};
	// The pending question is a prediction; when the caller already states the answer in the
	// hint above (pendingReply set), asking it in the same call would leak it — so it is only
	// asked when nothing in the request says it.
	if (!pendingReply) q.pending = { type: "noul", instructions: "A reply the orchestrator is waiting for from the supervisor (a probe result, an oracle verdict, or a worker result) is still outstanding at the end of the transcript." };
	if (substantiveClasses.length >= 2) {
		q.substantive = { type: "choice", instructions: `Which state-changing action will the orchestrator take next, ignoring any reads, memory lookups or checkpoints it might do first?${pending}`, criteria: criteria(substantiveClasses) };
	}
	return q;
}

/** POST one state + questions. `fetchImpl` is injectable; the key never leaves the header. */
export async function askJev({ state, questions, key, fetchImpl = globalThis.fetch, model = JEV_MODEL, url = JEV_URL, timeoutMs = 15_000 }) {
	const t0 = Date.now();
	let res;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, state, questions }),
			signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined,
		});
	} catch (err) {
		return { ok: false, status: 0, errorType: err?.name === "TimeoutError" ? "timeout" : String(err?.message ?? err).slice(0, 200), ms: Date.now() - t0 };
	}
	const text = await res.text();
	let body = null;
	try { body = JSON.parse(text); } catch { body = null; }
	const ms = Date.now() - t0;
	if (res.status !== 200) {
		const errorType = body?.detail?.error_type ?? (typeof body?.detail === "string" ? body.detail.toLowerCase().replace(/\s+/g, "_") : null) ?? body?.error ?? text.slice(0, 200);
		return { ok: false, status: res.status, errorType, ms };
	}
	return { ok: true, status: 200, ms, model: body.model, answers: body.answers ?? {}, usage: body.usage ?? null };
}

/**
 * Ask once; on max_tokens_exceeded, cut the state to 80% (oldest messages first) and ask
 * once more. Returns the answer plus how the state was rendered.
 */
export async function askWithRetry({ payload, key, valid = null, pendingReply = null, maxChars = DEFAULT_MAX_STATE_CHARS, fetchImpl, redactSecrets = false }) {
	const questions = buildQuestions({ valid, pendingReply });
	const scrub = (r) => (redactSecrets ? { ...r, state: redact(r.state) } : r);
	let rendered = scrub(renderState(payload, { maxChars }));
	let r = await askJev({ state: rendered.state, questions, key, fetchImpl });
	if (!r.ok && r.errorType === "max_tokens_exceeded") {
		rendered = scrub(renderState(payload, { maxChars: Math.floor(rendered.state.length * 0.8) }));
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
		const cls = (key === "literal" ? r.point?.action?.cls : r.point?.substantive?.cls) ?? "(none)";
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

// ---------- the done-claim check (docs/batch/jev-3.md) ----------
// A pre-commit critic at the one boundary where a wrong claim costs an attempt. Pure: the
// supervisor supplies the state and the answers; these functions decide, phrase and redact.

/**
 * Secrets never leave the box even when nothing in this harness is sensitive today: bearer
 * tokens, API keys of the common shapes, KEY=/TOKEN=/SECRET=/PASSWORD= assignments, and long
 * bare hex/base64 runs after a key-like word. Applied to the rendered state before egress.
 */
export function redact(text) {
	return String(text)
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[REDACTED]")
		.replace(/\b(sk|pk|rk|apikey|api_key|key|token|secret|ghp|gho|xox[abp]|AKIA)[_-]?[A-Za-z0-9]{0,8}[_-]([A-Za-z0-9_-]{20,})/g, "$1_[REDACTED]")
		.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{20,})/g, "[REDACTED]")
		.replace(/((?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*['"]?)([^\s'"]{8,})/gi, "$1[REDACTED]")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}

/** The unverified-input families a nudge can name; generic across tasks. */
export const DONE_TARGETS = {
	empty: "the empty string (or an empty collection) as an argument",
	dot: "'.' or a path that normalises to '.'",
	root: "'/' or a path that normalises to the root",
	trailing: "a trailing separator, or repeated separators",
	nonstring: "a non-string or otherwise wrong-typed argument",
	examples: "a specification example that was never probed or tested against the current code",
	mixed: "a case the specification calls out as an error (e.g. mixed absolute and relative)",
};

export function doneCheckQuestions() {
	const q = {
		passes: { type: "noul", instructions: "The orchestrator has just claimed the task is done. Given everything in the transcript, the hidden acceptance test (which checks every rule and example in the specification, including degenerate inputs) will pass on the current code." },
		verdict: { type: "choice", instructions: "What will the hidden acceptance test say about the code as it stands at the end of the transcript?", criteria: { pass: "every case passes", edge: "it fails on an input the transcript never verified: a degenerate input (empty string, '.', '/', trailing separator, non-string) or a specification example that was not probed against the code", other: "it fails for another reason (wrong rule, crash, missing function)" } },
	};
	for (const [k, desc] of Object.entries(DONE_TARGETS)) q[`target_${k}`] = { type: "noul", instructions: `For at least one function in the specification, ${desc} was NOT verified against the current code in the transcript, and the specification determines its result.` };
	return q;
}

/**
 * The hold decision. `mode` shadow → never hold (record only); nudge → hold once per oracle
 * attempt (holdsUsed counts holds since the last verdict); a claim is held when the verdict is
 * `edge` with p(edge) ≥ threshold. Targets are the families whose truth value clears 0.5,
 * strongest first, capped at three; if none clears, the two strongest are named anyway so the
 * nudge is always actionable. Raw probabilities travel with the decision for the record.
 */
export function decideDoneNudge(answers, { mode = "nudge", threshold = 0.5, holdsUsed = 0, maxHolds = 1 } = {}) {
	const v = answers?.verdict ?? {};
	const pEdge = v.probabilities?.edge ?? (v.choice === "edge" ? 1 : 0);
	const pPass = answers?.passes?.noul ?? null;
	const targetsAll = Object.keys(DONE_TARGETS).map((k) => ({ key: k, p: answers?.[`target_${k}`]?.noul ?? 0 })).sort((a, b) => b.p - a.p);
	const clearing = targetsAll.filter((t) => t.p >= 0.5).slice(0, 3);
	const targets = (clearing.length ? clearing : targetsAll.slice(0, 2)).map((t) => t.key);
	const raw = { pPass, verdict: v.choice ?? null, pVerdict: v.probabilities ?? null, confidence: v.confidence ?? null, targets: Object.fromEntries(targetsAll.map((t) => [t.key, t.p])) };
	const wouldHold = v.choice === "edge" && pEdge >= threshold;
	if (mode === "shadow") return { act: "pass", reason: "shadow", wouldHold, pEdge, targets, raw };
	if (!wouldHold) return { act: "pass", reason: v.choice === "edge" ? `p(edge)=${pEdge.toFixed(2)} < ${threshold}` : `verdict ${v.choice ?? "none"}`, wouldHold, pEdge, targets, raw };
	if (holdsUsed >= maxHolds) return { act: "pass", reason: `hold already used this attempt (${holdsUsed}/${maxHolds})`, wouldHold, pEdge, targets, raw };
	return { act: "hold", reason: `verdict edge, p=${pEdge.toFixed(2)}`, wouldHold, pEdge, targets, raw };
}

export function nudgeText(decision, { attemptsLeft = null } = {}) {
	const lines = decision.targets.map((k) => `- ${DONE_TARGETS[k]}`);
	return `[SUPERVISOR] Your done claim is on hold, once: a pre-commit check rates it likely to fail the acceptance test on an input the transcript never verified (p=${decision.pEdge.toFixed(2)}). Before you claim again, verify these against the CURRENT code for every exported function, with a probe or the test suite, and fix what you find:\n${lines.join("\n")}\nThen send done again. This hold happens at most once per attempt; the next claim goes to the acceptance test${attemptsLeft != null ? ` (${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left)` : ""}.`;
}
