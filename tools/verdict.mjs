// A human verdict on a run — the oracle of last resort, recorded as such.
//
//   node tools/verdict.mjs <runId> accept|reject "<why>"
//
// Writes `humanVerdict` into runs/<runId>/summary.json, appends a human-sourced,
// promoted memory record with the run as evidence, and rules on the run's
// agent-sourced candidate findings: accept promotes them, reject tombstones them
// with the reason. This is how a weak- or no-oracle run's claims become knowledge
// (or stop being candidates) without a model judging its own work.
// ARBITER_HOME overrides the checkout (tests point it at a scratch copy).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecord, foldLog, readLog, appendLog, memoryPaths, renderAll } from "../lib/memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.ARBITER_HOME ?? path.join(here, "..");
const [, , runId, verdict, ...whyParts] = process.argv;
const why = whyParts.join(" ").trim();

function fail(msg) {
	console.error(`verdict: ${msg}\nusage: node tools/verdict.mjs <runId> accept|reject "<why>"`);
	process.exit(1);
}
if (!runId) fail("missing runId");
if (verdict !== "accept" && verdict !== "reject") fail(`verdict must be accept or reject (got ${JSON.stringify(verdict)})`);
if (!why) fail("missing reason");
const summaryPath = path.join(HOME, "runs", runId, "summary.json");
if (!fs.existsSync(summaryPath)) fail(`no run ${runId} (${summaryPath})`);

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const ts = Date.now();
summary.humanVerdict = { verdict, why, ts };
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

const { log } = memoryPaths(HOME);
const records = foldLog(readLog(log));
// A repo run learns for the repo (same rule as retention).
const scope = summary.config?.repo ? `repo:${summary.config.repo}` : summary.task ? `task:${summary.task}` : "global";
const ops = [
	makeRecord({ scope, kind: "episodic", text: `human verdict on run ${runId}: ${verdict} — ${why}`, evidence: [`run:${runId}`], confidence: 0.95, source: "human", status: "promoted", ts }),
];
let ruled = 0;
for (const r of records.values()) {
	if (r.source !== "agent" || r.status !== "candidate" || !r.evidence.includes(`run:${runId}`)) continue;
	ruled++;
	ops.push(verdict === "accept" ? { op: "promote", id: r.id, ts } : { op: "tombstone", id: r.id, ts, reason: `rejected by human verdict on run ${runId}: ${why}` });
}
appendLog(log, ops);
renderAll(HOME);
console.log(`${verdict}ed run ${runId}: ${ruled} candidate finding(s) ${verdict === "accept" ? "promoted" : "tombstoned"}; verdict recorded in summary.json and memory.`);
