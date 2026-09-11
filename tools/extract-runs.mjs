import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../lib/jsonl.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNS_DIR = path.join(here, "..", "runs");
const THINK_CAP = 6000;
const SRC_BY_TASK = { duration: "duration.mjs", glob: "glob.mjs", orbit: "orbit.mjs", decline: "decline.mjs", "intercom-review": "findings.json" };

export function discoverRuns(runsDir = RUNS_DIR) {
	return fs
		.readdirSync(runsDir)
		.filter((d) => !d.startsWith(".") && fs.existsSync(path.join(runsDir, d, "summary.json")))
		.sort()
		.map((d) => {
			const summary = JSON.parse(fs.readFileSync(path.join(runsDir, d, "summary.json"), "utf8"));
			const task = summary.task ?? "glob";
			const models = summary.criticModel && !/^none/.test(summary.criticModel) && summary.criticModel !== summary.builderModel
				? `${summary.builderModel} × ${summary.criticModel}`
				: summary.builderModel ?? summary.model;
			const pattern = summary.config?.pattern ?? (summary.solo ? "solo" : "dyad");
			return {
				dir: path.join(runsDir, d),
				id: d,
				label: `${task} · ${pattern} · ${models}`,
				gate: summary.oracleGate ?? "critic approval",
				srcFile: SRC_BY_TASK[task] ?? "src.mjs",
				summary,
			};
		});
}

export function extractRun(run) {
	const dir = run.dir;
	const bus = readJsonl(path.join(dir, "bus.jsonl")).map((m, i) => ({ ...m, n: i + 1 }));
	const audit = readJsonl(path.join(dir, "audit.jsonl"));
	const summary = run.summary;

	// Anchor: map epoch-ms timestamps (bus mail, raw agent-log message timestamps) onto the
	// run-relative "t" seconds the supervisor's own audit log already uses. Found by matching an
	// audit "mail" line ("MAIL #<n> ...") to the corresponding bus.jsonl entry's epoch timestamp.
	const auditMailLines = audit.filter((a) => a.type === "mail");
	let anchorEpoch = null;
	if (auditMailLines.length && bus.length) {
		for (const al of auditMailLines) {
			const match = /MAIL #(\d+)/.exec(al.msg || "");
			if (!match) continue;
			const busMsg = bus.find((b) => b.n === Number(match[1]));
			if (busMsg) {
				anchorEpoch = busMsg.ts - Number(al.t) * 1000;
				break;
			}
		}
	}
	const toRelSec = (epochMs) => (anchorEpoch === null ? 0 : (epochMs - anchorEpoch) / 1000);

	const events = [];

	for (const m of bus) {
		events.push({
			t: toRelSec(m.ts),
			kind: "mail",
			from: m.from,
			to: m.to,
			mailKind: m.kind,
			text: m.body,
			truncated: !!m.truncated,
			n: m.n,
		});
	}

	// audit entries carry a relative "t" (seconds since run start) already computed by the supervisor.
	for (const a of audit) {
		if (a.type === "mail" || a.type === "deliver") continue; // superseded by bus.jsonl (full text) / not interesting
		if (a.type === "tool") {
			events.push({ t: Number(a.t), kind: "tool", agent: a.agent, text: a.msg });
		} else if (a.type === "settled" || a.type === "ready") {
			events.push({ t: Number(a.t), kind: "lifecycle", agent: a.agent ?? null, text: a.msg });
		} else if (a.type === "oracle") {
			events.push({ t: Number(a.t), kind: "oracle", text: a.msg });
		} else if (a.type === "exit" || a.type === "finish") {
			events.push({ t: Number(a.t), kind: "system", text: a.msg });
		} else if (a.type === "stderr" || a.type === "rpc_error" || a.type === "model_error" || a.type === "retry" || a.type === "oracle_crash" || a.type === "guard") {
			events.push({ t: Number(a.t), kind: "warn", agent: a.agent ?? null, text: a.msg });
		} else if (["spawn", "resume", "report", "decide", "worker_failed"].includes(a.type)) {
			events.push({ t: Number(a.t), kind: "delegation", agent: a.agent ?? null, sub: a.type, text: a.msg });
		}
	}

	// Chain-of-thought: pull "thinking" content blocks straight from each agent's raw RPC event
	// log (message_end only — turn_end/agent_end repeat the same message and would double it up).
	// Every raw-*.jsonl in the run dir is one agent — "raw-orchestrator.jsonl" is
	// "orchestrator", "raw-worker_<id>.jsonl" is "worker:<id>" (the underscore stands in for
	// the colon, which is not a legal Windows filename character — see supervisor.mjs).
	const rawFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^raw-.*\.jsonl$/.test(f)) : [];
	for (const f of rawFiles) {
		const agent = f.slice("raw-".length, -".jsonl".length).replace("_", ":");
		const raw = readJsonl(path.join(dir, f));
		for (const ev of raw) {
			if (ev.type !== "message_end") continue;
			const m = ev.message;
			if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
			const thinking = m.content
				.filter((c) => c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim())
				.map((c) => c.thinking.trim())
				.join("\n\n");
			if (!thinking) continue;
			const text = thinking.length > THINK_CAP ? `${thinking.slice(0, THINK_CAP)}…` : thinking;
			events.push({ t: toRelSec(m.timestamp), kind: "thinking", agent, text });
		}
	}

	events.sort((a, b) => a.t - b.t);
	// round timestamps for compactness
	for (const e of events) e.t = Math.round(e.t * 10) / 10;

	// Real final deliverable, verbatim — not a fabricated diff. Whatever BUILDER actually
	// shipped, exactly as it stood when the run ended (or currently stands, if still running).
	const srcPath = path.join(dir, "ws-builder", "src", run.srcFile);
	const source = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, "utf8") : null;

	return {
		id: run.id,
		label: run.label,
		gate: run.gate,
		complete: !!summary,
		summary,
		events,
		sourceFile: run.srcFile,
		source,
		roles: run.summary.config?.roles ?? null,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = {};
	for (const run of discoverRuns()) {
		out[run.id] = extractRun(run);
		console.error(`${run.id}: ${out[run.id].events.length} events, complete=${out[run.id].complete}`);
	}
	fs.writeFileSync(path.join(here, "runs-data.json"), JSON.stringify(out));
	console.error("wrote tools/runs-data.json");
}
