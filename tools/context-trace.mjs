// Context trace CLI: prints (or dumps as JSON) the per-agent, per-LLM-call trace
// that lib/context-trace.mjs builds from a run's archived sessions/ + lifecycle.jsonl.
//
//   node tools/context-trace.mjs <runDir | runId> [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun, markersFor } from "../lib/context-trace.mjs";

const LINE_LIMIT = 140;
const MAX_SPAWN_DESC = 60;
// Call-row columns, right-aligned to these widths and joined with exactly one
// space between every column (header and data rows alike), then one more space
// before the tools/markers cell. i and t+s are widened past the brief's sample
// (4/6) to 4/8 so large run-relative offsets (e.g. "1025.7") can't abut the
// call-index column — see task-2-report.md fix round 1.
const COLUMNS = [
	{ label: "i", width: 4 },
	{ label: "t+s", width: 8 },
	{ label: "ctx", width: 7 },
	{ label: "cached", width: 10 },
	{ label: "fresh", width: 8 },
	{ label: "hit", width: 5 },
	{ label: "ret", width: 6 },
	{ label: "out", width: 7 },
];
const PREFIX_LEN = COLUMNS.reduce((n, c) => n + c.width + 1, 0); // +1 per column for its trailing separator space
const ROW_HEADER = `${COLUMNS.map((c) => c.label.padStart(c.width)).join(" ")} tools / markers`;

function markerStr(m) {
	return `[${m.kind} ${m.detail}]`;
}

// `extraMarkers` carries the orphan markers (spawn/return/resume on a worker's own
// lane, which attach only to the PARENT's call — see markersFor) onto the agent's last
// call row, mirroring the console panel's orphan-marker tooltip rule. They are listed
// before the call's own markers: they anchor the lane (when it was spawned, when it
// returned) and would otherwise be the first thing the row-width truncation below
// drops, since they usually carry the latest tMs of the row.
function toolsAndMarkersCell(call, extraMarkers) {
	const allMarkers = extraMarkers && extraMarkers.length ? [...extraMarkers, ...call.markers] : call.markers;
	const parts = [call.tools.join(",")];
	if (allMarkers.length) parts.push(allMarkers.map(markerStr).join(" "));
	let cell = parts.filter(Boolean).join(" ");
	const maxLen = LINE_LIMIT - PREFIX_LEN;
	if (cell.length > maxLen) cell = `${cell.slice(0, Math.max(0, maxLen - 1))}…`;
	return cell;
}

function formatRow(call, t0, extraMarkers) {
	const tPlus = ((call.startMs - t0) / 1000).toFixed(1);
	const ret = call.retained === null ? "—" : call.retained.toFixed(2);
	const cell = toolsAndMarkersCell(call, extraMarkers);
	const values = [String(call.i), tPlus, String(call.context), String(call.cached), String(call.fresh), call.hitRatio.toFixed(2), ret, String(call.output)];
	const fields = values.map((v, idx) => v.padStart(COLUMNS[idx].width));
	return `${fields.join(" ")} ${cell}`;
}

// The schema allows a null spawn.description (e.g. a resumed worker whose creation
// event carried none) — guard rather than throw on agentHeaderParenthetical.
function truncateDesc(desc, max = MAX_SPAWN_DESC) {
	desc = desc ?? "";
	return desc.length > max ? `${desc.slice(0, max - 1)}…` : desc;
}

// Run-level markers naming this agent that are attached to none of its own calls
// (a worker's spawn/return/resume, which attach to the PARENT's call instead).
// Mirrors tools/console.template.html's orphanMarkers.
function orphanMarkersFor(agent, trace) {
	const key = (m) => `${m.tMs}|${m.kind}|${m.ev}`;
	const attached = new Set();
	for (const c of agent.calls) for (const m of c.markers) attached.add(key(m));
	return markersFor(trace, agent.id).filter((m) => !attached.has(key(m)));
}

function agentHeaderParenthetical(agent, t0) {
	if (agent.parent === null) return "";
	if (agent.spawn === null) return ` (parent ${agent.parent})`;
	const spawnedS = ((agent.spawn.createdMs - t0) / 1000).toFixed(1);
	const mode = agent.spawn.background ? "background" : "foreground";
	return ` (parent ${agent.parent}, spawned ${spawnedS}s "${truncateDesc(agent.spawn.description)}", ${mode})`;
}

function agentHeaderLine(agent, t0) {
	const t = agent.totals;
	const inferenceS = (t.inferenceMs / 1000).toFixed(1);
	const toolsS = (t.toolMs / 1000).toFixed(1);
	return `## ${agent.id}${agentHeaderParenthetical(agent, t0)}: ${t.calls} calls, hit ${t.hitRatio.toFixed(3)}, fresh ${t.fresh}, cached ${t.cached}, peak ${t.peakContext}, inference ${inferenceS}s, tools ${toolsS}s`;
}

function printText(doc) {
	console.log(`# context trace — ${doc.run}`);
	for (const agent of doc.agents) {
		console.log(`\n${agentHeaderLine(agent, doc.t0)}`);
		console.log(ROW_HEADER);
		const orphans = orphanMarkersFor(agent, doc);
		agent.calls.forEach((call, idx) => {
			const extra = idx === agent.calls.length - 1 ? orphans : null;
			console.log(formatRow(call, doc.t0, extra));
		});
	}
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const arg = process.argv[2];
if (!arg) {
	console.error("usage: node tools/context-trace.mjs <runDir | runId> [--json]");
	process.exit(1);
}
const runDir = fs.existsSync(arg) ? path.resolve(arg) : path.join(ROOT, "runs", arg);
const asJson = process.argv.includes("--json");

const trace = traceRun(runDir);

if (asJson) {
	console.log(JSON.stringify(trace, null, 2));
} else {
	printText(trace);
}
