// The apply rules beyond the explorer's: a model from the paper, paper references,
// and a compute snippet that re-runs on the observation's rows and prints expect.
import { runSnippet, valuesMatch, checkSnippet } from "../../../lib/research/snippets.mjs";

export const MODELS = ["MH", "PLE", "SE", "DNG", "LGM"];
const REF_RE = /^(p\d{1,2}|C\d{1,2})$/;

export function checkCompute(o) {
	const c = o?.compute;
	if (!c || typeof c !== "object" || typeof c.code !== "string") return { ok: false, reason: "compute needs code" };
	if (!("expect" in c)) return { ok: false, reason: "compute needs expect" };
	const s = checkSnippet(c.code);
	if (!s.ok) return { ok: false, reason: s.reason };
	const rows = Array.isArray(o.result) ? o.result : [];
	const r = runSnippet(c.code, { rows });
	if (!r.ok) return { ok: false, reason: `compute failed: ${r.error}` };
	const m = valuesMatch(r.stdout, c.expect);
	return m.ok ? { ok: true, printed: m.got } : { ok: false, reason: m.reason, printed: m.got };
}

/** Problems with the apply-specific fields of one observation. */
export function checkApply(o) {
	const bad = [];
	if (!MODELS.includes(o?.model)) bad.push(`model must be one of ${MODELS.join(", ")}`);
	const refs = Array.isArray(o?.paper_refs) ? o.paper_refs : [];
	if (!refs.length || !refs.every((r) => typeof r === "string" && REF_RE.test(r))) bad.push("paper_refs must be a non-empty list of page ids (p59) or study claim ids (C4)");
	const r = checkCompute(o);
	if (!r.ok) bad.push(`compute: ${r.reason}`);
	else {
		const nums = new Set();
		const walk = (v) => {
			if (typeof v === "number") {
				nums.add(String(v));
				nums.add(v.toFixed(2));
				nums.add(v.toFixed(1));
				nums.add(String(Math.round(v)));
			} else if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === "object") Object.values(v).forEach(walk);
		};
		walk(o.compute.expect);
		walk(o.result);
		const mentioned = String(o.observation ?? "").match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
		if (!mentioned.some((m) => nums.has(m.replace(/,/g, "")))) bad.push("observation text mentions no number from compute.expect or result");
	}
	return bad;
}
