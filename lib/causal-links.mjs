// Causal links between calls of a traced run (lib/context-trace.mjs traceRun output):
// which orchestrator call issued a spawn or resume, which worker call's result landed
// in which orchestrator call, where a send_mail's reply arrived, and which call was the
// retry after a guard denial. Shared by the lanes page and tools/decision-points.mjs.
//
// Marker semantics (context-trace): a marker is attached to the call that FOLLOWS the
// event — the event happened during the previous call's tool time and shaped this
// call's input. So a spawn/resume marker on call ci was issued by call ci-1's `subagent`
// tool call, a return marker on call ci means the worker's result is in call ci's
// input, and a guard denial on call ci was the denial of call ci-1's tool call.
//
// Link kinds (forward):  spawned, resumed, received, replied, retry
//            (back):     spawnedby, resumedby, delivered
// Each link: { a: agentIndex, i: callIndex, k: kind, d: label }.

const REPLY_TIMING_SLACK_S = 0.5;
const RETURN_MATCH_SLACK_MS = 1500;

/**
 * @param trace  traceRun() output
 * @param opts.audit  parsed audit.jsonl entries ({ t, type, msg, ... }); needed for reply labels
 * @param opts.mailKind  (agentIndex, callIndex) => "probe" | "done" | ... | null; needed to pick the right reply event
 * @returns links[agentIndex][callIndex] = Link[]  (sparse: missing entries mean no links)
 */
export function causalLinks(trace, { audit = [], mailKind = () => null } = {}) {
	const t0 = trace.t0;
	const idxByTraceId = new Map(trace.agents.map((a, i) => [a.id, i]));
	const links = trace.agents.map((a) => a.calls.map(() => []));
	const push = (ai, ci, link) => { if (links[ai]?.[ci]) links[ai][ci].push(link); };
	const secs = (ms) => (ms - t0) / 1000;

	trace.agents.forEach((ta, ai) => {
		ta.calls.forEach((tc, ci) => {
			const issuer = ci - 1;
			for (const m of tc.markers) {
				const wi = idxByTraceId.get(m.agent);
				if (wi == null || wi === ai) continue;
				const w = trace.agents[wi];
				if (m.kind === "spawn" && issuer >= 0) {
					push(ai, issuer, { a: wi, i: 0, k: "spawned", d: m.detail });
					push(wi, 0, { a: ai, i: issuer, k: "spawnedby", d: m.detail });
				} else if (m.kind === "resume" && issuer >= 0) {
					const k = w.calls.findIndex((c) => c.startMs >= m.tMs - RETURN_MATCH_SLACK_MS);
					if (k >= 0) {
						push(ai, issuer, { a: wi, i: k, k: "resumed", d: m.detail });
						push(wi, k, { a: ai, i: issuer, k: "resumedby", d: m.detail });
					}
				} else if (m.kind === "return") {
					let k = -1;
					w.calls.forEach((c, j) => { if (c.endMs <= m.tMs + RETURN_MATCH_SLACK_MS) k = j; });
					if (k < 0) continue;
					push(wi, k, { a: ai, i: ci, k: "delivered", d: m.detail });
					push(ai, ci, { a: wi, i: k, k: "received", d: m.detail });
				}
			}
			const denials = tc.markers.filter((m) => m.kind === "guard" && /_denied$/.test(m.ev));
			if (denials.length && issuer >= 0) push(ai, issuer, { a: ai, i: ci, k: "retry", d: denials.map((m) => m.detail).join("; ") });

			// A send_mail's reply is the first matching delivery (or oracle verdict) after the
			// call, landing in the first call that starts after that event: probes and oracles
			// take seconds and the orchestrator often gets another inference in first.
			if (tc.tools.includes("send_mail") && ci + 1 < ta.calls.length) {
				const sentAt = secs(tc.endMs) - REPLY_TIMING_SLACK_S;
				const kind = mailKind(ai, ci) ?? "";
				const wants = kind === "done" ? (e) => e.type === "oracle"
					: kind === "probe" ? (e) => e.type === "deliver" && /probe/.test(String(e.msg))
					: (e) => e.type === "deliver" && !/kickoff/.test(String(e.msg));
				const any = (e) => (e.type === "deliver" || e.type === "oracle") && !/kickoff/.test(String(e.msg));
				const ev = audit.find((e) => Number(e.t) >= sentAt && wants(e)) ?? audit.find((e) => Number(e.t) >= sentAt && any(e));
				let target = ci + 1;
				if (ev) {
					const j = ta.calls.findIndex((c, idx) => idx > ci && secs(c.startMs) >= Number(ev.t) - REPLY_TIMING_SLACK_S);
					target = j > ci ? j : ta.calls.length - 1;
				}
				const label = ev ? (ev.type === "oracle" ? ev.msg : String(ev.msg).replace(/^<- /, "")) : "supervisor reply";
				push(ai, ci, { a: ai, i: target, k: "replied", d: label });
			}
		});
	});
	return links;
}

/** Parse audit.jsonl for causalLinks; tolerant of a missing file. */
export function readAudit(file, fs) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
