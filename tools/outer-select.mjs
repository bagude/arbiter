// outer-select — step 4 of the outer loop (docs/batch/outer-loop-1.md), as code: which recorded
// decision points of a run are worth a value-of-information fork.
//
//   node tools/outer-select.mjs <runId> [--runs <dir>] [--min-p 0.95] [--max 2] [--json]
//
// A point is a candidate when (1) the recorded action is a gather (inspect/memory/checkpoint)
// and the next substantive action S follows within `gatherSteps` ≤ 2; (2) both heads say S:
// the 27B substantive head at p ≥ min-p (decisions-replay-substantive.jsonl) and Jev picking S
// (decisions-jev.jsonl, when present — absent Jev rows do not veto); (3) no guard requires the
// gather: a read/grep of src/__tests__ that precedes an implementer spawn or a tester resume is
// excluded (topology nudge tests:unread); (4) the gather is cheap to skip: ls, a re-read of a
// path already read earlier in the run, a checkpoint, a memory note (send_mail kind=memory).
// A first read of any path, a memory_get/search, and the spec/README reads are not candidates.
// Ranked by the 27B's p, then by how late in the run (later points are cheaper to fork).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

export function selectCandidates(points, headRows, jevRows, { minP = 0.95 } = {}) {
	const head = new Map(headRows.map((h) => [h.i, h.head]));
	const jev = new Map(jevRows.map((j) => [j.i, j.score?.substantive ?? null]));
	const seenPaths = new Set();
	const out = [];
	for (const p of points) {
		const cls = p.action?.cls, tool = p.action?.tool, prm = p.action?.params ?? {};
		const S = p.substantive?.cls;
		const gs = p.substantive?.gatherSteps;
		const isGather = ["inspect", "memory", "checkpoint"].includes(cls);
		const rereadOf = tool === "read" && prm.path ? seenPaths.has(prm.path) : false;
		if (tool === "read" && prm.path) seenPaths.add(prm.path);
		if (!isGather || !S || !(gs >= 1 && gs <= 2)) continue;
		const h = head.get(p.i);
		if (!h || h.pickClass !== S || (h.confidence ?? 0) < minP) continue;
		const j = jev.get(p.i);
		if (j && j.pick !== S) continue;
		// (3) guard-required: a tests read/grep before a worker spawn/resume of the implementer
		const testsRead = ["read", "grep"].includes(tool) && /__tests__/.test(prm.path ?? "");
		if (testsRead && (S === "spawn" || S === "resume")) continue;
		// (4) cheap to skip
		const cheap = tool === "ls" || rereadOf || cls === "checkpoint" || (tool === "send_mail" && prm.kind === "memory");
		if (!cheap) continue;
		out.push({ call: p.i + 1, i: p.i, recorded: `${cls}:${tool ?? ""}${prm.path ? ":" + prm.path : ""}`, next: S, gatherSteps: gs, p27b: h.confidence, jev: j ? `${j.pick} ${j.pPick?.toFixed(2)}` : "—", action: S });
	}
	return out.sort((a, b) => b.p27b - a.p27b || b.i - a.i);
}

function main() {
	const argv = process.argv.slice(2);
	const spec = { run: null, runsDir: path.join(ROOT, "runs"), minP: 0.95, max: 2, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--runs") spec.runsDir = path.resolve(argv[++i]);
		else if (a === "--min-p") spec.minP = Number(argv[++i]);
		else if (a === "--max") spec.max = Number(argv[++i]);
		else if (a === "--json") spec.json = true;
		else spec.run = a;
	}
	if (!spec.run) { console.error("usage: node tools/outer-select.mjs <runId> [--runs dir] [--min-p 0.95] [--max 2] [--json]"); process.exit(2); }
	const dir = path.join(spec.runsDir, spec.run);
	const points = readJsonl(path.join(dir, "decisions.jsonl"));
	const heads = readJsonl(path.join(dir, "decisions-replay-substantive.jsonl"));
	const jevs = readJsonl(path.join(dir, "decisions-jev.jsonl"));
	if (!points.length || !heads.length) { console.error(`${spec.run}: needs decisions.jsonl and decisions-replay-substantive.jsonl`); process.exit(2); }
	const cands = selectCandidates(points, heads, jevs, { minP: spec.minP }).slice(0, spec.max);
	if (spec.json) { console.log(JSON.stringify(cands)); return; }
	console.log(`${spec.run}: ${cands.length} candidate(s) of ${points.length} points`);
	for (const c of cands) console.log(`  call ${String(c.call).padStart(2)}  ${c.recorded.padEnd(40)} → ${c.next.padEnd(7)} gs=${c.gatherSteps}  27B ${c.p27b.toFixed(2)}  jev ${c.jev}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
