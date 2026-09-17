// jev-done — can Jev predict the oracle's verdict on a done claim from the state the
// orchestrator sent it from? The judgment invariant at the tool edge: "this done claim is
// backed by verification that covers the specification" as a truth value, scored against
// what the hidden acceptance test then said.
//
//   node tools/jev-done.mjs <runId> [...] [--runs <dir>] [--max-state-chars N] [--dry-run]
//
// For every decision point whose action is `done` (tools/decision-points.mjs), the captured
// request at that point (the state the model saw when it chose to claim) is rendered as the
// state, and Jev is asked (a) will the hidden acceptance test pass, (b) which of pass /
// fails-on-an-unverified-edge-case / fails-otherwise, (c) does the transcript show every
// specification example and degenerate input was verified against the code. The truth is the
// oracle line that follows the claim in audit.jsonl. Rows go to runs/<id>/decisions-jev-done.jsonl
// and a pooled score (AUC, catches, false alarms, τ-curve) is printed over all runs given.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askJev, renderState, requestSeqFor } from "../lib/jev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function readKey() {
	const env = (process.env.TYPESAFE_API_KEY ?? "").trim();
	if (env) return env;
	for (const dir of [ROOT, path.resolve(ROOT, "..", ".."), path.resolve(ROOT, "..")]) {
		const f = path.join(dir, ".env");
		if (fs.existsSync(f)) { const m = fs.readFileSync(f, "utf8").match(/^TYPESAFE_API_KEY=(\S+)/m); if (m) return m[1]; }
	}
	return "";
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

/**
 * Pair each done decision with its oracle verdict BY ORDER: decision `t` (request clock) and
 * audit `t` (supervisor clock) have different zeroes, so the k-th done decision (from
 * `fromIndex`, the fork's own first point) is matched to the k-th `[done]` mail in the audit,
 * and that mail's verdict is the next oracle line before the following done mail (a claim the
 * done gate refused has none).
 */
const MAIL_LINE = /^MAIL #\d+ (\S+) -> (\S+) \[(\w+)\]/; // supervisor.mjs log line, parsed positionally
const isDoneMail = (a, from) => { const m = a.type === "mail" ? MAIL_LINE.exec(a.msg ?? "") : null; return Boolean(m && m[3] === "done" && m[2] === "supervisor" && (!from || m[1] === from)); };

export function pairClaims(points, audit, fromIndex = 0, { from = null } = {}) {
	const dones = points.filter((p) => p.action?.cls === "done" && p.i >= fromIndex).sort((a, b) => a.i - b.i);
	const mails = [];
	for (let k = 0; k < audit.length; k++) {
		const a = audit[k];
		// The kind comes from the line's own field, never from the body slice, and only mails to
		// the supervisor count (a worker's or critic's own "done" to another role is not a claim).
		if (!isDoneMail(a, from)) continue;
		let oracle = null;
		for (let j = k + 1; j < audit.length; j++) {
			const b = audit[j];
			if (isDoneMail(b, from)) break;
			const m = b.type === "oracle" ? String(b.msg).match(/Oracle run #(\d+): (\d+)\/(\d+)/) : null;
			if (m) { oracle = { t: Number(b.t), run: Number(m[1]), passed: Number(m[2]), total: Number(m[3]) }; break; }
		}
		mails.push({ t: Number(a.t), oracle });
	}
	return dones.map((d, k) => ({ point: d, mail: mails[k] ?? null, oracle: mails[k]?.oracle ?? null }));
}

export function questions() {
	return {
		passes: { type: "noul", instructions: "The orchestrator is about to claim the task is done. Given everything in the transcript, the hidden acceptance test (which checks every rule and example in the specification, including degenerate inputs) will pass on the current code." },
		verdict: { type: "choice", instructions: "What will the hidden acceptance test say about the code as it stands at the end of the transcript?", criteria: { pass: "every case passes", edge: "it fails on an input the transcript never verified: a degenerate input (empty string, '.', '/', trailing separator, non-string) or a specification example that was not probed against the code", other: "it fails for another reason (wrong rule, crash, missing function)" } },
		covered: { type: "noul", instructions: "The transcript shows that every example in the specification and each function's degenerate inputs were verified against the CURRENT code (a probe or test run after the last edit) before this claim." },
	};
}

function auc(rows) {
	const pos = rows.filter((r) => !r.pass), neg = rows.filter((r) => r.pass);
	if (!pos.length || !neg.length) return null;
	let s = 0;
	for (const p of pos) for (const n of neg) s += p.pPasses < n.pPasses ? 1 : p.pPasses === n.pPasses ? 0.5 : 0;
	return s / (pos.length * neg.length);
}

async function main() {
	const argv = process.argv.slice(2);
	const spec = { runs: [], runsDir: path.join(ROOT, "runs"), maxChars: 100_000, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--runs") spec.runsDir = path.resolve(argv[++i]);
		else if (a === "--max-state-chars") spec.maxChars = Number(argv[++i]);
		else if (a === "--dry-run") spec.dryRun = true;
		else if (a === "--all") spec.runs.push(...fs.readdirSync(spec.runsDir).filter((r) => /^\d{4}-/.test(r) && fs.existsSync(path.join(spec.runsDir, r, "requests")) && fs.existsSync(path.join(spec.runsDir, r, "decisions.jsonl"))));
		else spec.runs.push(a);
	}
	if (!spec.runs.length) { console.error("usage: node tools/jev-done.mjs <runId> [...] | --all [--runs <dir>] [--dry-run]"); process.exit(2); }
	const key = spec.dryRun ? "" : readKey();
	if (!spec.dryRun && !key) { console.error("no TYPESAFE_API_KEY"); process.exit(2); }
	const rows = [];
	for (const runId of spec.runs) {
		const runDir = path.join(spec.runsDir, runId);
		const points = readJsonl(path.join(runDir, "decisions.jsonl"));
		const audit = readJsonl(path.join(runDir, "audit.jsonl"));
		const summary = fs.existsSync(path.join(runDir, "summary.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8")) : null;
		const forkCall = summary?.fork?.call ?? null;
		const pairs = pairClaims(points, audit, forkCall === null ? 0 : forkCall - 1).filter((p) => p.oracle);
		for (const { point, oracle } of pairs) {
			const reqFile = path.join(runDir, "requests", `${String(requestSeqFor(point.i, forkCall)).padStart(4, "0")}.json`);
			if (!fs.existsSync(reqFile)) continue;
			const pass = oracle.passed === oracle.total;
			if (spec.dryRun) { console.log(`${runId} #${point.i + 1} done → oracle #${oracle.run} ${oracle.passed}/${oracle.total}`); rows.push({ pass }); continue; }
			const payload = JSON.parse(fs.readFileSync(reqFile, "utf8")).payload;
			let rendered = renderState(payload, { maxChars: spec.maxChars });
			let r = await askJev({ state: rendered.state, questions: questions(), key });
			if (!r.ok && r.errorType === "max_tokens_exceeded") { rendered = renderState(payload, { maxChars: Math.floor(rendered.state.length * 0.8) }); r = await askJev({ state: rendered.state, questions: questions(), key }); }
			if (!r.ok) { console.log(`${runId} #${point.i + 1} ERR ${r.status} ${r.errorType}`); continue; }
			const row = { run: runId, i: point.i, oracleRun: oracle.run, score: `${oracle.passed}/${oracle.total}`, pass, pPasses: r.answers.passes?.noul ?? 0, verdict: r.answers.verdict?.choice ?? "?", pVerdict: r.answers.verdict?.probabilities ?? null, conf: r.answers.verdict?.confidence ?? 0, pCovered: r.answers.covered?.noul ?? 0, truncated: rendered.truncated, kept: rendered.kept, ms: r.ms, usage: r.usage ?? null };
			rows.push(row);
			fs.appendFileSync(path.join(runDir, "decisions-jev-done.jsonl"), JSON.stringify(row) + "\n");
			console.log(`${runId} #${String(point.i + 1).padStart(2)} oracle ${row.score.padEnd(6)} jev passes=${row.pPasses.toFixed(2)} covered=${row.pCovered.toFixed(2)} ${row.verdict.padEnd(5)} c=${row.conf.toFixed(2)} ${pass === (row.pPasses >= 0.5) ? "=" : "≠"} | ${r.ms} ms${rendered.truncated ? " (cut)" : ""}`);
		}
	}
	const n = rows.length, fails = rows.filter((r) => !r.pass), passes = rows.filter((r) => r.pass);
	console.log(`\n${n} done claims with a verdict: ${passes.length} passed, ${fails.length} failed`);
	if (spec.dryRun) return;
	console.log(`predict-fail at passes<0.5: caught ${fails.filter((r) => r.pPasses < 0.5).length}/${fails.length}, false alarms ${passes.filter((r) => r.pPasses < 0.5).length}/${passes.length} · verdict≠pass: ${rows.filter((r) => r.verdict !== "pass").length} flagged, ${rows.filter((r) => r.verdict !== "pass" && !r.pass).length} truly failing · AUC(passes) ${auc(rows)?.toFixed(3) ?? "—"} · AUC(covered) ${auc(rows.map((r) => ({ ...r, pPasses: r.pCovered })))?.toFixed(3) ?? "—"}`);
	console.log("τ (flag when passes<τ)  flagged  caught  false-alarms");
	for (const t of [0.3, 0.5, 0.7, 0.8, 0.9]) {
		const f = rows.filter((r) => r.pPasses < t);
		console.log(`${t.toFixed(2).padEnd(23)} ${String(f.length).padStart(7)}  ${String(f.filter((r) => !r.pass).length).padStart(6)}  ${String(f.filter((r) => r.pass).length).padStart(12)}`);
	}
	const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
	console.log(`mean passes: failing claims ${mean(fails.map((r) => r.pPasses)).toFixed(2)}, passing claims ${mean(passes.map((r) => r.pPasses)).toFixed(2)} · mean covered: failing ${mean(fails.map((r) => r.pCovered)).toFixed(2)}, passing ${mean(passes.map((r) => r.pCovered)).toFixed(2)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1); });
