// Self-recursive exploration: run one config round after round. Each round's
// findings digest (observation titles + open questions) is retained into memory at
// finish and recalled by the next round, so round N+1 starts from what round N left
// open. The brake: stop when a round fails its oracle or when its observations are
// no longer novel against everything found before (title similarity), so the loop
// cannot grind out variations of the same finding forever.
//
//   node tools/campaign.mjs <name> <config.json> [--rounds 3] [--min-novelty 0.5]
//
// Per-round logs in runs/.campaign-<name>/; the report in docs/batch/campaign-<name>.md.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const argv = process.argv.slice(2);
const [name, config] = argv;
const opt = (flag, dflt) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const ROUNDS = opt("--rounds", 3);
const MIN_NOVELTY = opt("--min-novelty", 0.5);
// Title similarity at or above this counts as "already found". 0.4 (not 0.5): at 0.5
// paraphrases of earlier findings passed as novel in campaign explore-2.
const SAME_TITLE = opt("--same-title", 0.4);
if (!name || !config) {
	console.error("usage: node tools/campaign.mjs <name> <config.json> [--rounds N] [--min-novelty 0..1]");
	process.exit(1);
}
const logDir = path.join(ROOT, "runs", `.campaign-${name}`);
fs.mkdirSync(logDir, { recursive: true });

const STOP = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "is", "it", "that", "this", "on", "as", "by", "be", "are", "than", "no", "not", "only"]);
const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_.%-]+/).filter((t) => t.length > 1 && !STOP.has(t)));
function jaccard(a, b) {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

function runOne(round) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(path.join(logDir, `round-${round}.log`), "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], { cwd: ROOT, stdio: ["ignore", log, log] });
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ code, runId: after.sort().pop() ?? null });
		});
	});
}

function readJson(p) {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

// Novelty is judged on three signals, any of which marks an observation as already
// found: the same normalised query was run before; the result rows are identical to
// an earlier observation's (the same fact in other words — titles paraphrase, rows
// do not); or the title is similar. Seeds come from every earlier run's
// exploration.json on disk, and from the titles memory carries for runs whose
// directories are gone.
const normSql = (q) => String(q ?? "").toLowerCase().replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
const fingerprint = (rows) => JSON.stringify(rows ?? []);
const seen = { queries: new Set(), results: new Set(), titles: [] };
function absorb(doc) {
	let n = 0;
	for (const o of Array.isArray(doc?.observations) ? doc.observations : []) {
		if (!o || typeof o !== "object") continue;
		seen.queries.add(normSql(o.query));
		seen.results.add(fingerprint(o.result));
		seen.titles.push(tokens(o.title));
		n++;
	}
	return n;
}
function isKnown(o) {
	if (seen.queries.has(normSql(o?.query))) return "same query";
	if (Array.isArray(o?.result) && o.result.length && seen.results.has(fingerprint(o.result))) return "same result";
	if (seen.titles.some((prev) => jaccard(tokens(o?.title), prev) >= SAME_TITLE)) return "similar title";
	return null;
}
function seedFromRuns() {
	let runs = 0;
	let obs = 0;
	const runsDir = path.join(ROOT, "runs");
	for (const d of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
		if (!/^\d{4}-/.test(d)) continue;
		const doc = readJson(path.join(runsDir, d, "ws-builder", "src", "exploration.json"));
		if (!doc) continue;
		runs++;
		obs += absorb(doc);
	}
	const log = path.join(ROOT, "memory", "records.jsonl");
	let fromMemory = 0;
	if (fs.existsSync(log)) {
		for (const line of fs.readFileSync(log, "utf8").split("\n")) {
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			const m = /Findings digest: (.+)$/s.exec(r?.text ?? "");
			if (!m) continue;
			for (const part of m[1].split("||")[0].split(" | ")) {
				seen.titles.push(tokens(part.replace(/^O\d+\s+/, "")));
				fromMemory++;
			}
		}
	}
	return { runs, obs, fromMemory };
}

const rows = [];
const seeded = seedFromRuns();
console.log(`[campaign ${name}] novelty tally seeded: ${seeded.obs} observation(s) from ${seeded.runs} earlier run(s) on disk, ${seeded.fromMemory} title(s) from memory`);
const t0 = Date.now();
for (let round = 1; round <= ROUNDS; round++) {
	console.log(`[campaign ${name}] ${new Date().toISOString()} round ${round}/${ROUNDS} start`);
	const { runId, code } = await runOne(round);
	const s = runId ? readJson(path.join(ROOT, "runs", runId, "summary.json")) : null;
	const doc = runId ? readJson(path.join(ROOT, "runs", runId, "ws-builder", "src", "exploration.json")) : null;
	const observations = Array.isArray(doc?.observations) ? doc.observations.filter((o) => o && typeof o === "object") : [];
	const titles = observations.map((o) => String(o.title ?? ""));
	const verdicts = observations.map((o) => ({ title: String(o.title ?? ""), known: isKnown(o) }));
	const fresh = verdicts.filter((v) => !v.known);
	const novelty = titles.length ? fresh.length / titles.length : 0;
	const injected = s?.memory?.injected?.length ?? 0;
	const row = { round, runId, exit: code, reason: s?.reason ?? "(no summary)", wallSec: s?.wallSec ?? "", probes: s?.mailByKind?.probe ?? 0, injected, observations: titles.length, fresh: fresh.length, novelty, verdicts, next: doc?.next_questions ?? [] };
	rows.push(row);
	console.log(`[campaign ${name}] round ${round}: ${row.reason} in ${row.wallSec}s; ${titles.length} observations, ${fresh.length} novel (novelty ${novelty.toFixed(2)}); ${injected} memory records injected`);
	absorb(doc);
	if (!String(row.reason).startsWith("SUCCESS")) {
		console.log(`[campaign ${name}] stop: round ${round} did not pass the oracle`);
		break;
	}
	if (round < ROUNDS && novelty < MIN_NOVELTY) {
		console.log(`[campaign ${name}] stop: novelty ${novelty.toFixed(2)} < ${MIN_NOVELTY} — the exploration has converged`);
		break;
	}
}

const md = [
	`# Campaign ${name} — ${path.basename(config)}`,
	"",
	`${rows.length} round(s), ${((Date.now() - t0) / 3600_000).toFixed(2)} h. Brake: stop on oracle failure or novelty < ${MIN_NOVELTY} — an observation counts as already found if its query was run before, its result rows are identical to an earlier observation's, or its title is similar (Jaccard ≥ ${SAME_TITLE}); seeded from ${seeded.obs} earlier observation(s) on disk and ${seeded.fromMemory} title(s) in memory.`,
	"",
	"| round | run | outcome | wall s | probes | memory injected | observations | novel | novelty |",
	"|---|---|---|---|---|---|---|---|---|",
	...rows.map((r) => `| ${r.round} | ${r.runId ?? "—"} | ${r.reason} | ${r.wallSec} | ${r.probes} | ${r.injected} | ${r.observations} | ${r.fresh} | ${r.novelty.toFixed(2)} |`),
	"",
	...rows.flatMap((r) => [`## Round ${r.round} — ${r.runId ?? "no run"}`, "", ...r.verdicts.map((v) => `- ${v.known ? `(${v.known}) ` : ""}${v.title}`), "", ...(r.next.length ? ["Open questions left:", "", ...r.next.map((q) => `- ${q}`), ""] : [])]),
];
fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "batch", `campaign-${name}.md`), md.join("\n"));
console.log(`[campaign ${name}] report: docs/batch/campaign-${name}.md`);
