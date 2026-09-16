// Context trace CLI: prints (or dumps as JSON) the per-agent, per-LLM-call trace
// that lib/context-trace.mjs builds from a run's archived sessions/ + lifecycle.jsonl.
//
//   node tools/context-trace.mjs <runDir | runId> [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun } from "../lib/context-trace.mjs";

const LINE_LIMIT = 140;
// Column widths, right after each other with no separator (matching the sample
// layout in .superpowers/sdd/2026-09-15-context-trace/task-2-brief.md):
//   i(4) t+s(6) ctx(7) cached(10) fresh(8) hit(5) ret(6) out(7) "    " tools/markers
const ROW_HEADER = "   i   t+s    ctx     cached   fresh  hit   ret   out    tools / markers";

function markerStr(m) {
	return `[${m.kind} ${m.detail}]`;
}

function toolsAndMarkersCell(call) {
	const parts = [call.tools.join(",")];
	if (call.markers.length) parts.push(call.markers.map(markerStr).join(" "));
	let cell = parts.filter(Boolean).join(" ");
	const maxLen = LINE_LIMIT - 57; // 57 = width of the columns before this cell
	if (cell.length > maxLen) cell = `${cell.slice(0, Math.max(0, maxLen - 1))}…`;
	return cell;
}

function formatRow(call, t0) {
	const tPlus = ((call.startMs - t0) / 1000).toFixed(1);
	const ret = call.retained === null ? "—" : call.retained.toFixed(2);
	const cell = toolsAndMarkersCell(call);
	return (
		String(call.i).padStart(4) +
		tPlus.padStart(6) +
		String(call.context).padStart(7) +
		String(call.cached).padStart(10) +
		String(call.fresh).padStart(8) +
		call.hitRatio.toFixed(2).padStart(5) +
		ret.padStart(6) +
		String(call.output).padStart(7) +
		"    " +
		cell
	);
}

function agentHeaderParenthetical(agent, t0) {
	if (agent.parent === null) return "";
	if (agent.spawn === null) return ` (parent ${agent.parent})`;
	const spawnedS = ((agent.spawn.createdMs - t0) / 1000).toFixed(1);
	const mode = agent.spawn.background ? "background" : "foreground";
	return ` (parent ${agent.parent}, spawned ${spawnedS}s "${agent.spawn.description}", ${mode})`;
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
		for (const call of agent.calls) console.log(formatRow(call, doc.t0));
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
