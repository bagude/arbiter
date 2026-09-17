// jev-replay — put every captured orchestrator decision point of a run in front of
// TypeSafe.ai's Jev (lib/jev.mjs) and score it the way tools/decision-replay.mjs scores the
// local 27B head, so the two heads and the recorded orchestrator line up point by point.
//
//   node tools/jev-replay.mjs <runId> [...] [--runs <dir>] [--limit N] [--force] [--dry-run]
//                             [--max-state-chars N] [--no-mask]
//
// Needs runs/<id>/requests/NNNN.json (ext/replay-capture.ts) and runs/<id>/decisions.jsonl
// (tools/decision-points.mjs; seq = i + 1). Writes runs/<id>/decisions-jev.jsonl, one row per
// point: the four answers, the scores, latency, usage, whether the state was cut. Rows already
// present are kept unless --force. If ext/jev-shadow.ts wrote runs/<id>/jev/NNNN.json live,
// those answers are used instead of asking again (the same question to the same state).
//
// The literal question is asked over the point's VALID classes (the mask the supervisor knew
// at that instant), as the local head is; --no-mask asks over all nine and renormalises after,
// which is what the live shadow has to do since it has no mask at request time.
//
// Key: TYPESAFE_API_KEY in the environment, else .env in the repo root. Never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askWithRetry, scoreAnswers, summarise, formatSummary, renderState, DEFAULT_MAX_STATE_CHARS } from "../lib/jev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function readKey() {
	const env = (process.env.TYPESAFE_API_KEY ?? "").trim();
	if (env) return env;
	for (const dir of [ROOT, path.resolve(ROOT, "..", ".."), path.resolve(ROOT, "..")]) {
		const f = path.join(dir, ".env");
		if (fs.existsSync(f)) {
			const m = fs.readFileSync(f, "utf8").match(/^TYPESAFE_API_KEY=(\S+)/m);
			if (m) return m[1];
		}
	}
	return "";
}

function parseArgs(argv) {
	const spec = { runs: [], runsDir: path.join(ROOT, "runs"), limit: Infinity, force: false, dryRun: false, maxChars: DEFAULT_MAX_STATE_CHARS, mask: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--runs") spec.runsDir = path.resolve(argv[++i]);
		else if (a === "--limit") spec.limit = Number(argv[++i]);
		else if (a === "--force") spec.force = true;
		else if (a === "--dry-run") spec.dryRun = true;
		else if (a === "--max-state-chars") spec.maxChars = Number(argv[++i]);
		else if (a === "--no-mask") spec.mask = false;
		else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
		else spec.runs.push(a);
	}
	if (!spec.runs.length) throw new Error("usage: node tools/jev-replay.mjs <runId> [...] [--runs <dir>] [--limit N] [--force] [--dry-run] [--max-state-chars N] [--no-mask]");
	return spec;
}

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

export function comparisonTable(rows, headRows) {
	const byI = new Map(headRows.map((h) => [h.i, h]));
	const lines = ["| i | recorded | substantive | 27B pick (p) | jev pick (p, conf) | 27B✓ | jev✓ | heads agree |", "|---|---|---|---|---|---|---|---|"];
	let both = 0, n = 0, headOk = 0, jevOk = 0, headConfWrong = 0, jevConfWrong = 0;
	for (const r of rows) {
		const h = byI.get(r.i);
		const js = r.score?.substantive;
		if (!h?.head || !js) continue;
		n += 1;
		const hp = h.head.pickClass, jp = js.pick;
		if (hp === jp) both += 1;
		if (h.head.agreeSubstantive ?? h.head.agree) headOk += 1;
		if (js.agree) jevOk += 1;
		if ((h.head.confidence ?? 0) >= 0.95 && !(h.head.agreeSubstantive ?? h.head.agree)) headConfWrong += 1;
		if ((js.confidence ?? 0) >= 0.9 && !js.agree) jevConfWrong += 1;
		lines.push(`| ${r.i + 1} | ${r.point.action?.cls} | ${r.point.substantive?.cls ?? "—"} | ${hp} (${(h.head.confidence ?? 0).toFixed(2)}) | ${jp} (${js.pPick.toFixed(2)}, ${(js.confidence ?? 0).toFixed(2)}) | ${(h.head.agreeSubstantive ?? h.head.agree) ? "=" : "≠"} | ${js.agree ? "=" : "≠"} | ${hp === jp ? "yes" : "no"} |`);
	}
	lines.push("", `substantive, ${n} points both heads answered: 27B agrees with the record ${headOk}/${n}, jev ${jevOk}/${n}, heads agree with each other ${both}/${n}; confident-and-wrong: 27B (p≥.95) ${headConfWrong}, jev (conf≥.9) ${jevConfWrong}`);
	return lines.join("\n");
}

async function replayRun(runId, spec, key) {
	const runDir = path.join(spec.runsDir, runId);
	const points = readJsonl(path.join(runDir, "decisions.jsonl"));
	if (!points.length) { console.error(`${runId}: no decisions.jsonl (run tools/decision-points.mjs first)`); return; }
	const outFile = path.join(runDir, "decisions-jev.jsonl");
	if (spec.force && fs.existsSync(outFile)) fs.writeFileSync(outFile, "");
	const existing = spec.force ? [] : readJsonl(outFile);
	const have = new Map(existing.map((r) => [r.i, r]));
	const rows = [];
	let asked = 0, tokens = 0;
	for (const point of points) {
		if (rows.length >= spec.limit) break;
		if (have.has(point.i)) { rows.push(have.get(point.i)); continue; }
		const reqFile = path.join(runDir, "requests", `${String(point.i + 1).padStart(4, "0")}.json`);
		if (!fs.existsSync(reqFile)) continue;
		const payload = JSON.parse(fs.readFileSync(reqFile, "utf8")).payload;
		if (spec.dryRun) {
			const r = renderState(payload, { maxChars: spec.maxChars });
			console.log(`${runId} #${String(point.i + 1).padStart(2)} ${String(point.action?.cls ?? "?").padEnd(10)} state ${r.state.length} chars ≈ ${Math.round(r.state.length / 4)} tokens${r.truncated ? ` (cut to ${(100 * r.kept).toFixed(0)}% of messages)` : ""}`);
			continue;
		}
		const shadowFile = path.join(runDir, "jev", `${String(point.i + 1).padStart(4, "0")}.json`);
		let r;
		let source = "replay";
		// A live shadow row asked the literal question over all nine classes (it has no mask at
		// request time); a masked replay asks over the valid ones. They are different questions,
		// so shadow rows are reused only under --no-mask — pooling them would mix two forms.
		if (!spec.mask && fs.existsSync(shadowFile)) { r = JSON.parse(fs.readFileSync(shadowFile, "utf8")); source = "shadow"; }
		else {
			r = await askWithRetry({ payload, key, valid: spec.mask ? point.valid : null, pendingReply: spec.mask ? point.state?.pendingReply : null, maxChars: spec.maxChars });
			asked += 1;
		}
		const score = r.ok ? scoreAnswers(r.answers, point) : null;
		tokens += r.usage?.input_tokens ?? 0;
		const row = { run: runId, i: point.i, source, ok: r.ok, status: r.status, errorType: r.errorType ?? null, ms: r.ms, usage: r.usage ?? null, stateChars: r.stateChars, truncated: r.truncated, kept: r.kept, answers: r.answers ?? null, score, point: { action: point.action, substantive: point.substantive ?? null, valid: point.valid, state: point.state, mode: point.action?.mode } };
		rows.push(row);
		fs.appendFileSync(outFile, JSON.stringify(row) + "\n");
		const s = score?.literal;
		console.log(`${runId} #${String(point.i + 1).padStart(2)} ${point.action.cls.padEnd(10)}→${(point.substantive?.cls ?? "—").padEnd(8)} jev ${s ? `${s.pick.padEnd(10)} p=${s.pPick.toFixed(2)} c=${(s.confidence ?? 0).toFixed(2)} ${s.agree ? "=" : "≠"}` : `ERR ${r.errorType}`}${score?.substantive ? ` | subst ${score.substantive.pick} ${score.substantive.agree ? "=" : "≠"}` : ""} | ${r.ms} ms${r.truncated ? " (cut)" : ""}`);
	}
	if (spec.dryRun) return;
	console.log("");
	console.log(`${runId}: ${rows.length} rows (${asked} asked now, ${rows.filter((r) => r.source === "shadow").length} from the live shadow, ${rows.filter((r) => !r.ok).length} errors), ${tokens} input tokens`);
	for (const q of ["literal", "substantive"]) console.log(formatSummary(summarise(rows.filter((r) => r.ok), q), q));
	const okRows = rows.filter((r) => r.ok);
	const modeN = okRows.filter((r) => r.score?.mode?.agree != null).length;
	const modeOk = okRows.filter((r) => r.score?.mode?.agree).length;
	const pendN = okRows.filter((r) => r.score?.pending).length;
	const pendOk = okRows.filter((r) => r.score?.pending?.agree).length;
	console.log(`gather-vs-act agreement ${modeN ? (100 * modeOk / modeN).toFixed(1) : "—"}% (${modeOk}/${modeN}) · pending-reply agreement ${pendN ? (100 * pendOk / pendN).toFixed(1) : "—"}% (${pendOk}/${pendN})`);
	const headRows = readJsonl(path.join(runDir, "decisions-replay-substantive.jsonl"));
	if (headRows.length) { console.log(""); console.log(comparisonTable(okRows, headRows)); }
}

async function main() {
	const spec = parseArgs(process.argv.slice(2));
	const key = spec.dryRun ? "" : readKey();
	if (!spec.dryRun && !key) { console.error("no TYPESAFE_API_KEY in the environment or .env"); process.exit(2); }
	for (const runId of spec.runs) await replayRun(runId, spec, key);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
