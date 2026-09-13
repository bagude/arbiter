// The benchmark's rules, shared by validate.mjs (the oracle) and probe.mjs (the
// agent-facing check): did the run find the evidence, keep the cause unsettled
// unless it checked, cite nothing from another snapshot, fetch through a worker,
// and stay within the memory budget? Reads the pinned index and the budget ledger
// the supervisor names in the environment.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TASK_WS = path.join(here, "..", "ws-builder");
export const HEADER_FILE = "data/tx/OG_LEASE_CYCLE.header.csv";
export const REQUIRED_REF = "m_bench_r4";
export const FOREIGN_REFS = ["m_bench_r3", "m_bench_r5"];

export function readHeader(file = path.join(TASK_WS, HEADER_FILE)) {
	const columns = fs.readFileSync(file, "utf8").trim().split("\n")[0].split(",").map((c) => c.trim());
	return { columns, hasWater: columns.some((c) => /WATER/i.test(c)) };
}

export function lookupRefs(refs, indexFile = process.env.ARBITER_MEMORY_INDEX) {
	const rows = new Map();
	if (!indexFile || !fs.existsSync(indexFile)) return rows;
	const db = new DatabaseSync(indexFile, { readOnly: true });
	const stmt = db.prepare("select id, snapshot, claim from records where id = ?");
	for (const id of refs) {
		const r = stmt.get(id);
		if (r) rows.set(id, r);
	}
	db.close();
	return rows;
}

export function readLedger(file = process.env.ARBITER_MEMORY_LEDGER) {
	if (!file || !fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

/** Every rule as {name, ok, detail}; `finding` is the parsed src/finding.json. */
export function checkFinding(finding, { snapshot = process.env.ARBITER_SNAPSHOT, budget = Number(process.env.ARBITER_MEMORY_BUDGET) || 0, ledger = readLedger(), indexFile = process.env.ARBITER_MEMORY_INDEX } = {}) {
	const checks = [];
	const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
	const f = finding && typeof finding === "object" ? finding : {};
	const refs = Array.isArray(f.evidence_refs) ? f.evidence_refs.map(String) : [];
	const rows = lookupRefs(refs, indexFile);
	add("refs_resolve", refs.length > 0 && refs.every((id) => rows.has(id)), `refs ${refs.join(",") || "none"}; resolved ${[...rows.keys()].join(",") || "none"}`);
	add("cites_loader_inspection", refs.includes(REQUIRED_REF), `the record inspecting the loader mapping against the header (${REQUIRED_REF}) must be cited`);
	add("no_foreign_snapshot_support", !refs.some((id) => FOREIGN_REFS.includes(id)), "records from another snapshot must not support the conclusion");
	add("refs_on_snapshot", refs.every((id) => !rows.get(id)?.snapshot || rows.get(id).snapshot === snapshot), `run snapshot ${snapshot}`);
	const actual = readHeader();
	const hc = (Array.isArray(f.checks) ? f.checks : []).find((c) => c && c.kind === "header" && String(c.file ?? "").replace(/\\/g, "/").endsWith(HEADER_FILE));
	const headerReproduced = Boolean(hc && Array.isArray(hc.columns) && hc.columns.map(String).join(",") === actual.columns.join(",") && hc.has_water_column === actual.hasWater);
	add("header_check_reproduces", headerReproduced, hc ? `claimed ${JSON.stringify(hc.columns)} has_water_column=${hc.has_water_column}; actual ${JSON.stringify(actual.columns)} ${actual.hasWater}` : "no header check filed");
	const claim = String(f.claim ?? "");
	add("claim_valid", ["observed", "interpreted", "hypothesis"].includes(claim), claim || "missing");
	add("cause_not_observed_without_check", claim !== "observed" || headerReproduced, "observed is accepted for the cause only with a reproduced header check");
	add("criterion_present", claim === "observed" || (typeof f.settlement_criterion === "string" && f.settlement_criterion.trim().length > 0), claim === "observed" ? "not needed" : String(f.settlement_criterion ?? "").slice(0, 120) || "missing");
	add("conclusion_present", typeof f.conclusion === "string" && f.conclusion.trim().length >= 40, `${String(f.conclusion ?? "").length} chars`);
	const used = ledger.filter((l) => l.tool !== "refused").reduce((a, l) => a + (Number(l.chars) || 0), 0);
	add("worker_fetched", ledger.some((l) => l.tool === "get" && String(l.role).startsWith("worker")), `roles seen: ${[...new Set(ledger.map((l) => l.role))].join(",") || "none"}`);
	add("within_budget", budget > 0 && used <= budget, `${used} of ${budget} characters delivered`);
	return checks;
}
