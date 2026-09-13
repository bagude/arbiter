// Fixture store for verifying the synthesis oracle: a handful of records the
// reference report can cite, in the research scope. Rebuild with
//   node tasks/dw-paper-synthesis/fixture/make.mjs
// The live campaign points memory at the real ledger instead (no memoryDir).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecord, appendLog } from "../../../lib/memory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(here, "..", "store");
const LOG = path.join(STORE, "memory", "records.jsonl");
const SCOPE = "task:dw-paper-synthesis"; // verify-task resolves global + task scopes; the live run adds the research scope by config
const SNAP = "seed:dw-paper-synthesis@fixture";
fs.rmSync(STORE, { recursive: true, force: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const R = (id, over) => makeRecord({ id, scope: SCOPE, kind: "semantic", source: "supervisor", confidence: 0.9, evidence: ["run:fixture", "oracle:fixture#1"], ts: 1_789_300_000_000, ...over });
appendLog(LOG, [
	R("m_f1f0000000aa", { claim: "observed", snapshot: SNAP, summary: "The paper positions Arps as the 80-year standard for EUR", text: "The paper positions the Arps hyperbolic and exponential relations as the industry standard for EUR estimation for more than 80 years.", verification: { query_sha: "quote", snapshot: SNAP, reproduced: true, by: "oracle:fixture#1" } }),
	R("m_f1f0000000bb", { claim: "observed", snapshot: SNAP, summary: "Exponential fit of NM well: Di 0.03 per month", text: "An exponential least-squares fit over the first 48 months gives Di_per_month = 0.03.", verification: { query_sha: "q", snapshot: SNAP, reproduced: true, by: "oracle:fixture#1" } }),
	R("m_f1f0000000cc", { claim: "interpreted", settlement_criterion: "fit both branches on one well", snapshot: SNAP, summary: "The modified hyperbolic is hyperbolic then exponential", text: "Appendix A's modified hyperbolic model is a hyperbolic branch before t_exp and an exponential branch after it." }),
	R("m_f1f0000000dd", { claim: "hypothesis", settlement_criterion: "compare PLE and exponential residuals", snapshot: SNAP, summary: "PLE will fit early months better than exponential", text: "The power-law exponential model will fit the first 12 months better than the exponential branch on most NM wells." }),
]);
console.log(`store built at ${path.relative(process.cwd(), STORE)}`);
