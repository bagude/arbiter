// Deep research as a campaign: three phases run in order on one memory scope, each
// round citing what the earlier rounds established.
//
//   study     — a cited, checked reading of the paper (dw-paper-study), N rounds;
//               round N+1 recalls round N's claims and reads further
//   apply     — the paper's models fitted to the warehouse's real wells
//               (dw-paper-apply), M rounds; findings cite study claims by id
//   synthesis — one report (dw-paper-synthesis) whose claims cite memory records
//               and page quotes; the oracle resolves every citation
//
//   node tools/research.mjs <name> [--study 2] [--apply 3] [--min-novelty 0.5]
//
// Brake, per phase: a round that fails its oracle ends the phase; so does a round
// whose findings are no longer novel (same query, same rows, or a similar title
// against everything found before — the campaign.mjs test). A phase with no passing
// round ends the campaign. Per-round logs in runs/.research-<name>/; the report in
// docs/batch/research-<name>.md.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findingsOf } from "../lib/memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const argv = process.argv.slice(2);
const [name] = argv;
const opt = (flag, dflt) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const MIN_NOVELTY = opt("--min-novelty", 0.5);
const SAME_TITLE = opt("--same-title", 0.4);
const PHASES = [
	{ phase: "study", config: "configs/orch-dw-paper-study-27b.json", rounds: opt("--study", 2), file: "study.json" },
	{ phase: "apply", config: "configs/orch-dw-paper-apply-27b.json", rounds: opt("--apply", 3), file: "exploration.json" },
	{ phase: "synthesis", config: "configs/orch-dw-paper-synthesis-27b.json", rounds: 1, file: "report.json" },
];
if (!name) {
	console.error("usage: node tools/research.mjs <name> [--study N] [--apply M] [--min-novelty 0..1]");
	process.exit(1);
}
const logDir = path.join(ROOT, "runs", `.research-${name}`);
fs.mkdirSync(logDir, { recursive: true });
const say = (s) => console.log(`[research ${name}] ${s}`);

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

function runOne(phase, round, config) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(path.join(logDir, `${phase}-${round}.log`), "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], { cwd: ROOT, stdio: ["ignore", log, log] });
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}

// Novelty: the campaign.mjs test — same normalised query, identical result rows,
// or a similar title (Jaccard on content words) means "already found". Study and
// report claims have no query; their text is the title.
const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be", "are", "than", "no", "not", "only"]);
const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_.%-]+/).filter((t) => t.length > 1 && !STOP.has(t)));
function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}
const normSql = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
const fingerprint = (rows) => JSON.stringify(rows ?? []);
const seen = { queries: new Set(), results: new Set(), titles: [] };
function absorb(findings) {
	for (const o of findings) {
		if (o.query) seen.queries.add(normSql(o.query));
		if (Array.isArray(o.result) && o.result.length) seen.results.add(fingerprint(o.result));
		seen.titles.push(tokens(o.title));
	}
}
function isKnown(o) {
	if (o.query && seen.queries.has(normSql(o.query))) return "same query";
	if (Array.isArray(o.result) && o.result.length && seen.results.has(fingerprint(o.result))) return "same result";
	if (seen.titles.some((prev) => jaccard(tokens(o.title), prev) >= SAME_TITLE)) return "similar title";
	return null;
}
function seedFromMemory(scope) {
	const log = path.join(ROOT, "memory", "records.jsonl");
	let n = 0;
	if (!fs.existsSync(log)) return n;
	for (const line of fs.readFileSync(log, "utf8").split("\n")) {
		let r;
		try {
			r = JSON.parse(line);
		} catch {
			continue;
		}
		if (r?.scope !== scope || r?.op || r.kind !== "semantic" || !r.summary) continue;
		seen.titles.push(tokens(r.summary));
		n++;
	}
	return n;
}

const t0 = Date.now();
const rows = [];
const scope = `repo:${readJson(path.join(ROOT, PHASES[0].config))?.repo ?? "research"}`;
say(`novelty tally seeded with ${seedFromMemory(scope)} title(s) from memory scope ${scope}`);
let stopped = null;
for (const ph of PHASES) {
	if (stopped) break;
	let passed = 0;
	for (let round = 1; round <= ph.rounds; round++) {
		say(`${new Date().toISOString()} ${ph.phase} round ${round}/${ph.rounds} start (${path.basename(ph.config)})`);
		const { runId, code } = await runOne(ph.phase, round, path.join(ROOT, ph.config));
		const s = runId ? readJson(path.join(ROOT, "runs", runId, "summary.json")) : null;
		const doc = runId ? readJson(path.join(ROOT, "runs", runId, "ws-builder", "src", ph.file)) : null;
		const findings = findingsOf(doc).map((o, i) => ({ ...o, title: String(o.title ?? ""), query: doc?.observations?.[i]?.query, result: doc?.observations?.[i]?.result }));
		const verdicts = findings.map((o) => ({ id: o.id, claim: o.claim, title: o.title, known: isKnown(o) }));
		const fresh = verdicts.filter((v) => !v.known);
		const novelty = findings.length ? fresh.length / findings.length : 0;
		const mem = s?.memory?.calls ?? {};
		const peak = s?.contextPeak ? Math.max(...Object.values(s.contextPeak)) : "";
		const row = {
			phase: ph.phase, round, runId, exit: code, reason: s?.reason ?? "(no summary)", wallSec: s?.wallSec ?? "", probes: s?.mailByKind?.probe ?? 0,
			searches: mem.searches ?? 0, gets: mem.gets ?? 0, refused: mem.refused ?? 0, compactions: s?.compactions?.length ?? 0, peak,
			findings: findings.length, fresh: fresh.length, novelty, verdicts, open: [...(doc?.next_questions ?? []), ...(doc?.unresolved ?? [])],
		};
		rows.push(row);
		say(`${ph.phase} round ${round}: ${row.reason} in ${row.wallSec}s; ${findings.length} findings, ${fresh.length} novel (novelty ${novelty.toFixed(2)}); memory ${row.searches} searches / ${row.gets} gets / ${row.refused} refused; ${row.compactions} compaction(s)`);
		absorb(findings);
		if (!String(row.reason).startsWith("SUCCESS")) {
			say(`stop ${ph.phase}: round ${round} did not pass the oracle`);
			break;
		}
		passed++;
		if (round < ph.rounds && novelty < MIN_NOVELTY) {
			say(`stop ${ph.phase}: novelty ${novelty.toFixed(2)} < ${MIN_NOVELTY} — the phase has converged`);
			break;
		}
	}
	if (!passed) stopped = `phase ${ph.phase} had no passing round`;
}
if (stopped) say(`campaign stopped: ${stopped}`);

const last = rows.filter((r) => r.phase === "synthesis" && String(r.reason).startsWith("SUCCESS")).pop();
const reportMd = last ? fs.readFileSync(path.join(ROOT, "runs", last.runId, "ws-builder", "src", "report.md"), "utf8").trim() : null;
const md = [
	`# Research ${name} — study → apply → synthesis`,
	"",
	`${rows.length} round(s), ${((Date.now() - t0) / 3600_000).toFixed(2)} h. Phases: ${PHASES.map((p) => `${p.phase} ×${p.rounds} (${path.basename(p.config)})`).join(", ")}. Brake per phase: oracle failure, or novelty < ${MIN_NOVELTY} (same query, identical rows, or title Jaccard ≥ ${SAME_TITLE} against everything found before).${stopped ? ` Campaign stopped: ${stopped}.` : ""}`,
	"",
	"| phase | round | run | outcome | wall s | probes | mem search/get/refused | compactions | peak ctx | findings | novel | novelty |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|",
	...rows.map((r) => `| ${r.phase} | ${r.round} | ${r.runId ?? "—"} | ${r.reason} | ${r.wallSec} | ${r.probes} | ${r.searches}/${r.gets}/${r.refused} | ${r.compactions} | ${r.peak} | ${r.findings} | ${r.fresh} | ${r.novelty.toFixed(2)} |`),
	"",
	...rows.flatMap((r) => [`## ${r.phase} round ${r.round} — ${r.runId ?? "no run"}`, "", ...r.verdicts.map((v) => `- ${v.id} [${v.claim ?? "?"}]${v.known ? ` (${v.known})` : ""} ${v.title}`), "", ...(r.open.length ? ["Left open:", "", ...r.open.map((q) => `- ${q}`), ""] : [])]),
	...(reportMd ? ["## The report (synthesis, verbatim)", "", reportMd, ""] : ["## The report", "", "No synthesis round passed its oracle.", ""]),
];
fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "batch", `research-${name}.md`), md.join("\n"));
say(`report: docs/batch/research-${name}.md`);
