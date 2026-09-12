// Run a list of configs one after another and write a report at the end.
//
//   node tools/batch.mjs <name> configs/a.json configs/b.json ...
//
// Each run is a child `node supervisor.mjs --config <file>` awaited to exit (the
// supervisor ends itself on success, cap, or stall). Progress lines go to stdout;
// per-run logs to runs/.batch-<name>/<config>.log; the report to
// docs/batch/<name>.md with one row per run (outcome, oracle score, wall, tool
// calls, probes, done attempts, guards) plus the KPI lines, and the console is
// rebuilt so the runs show up there.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const [, , name, ...configs] = process.argv;
if (!name || !configs.length) {
	console.error("usage: node tools/batch.mjs <name> <config.json> ...");
	process.exit(1);
}
const logDir = path.join(ROOT, "runs", `.batch-${name}`);
fs.mkdirSync(logDir, { recursive: true });

function runOne(config) {
	return new Promise((resolve) => {
		const before = new Set(fs.readdirSync(path.join(ROOT, "runs")));
		const log = fs.openSync(path.join(logDir, `${path.basename(config, ".json")}.log`), "w");
		const child = spawn(process.execPath, [path.join(ROOT, "supervisor.mjs"), "--config", config], { cwd: ROOT, stdio: ["ignore", log, log] });
		child.on("exit", (code) => {
			fs.closeSync(log);
			const after = fs.readdirSync(path.join(ROOT, "runs")).filter((d) => !before.has(d) && /^\d{4}-/.test(d));
			resolve({ config, code, runId: after.sort().pop() ?? null });
		});
	});
}

const rows = [];
const t0 = Date.now();
for (const config of configs) {
	const started = new Date().toISOString();
	console.log(`[batch ${name}] ${started} start ${config}`);
	const { runId, code } = await runOne(config);
	let s = null;
	if (runId && fs.existsSync(path.join(ROOT, "runs", runId, "summary.json"))) s = JSON.parse(fs.readFileSync(path.join(ROOT, "runs", runId, "summary.json"), "utf8"));
	const oracle = runId ? (fs.readFileSync(path.join(ROOT, "runs", runId, "audit.jsonl"), "utf8").match(/Oracle run #\d+: (\d+\/\d+)/g) ?? []).map((m) => m.replace(/.*: /, "")).join(", ") : "";
	const row = {
		config: path.basename(config, ".json"),
		task: s?.task ?? "?",
		runId,
		exit: code,
		reason: s?.reason ?? "(no summary)",
		oracle,
		wallSec: s?.wallSec ?? "",
		toolCalls: s ? Object.values(s.toolCalls ?? {}).reduce((a, b) => a + b, 0) : "",
		workers: s?.workers ?? "",
		probes: s?.mailByKind?.probe ?? 0,
		doneAttempts: s?.doneAttempts ?? "",
		guards: s?.guards ? Object.entries(s.guards).map(([g, kinds]) => `${g}:${Object.values(kinds).flatMap((r) => Object.values(r)).reduce((a, b) => a + b, 0)}`).join(" ") : "",
	};
	rows.push(row);
	console.log(`[batch ${name}] done ${row.config} → ${row.reason} (${row.oracle || "no oracle"}) in ${row.wallSec}s`);
}

const md = [
	`# batch ${name}`,
	"",
	`Started ${new Date(t0).toISOString()}, finished ${new Date().toISOString()} (${((Date.now() - t0) / 3600e3).toFixed(2)} h). ${rows.length} runs.`,
	"",
	"| task | run | outcome | oracle | wall s | tool calls | workers | probes | done | guards |",
	"|---|---|---|---|---|---|---|---|---|---|",
	...rows.map((r) => `| ${r.task} | ${r.runId ?? "—"} | ${r.reason} | ${r.oracle || "—"} | ${r.wallSec} | ${r.toolCalls} | ${r.workers} | ${r.probes} | ${r.doneAttempts} | ${r.guards} |`),
	"",
	`Successes: ${rows.filter((r) => String(r.reason).startsWith("SUCCESS")).length}/${rows.length}.`,
	"",
];
fs.mkdirSync(path.join(ROOT, "docs", "batch"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "batch", `${name}.md`), md.join("\n"));
try {
	spawnSync(process.execPath, [path.join(ROOT, "tools", "extract-runs.mjs")], { cwd: ROOT, stdio: "ignore" });
	spawnSync(process.execPath, [path.join(ROOT, "tools", "build-console.mjs")], { cwd: ROOT, stdio: "ignore" });
} catch {}
console.log(`[batch ${name}] report: docs/batch/${name}.md`);
