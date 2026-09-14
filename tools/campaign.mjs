// One driver for every campaign: phases in order, each a run config repeated for up
// to `rounds` rounds; round N+1 recalls what round N retained into memory. Brakes,
// per phase: a round that fails its oracle ends the phase, and so does a round whose
// findings are no longer novel (same query, identical rows, or a similar title against
// everything found before). A phase with no passing round ends the campaign. Budget:
// with `budget.tokens` (or --tokens), a round is skipped — and listed as skipped — when
// the budget is exhausted or the remainder is below the median round so far; a round
// that does run gets the remainder as its own caps.tokens, so one run cannot overshoot.
//
//   node tools/campaign.mjs campaigns/<name>.json [--from <phase>:<round>] [--tokens N] [--dry]
//   node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]
//
// --from starts partway (crash recovery; earlier rounds are listed as skipped, the
// novelty tally still seeds from disk and memory). --dry prints the round plan and the
// seed counts and runs nothing. Per-round logs in runs/.campaign-<name>/; the report in
// docs/batch/campaign-<name>.md; the rows in runs/.campaign-<name>/rows.json.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCampaign, legacyCampaign, decideRound, noveltyTally, seedTally, findingsWithRows, DELIVERABLES } from "../lib/campaign.mjs";
import { freshTokens } from "../lib/usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const camp = argv[0]?.endsWith(".json") ? loadCampaign(path.resolve(ROOT, argv[0]), { root: ROOT }) : legacyCampaign(argv, { root: ROOT });
if (!camp) {
	console.error("usage: node tools/campaign.mjs campaigns/<name>.json [--from <phase>:<round>] [--tokens N] [--dry]\n       node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty x] [--same-title y]");
	process.exit(1);
}
const budgetTokens = opt("--tokens") != null ? Number(opt("--tokens")) : (camp.budget?.tokens ?? null);
if (budgetTokens != null && !(Number.isInteger(budgetTokens) && budgetTokens > 0)) {
	console.error("--tokens must be a positive integer");
	process.exit(1);
}
let from = null;
if (opt("--from") != null) {
	const m = /^([\w.-]+):(\d+)$/.exec(opt("--from"));
	if (!m || !camp.phases.some((p) => p.phase === m[1])) {
		console.error(`--from must be <phase>:<round> with a phase from the campaign (${camp.phases.map((p) => p.phase).join(", ")})`);
		process.exit(1);
	}
	from = { phase: m[1], round: Number(m[2]) };
}
const DRY = flag("--dry");
const logDir = path.join(ROOT, "runs", `.campaign-${camp.name}`);
fs.mkdirSync(logDir, { recursive: true });
const say = (s) => console.log(`[campaign ${camp.name}] ${s}`);
const readJson = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

const phases = camp.phases.map((p) => ({ ...p, cfg: readJson(path.resolve(ROOT, p.config)) ?? {} }));
const tasks = [...new Set(phases.map((p) => p.cfg.task).filter(Boolean))];
const scopes = [...new Set(phases.map((p) => (p.cfg.repo ? `repo:${p.cfg.repo}` : `task:${p.cfg.task}`)))];
const tally = noveltyTally({ sameTitle: camp.brake.sameTitle });
const seeded = seedTally(tally, { runsDir: path.join(ROOT, "runs"), memoryLog: path.join(ROOT, "memory", "records.jsonl"), tasks, scopes });
say(`novelty tally seeded: ${seeded.findings} finding(s) from ${seeded.runs} earlier run(s) on disk (tasks ${tasks.join(", ")}), ${seeded.fromMemory} title(s) from memory (${scopes.join(", ")})`);

function runOne(phase, round, config, env) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(path.join(logDir, `${phase}-${round}.log`), "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, ...env } });
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}
function deliverableOf(runId, file) {
	const dir = path.join(ROOT, "runs", runId, "ws-builder", "src");
	for (const name of file ? [file] : DELIVERABLES) {
		const doc = readJson(path.join(dir, name));
		if (doc) return doc;
	}
	return null;
}

const t0 = Date.now();
const rows = [];
const roundTokens = [];
let spent = 0;
let stopped = null;
let beforeFrom = Boolean(from);
for (const ph of phases) {
	if (stopped) break;
	let passed = 0;
	for (let round = 1; round <= ph.rounds; round++) {
		if (beforeFrom && !(ph.phase === from.phase && round >= from.round)) {
			rows.push({ phase: ph.phase, round, skipped: `before --from ${from.phase}:${from.round}` });
			continue;
		}
		beforeFrom = false;
		const d = decideRound({ budgetTokens, spentTokens: spent, roundTokens });
		if (!d.run) {
			rows.push({ phase: ph.phase, round, skipped: d.reason });
			say(`${ph.phase} round ${round}: skipped — ${d.reason}`);
			continue;
		}
		const caps = d.remaining != null ? ` with caps.tokens=${d.remaining}` : "";
		if (DRY) {
			rows.push({ phase: ph.phase, round, skipped: "dry run" });
			say(`${ph.phase} round ${round}/${ph.rounds}: would run ${path.basename(ph.config)}${caps}`);
			continue;
		}
		say(`${new Date().toISOString()} ${ph.phase} round ${round}/${ph.rounds} start (${path.basename(ph.config)}${caps})`);
		const { runId, code } = await runOne(ph.phase, round, path.resolve(ROOT, ph.config), d.remaining != null ? { ARBITER_CAP_TOKENS: String(d.remaining) } : {});
		const s = runId ? readJson(path.join(ROOT, "runs", runId, "summary.json")) : null;
		const tokens = runId ? (typeof s?.tokens === "number" ? s.tokens : freshTokens(path.join(ROOT, "runs", runId))) : 0;
		spent += tokens;
		roundTokens.push(tokens);
		const doc = runId ? deliverableOf(runId, ph.file) : null;
		const findings = findingsWithRows(doc);
		const verdicts = findings.map((o) => ({ id: o.id, claim: o.claim, title: o.title, known: tally.isKnown(o) }));
		const fresh = verdicts.filter((v) => !v.known);
		const novelty = findings.length ? fresh.length / findings.length : 0;
		const mem = s?.memory?.calls ?? {};
		const row = {
			phase: ph.phase, round, runId, exit: code, reason: s?.reason ?? "(no summary)", wallSec: s?.wallSec ?? "", tokens, probes: s?.mailByKind?.probe ?? 0,
			searches: mem.searches ?? 0, gets: mem.gets ?? 0, refused: mem.refused ?? 0, compactions: s?.compactions?.length ?? 0,
			findings: findings.length, fresh: fresh.length, novelty, verdicts, open: [...(doc?.next_questions ?? []), ...(doc?.unresolved ?? [])],
		};
		rows.push(row);
		say(`${ph.phase} round ${round}: ${row.reason} in ${row.wallSec}s, ${tokens} tokens${budgetTokens != null ? ` (${spent}/${budgetTokens} spent)` : ""}; ${findings.length} findings, ${fresh.length} novel (novelty ${novelty.toFixed(2)}); memory ${row.searches}/${row.gets}/${row.refused}; ${row.compactions} compaction(s)`);
		tally.absorb(findings);
		if (!String(row.reason).startsWith("SUCCESS")) {
			say(`stop ${ph.phase}: round ${round} did not pass the oracle`);
			break;
		}
		passed++;
		if (round < ph.rounds && novelty < camp.brake.minNovelty) {
			say(`stop ${ph.phase}: novelty ${novelty.toFixed(2)} < ${camp.brake.minNovelty} — the phase has converged`);
			break;
		}
	}
	// A phase that ran and never passed ends the campaign; a phase that was skipped
	// entirely (--from, budget) does not — the next phase decides for itself.
	const ran = rows.filter((r) => r.phase === ph.phase && r.runId).length;
	if (ran && !passed) stopped = `phase ${ph.phase} had no passing round`;
}
if (stopped) say(`campaign stopped: ${stopped}`);

const lastPhase = phases[phases.length - 1].phase;
const last = [...rows].reverse().find((r) => r.runId && r.phase === lastPhase && String(r.reason).startsWith("SUCCESS"));
const reportPath = last ? path.join(ROOT, "runs", last.runId, "ws-builder", "src", "report.md") : null;
const reportMd = reportPath && fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8").trim() : null;
const md = [
	`# Campaign ${camp.name} — ${phases.map((p) => `${p.phase} ×${p.rounds} (${path.basename(p.config)})`).join(" → ")}`,
	"",
	`${rows.filter((r) => r.runId).length} round(s) run, ${rows.filter((r) => r.skipped).length} skipped, ${((Date.now() - t0) / 3600_000).toFixed(2)} h. Brake per phase: oracle failure, or novelty < ${camp.brake.minNovelty} (same query, identical rows, or title Jaccard ≥ ${camp.brake.sameTitle} against everything found before; seeded from ${seeded.findings} finding(s) in ${seeded.runs} run(s) on disk and ${seeded.fromMemory} title(s) in memory).${budgetTokens != null ? ` Budget: ${spent} of ${budgetTokens} tokens spent.` : " No token budget."}${stopped ? ` Campaign stopped: ${stopped}.` : ""}`,
	"",
	"| phase | round | run | outcome | wall s | tokens | probes | mem search/get/refused | compactions | findings | novel | novelty |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|",
	...rows.map((r) => (r.skipped ? `| ${r.phase} | ${r.round} | — | skipped: ${r.skipped} | | | | | | | | |` : `| ${r.phase} | ${r.round} | ${r.runId ?? "—"} | ${r.reason} | ${r.wallSec} | ${r.tokens} | ${r.probes} | ${r.searches}/${r.gets}/${r.refused} | ${r.compactions} | ${r.findings} | ${r.fresh} | ${r.novelty.toFixed(2)} |`)),
	"",
	...rows.filter((r) => r.runId).flatMap((r) => [`## ${r.phase} round ${r.round} — ${r.runId}`, "", ...r.verdicts.map((v) => `- ${v.id ?? ""} [${v.claim ?? "?"}]${v.known ? ` (${v.known})` : ""} ${v.title}`), "", ...(r.open.length ? ["Left open:", "", ...r.open.map((q) => `- ${q}`), ""] : [])]),
	...(reportMd ? ["## The report (final phase, verbatim)", "", reportMd, ""] : []),
];
if (!DRY) {
	fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
	fs.writeFileSync(path.join(ROOT, "docs", "batch", `campaign-${camp.name}.md`), md.join("\n"));
}
fs.writeFileSync(path.join(logDir, DRY ? "dry.json" : "rows.json"), JSON.stringify({ campaign: camp, budgetTokens, spent, rows }, null, 2));
say(DRY ? `dry run: ${rows.filter((r) => r.skipped === "dry run").length} round(s) planned, plan in ${path.relative(ROOT, path.join(logDir, "dry.json"))}` : `report: docs/batch/campaign-${camp.name}.md`);
