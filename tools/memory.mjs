// Memory CLI — the human side of the promotion gate, plus retention from past runs.
//
//   node tools/memory.mjs list [scope]            records with status, newest first
//   node tools/memory.mjs promote <id>            a human promotes a candidate
//   node tools/memory.mjs tombstone <id> [why]    forget, with a reason (never deletes)
//   node tools/memory.mjs retain <runDir>...      derive records from finished runs
//   node tools/memory.mjs render                  recompile memory/wiki/ from the log and run summaries
//   node tools/memory.mjs recall <scope>... [--budget N]   show what an agent running under these scopes is given
//   node tools/memory.mjs lint                    what a person should rule on (also written to memory/wiki/LINT.md)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldLog, readLog, appendLog, recall, retainFromRun, consolidate, memoryPaths, renderAll as renderAllIn, loadRunSummaries } from "../lib/memory.mjs";
import { lint, renderLint } from "../lib/wiki.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, "..");
const LOG_FILE = memoryPaths(HOME).log;
const renderAll = () => renderAllIn(HOME);
const readJsonl = readLog;

const [, , cmd, ...args] = process.argv;
{
	const records = foldLog(readLog(LOG_FILE));
	switch (cmd) {
		case "list": {
			const scope = args[0];
			for (const r of [...records.values()].filter((r) => !scope || r.scope === scope).sort((a, b) => b.ts - a.ts)) {
				console.log(`${r.id}  ${r.status.padEnd(10)} ${r.scope.padEnd(14)} ${r.kind.padEnd(10)} conf ${r.confidence}  ${r.source.padEnd(10)} ${r.text.slice(0, 110)}`);
			}
			break;
		}
		case "promote":
		case "tombstone": {
			const id = args[0];
			if (!records.has(id)) throw new Error(`no record ${id}`);
			appendLog(LOG_FILE, [{ op: cmd, id, ts: Date.now(), ...(cmd === "tombstone" ? { reason: args.slice(1).join(" ") } : {}) }]);
			renderAll();
			console.log(`${cmd}d ${id}`);
			break;
		}
		case "retain": {
			const seen = new Set([...records.values()].flatMap((r) => r.evidence.filter((e) => e.startsWith("run:"))));
			const out = [];
			for (const dir of args) {
				const summaryPath = path.join(dir, "summary.json");
				if (!fs.existsSync(summaryPath)) {
					console.error(`skip ${dir}: no summary.json`);
					continue;
				}
				const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
				if (seen.has(`run:${summary.runId}`)) {
					console.error(`skip ${dir}: already retained`);
					continue;
				}
				// The timeline is not persisted as JSON; rebuild the two kinds retain reads
				// (oracle verdicts and spawns) from audit.jsonl and transcript.md.
				const audit = readJsonl(path.join(dir, "audit.jsonl"));
				const timeline = [];
				for (const a of audit) if (a.type === "oracle") timeline.push({ from: "supervisor", to: "both", kind: "oracle", body: a.msg });
				const md = fs.existsSync(path.join(dir, "transcript.md")) ? fs.readFileSync(path.join(dir, "transcript.md"), "utf8") : "";
				for (const m of md.matchAll(/^### \[\d+s\] orchestrator → (worker:[^\s]+) \(spawn\)\n\n([\s\S]*?)(?=\n### \[|\n*$)/gm)) timeline.push({ from: "orchestrator", to: m[1], kind: "spawn", body: m[2] });
				out.push(...retainFromRun({ summary, timeline, ts: Date.now() }));
			}
			if (out.length) appendLog(LOG_FILE, out);
			renderAll();
			console.log(`retained ${out.length} record(s)`);
			break;
		}
		case "render":
			console.log(`compiled ${renderAll().size} page(s) into memory/wiki/`);
			break;
		case "lint": {
			const findings = lint({ records, runSummaries: loadRunSummaries(HOME) });
			renderAll();
			console.log(renderLint(findings));
			break;
		}
		case "consolidate": {
			const ops = consolidate(records);
			if (ops.length) appendLog(LOG_FILE, ops);
			renderAll();
			for (const op of ops) console.log(`${op.op} ${op.id}${op.reason ? ` (${op.reason})` : ""}${op.confidence != null ? ` conf ${op.confidence}, evidence ${op.evidence.length}` : ""}`);
			console.log(`consolidated: ${ops.filter((o) => o.op === "tombstone").length} merged`);
			break;
		}
		case "recall": {
			const bi = args.indexOf("--budget");
			const budgetChars = bi >= 0 ? Number(args[bi + 1]) : 2000;
			const scopes = args.filter((a, i) => a !== "--budget" && i !== bi + 1);
			const { text, ids } = recall({ pages: renderAll(), scopes: ["global", ...scopes], budgetChars });
			console.log(text || "(nothing promoted in scope)");
			console.error(`ids: ${ids.join(", ")}`);
			break;
		}
		default:
			console.error("usage: node tools/memory.mjs list|promote|tombstone|retain|render|recall|lint|consolidate …");
			process.exit(cmd ? 1 : 0);
	}
}
