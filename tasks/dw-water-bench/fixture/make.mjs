// Builds the benchmark's memory store: today's real ledger plus 300 unrelated
// records and the controlled TX-water set. Asserts the startup seed does not hand
// the agent the necessary record (R4), so success needs a search and a fetch.
//
//   node tasks/dw-water-bench/fixture/make.mjs
//
// Rebuild before each measurement batch: retention at the end of a run appends to
// this store (never to the real ledger; configs/orch-dw-water-bench-27b.json points
// memoryDir here).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecord, appendLog } from "../../../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../../../lib/memory-index.mjs";
import { seededBrief } from "../../../lib/memory-brief.mjs";
import { snapshotId } from "../../../lib/snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const STORE = path.join(here, "..", "store");
const LOG = path.join(STORE, "memory", "records.jsonl");
const SCOPE = "repo:data-warehousers-bench";
// The supervisor computes the same id for this task (lib/snapshot.mjs over ws-builder/data).
const SNAP = snapshotId({ name: "seed:dw-water-bench", dir: path.join(here, "..", "ws-builder", "data") });
const OLD = "data-warehousers@000000000000";

fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.copyFileSync(path.join(ROOT, "memory", "records.jsonl"), LOG);

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const topics = ["NM gas concentrates in", "OK master snapshot rows in", "decline curve initial rate for", "operator spelling variants in", "lease grain duplicates in", "county reconciliation for", "IP test volumes in", "shut-in months for", "TX water reporting for", "TX water_bbl coverage in"];
const places = ["Eddy county", "Lea county", "District 08", "Kingfisher", "Permian leases", "the 2019 vintage", "multi-API leases", "single-well leases", "the 2026-02 pull"];
const filler = [];
for (let i = 0; i < 300; i++) {
	const t = `${topics[Math.floor(rnd() * topics.length)]} ${places[Math.floor(rnd() * places.length)]} is ${Math.floor(rnd() * 90)}% of the total.`;
	filler.push(makeRecord({ scope: i % 3 ? SCOPE : "repo:data-warehousers-real", kind: "semantic", claim: "observed", text: t, snapshot: i % 2 ? SNAP : OLD, evidence: ["run:bench-filler", "oracle:bench-filler#1"], confidence: 0.9, source: "supervisor", ts: 1_700_000_000_000 + i }));
}
const R = (id, over) => makeRecord({ id, scope: SCOPE, kind: "semantic", source: "supervisor", confidence: 0.9, evidence: ["run:2026-09-12T21-53-54", "oracle:2026-09-12T21-53-54#1"], ts: 1_789_250_000_000, ...over });
const controlled = [
	// R1: the observed, verified NULL result on this snapshot.
	R("m_bench_r1", { claim: "observed", snapshot: SNAP, summary: "TX water_bbl is 100% NULL across all 73.3M production_monthly rows", text: "TX water_bbl is 100% NULL across all 73.3M production_monthly rows — select count(*) filter (where water_bbl is null) = count(*) for state = 'TX'.", verification: { query_sha: "9f1c2a7b0d3e4f56", snapshot: SNAP, reproduced: true, by: "oracle:2026-09-12T21-53-54#1" } }),
	// R2: the revealing case — a causal explanation labelled observed, backed only by the NULL query.
	R("m_bench_r2", { claim: "observed", snapshot: SNAP, summary: "TX water_bbl is 100% NULL by source design, not a pipeline drop", text: "TX water_bbl is 100% NULL by source design, not a pipeline drop — the same NULL count query as above.", verification: { query_sha: "9f1c2a7b0d3e4f56", snapshot: SNAP, reproduced: true, by: "oracle:2026-09-12T22-08-57#1" } }),
	// R3: a historical record on an incompatible snapshot claiming water was present.
	R("m_bench_r3", { claim: "observed", snapshot: OLD, summary: "TX water_bbl carried values for 41% of lease-months in the 2025 pull", text: "TX water_bbl carried values for 41% of lease-months in the 2025 pull (older warehouse build).", verification: { query_sha: "1111222233334444", snapshot: OLD, reproduced: true, by: "oracle:2026-08-01T10-00-00#1" } }),
	// R4: the necessary evidence — the inspection whose content supports the source explanation. Worded without the seed query's terms.
	R("m_bench_r4", { claim: "interpreted", snapshot: SNAP, settlement_criterion: "the column named in loader_mapping.json for the TX fluid field is absent from the OG_LEASE_CYCLE header", summary: "OG_LEASE_CYCLE header carries oil, gas, condensate and casinghead volume columns only", text: "Inspection of data/tx/OG_LEASE_CYCLE.header.csv: LEASE_OIL_PROD_VOL, LEASE_GAS_PROD_VOL, LEASE_COND_PROD_VOL, LEASE_CSGD_PROD_VOL are the fluid columns; loader_mapping.json names LEASE_WATER_PROD_VOL for the TX fluid field, and the header does not list it, so the mapped field is never populated." }),
	// R5: a loader record on another snapshot that does not support the conclusion.
	R("m_bench_r5", { claim: "interpreted", snapshot: OLD, settlement_criterion: "re-run the mapping check on the current header", summary: "Loader mapping for TX fluid fields matched the header in the 2025 build", text: "In the 2025 build the loader mapping for TX fluid fields matched the OG_LEASE_CYCLE header column for column." }),
];
appendLog(LOG, [...filler, ...controlled]);

const resolved = resolveLedger(LOG);
const index = buildIndex(path.join(STORE, "memory"), resolved);
const brief = seededBrief({ indexFile: index, scopes: ["global", "task:dw-water-bench", SCOPE], snapshot: SNAP, query: "TX water_bbl is NULL: missing at the source, or dropped by the loader?", budgetChars: 2000, revision: resolved.revision });
if (brief.ids.includes("m_bench_r4")) {
	console.error("fixture invalid: the startup seed already contains m_bench_r4; reword R4 or the spec title");
	process.exit(1);
}
console.log(`store built: ${resolved.records.size} records, revision ${resolved.revision}, snapshot ${SNAP}; seed rows: ${brief.ids.join(", ") || "none"}`);
