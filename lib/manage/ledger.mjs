// ledger — append-only management record (spec §5): one row per trigger/instruction/outcome,
// plus findings (claims with settlement criteria) written from compares and read back into
// packets. Idempotency keys are looked up here BEFORE anything executes.
import fs from "node:fs";
import path from "node:path";

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

export function readLedger(dir) { return readJsonl(path.join(dir, "ledger.jsonl")); }

export function appendLedger(dir, row) {
	const rows = readLedger(dir);
	const out = { seq: rows.length + 1, ts: Date.now(), ...row };
	fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify(out) + "\n");
	return out;
}

export function findByKey(dir, idempotencyKey) {
	return readLedger(dir).find((r) => r.instruction?.idempotencyKey === idempotencyKey) ?? null;
}

/** Update the outcome of the row that executed `idempotencyKey` (appends an outcome row; the ledger stays append-only). */
export function recordOutcome(dir, idempotencyKey, outcome) {
	return appendLedger(dir, { kind: "outcome", forKey: idempotencyKey, outcome });
}

export function readFindings(dir) {
	// last row per id wins (settlements are appended, not rewritten)
	const byId = new Map();
	for (const f of readJsonl(path.join(dir, "findings.jsonl"))) byId.set(f.id, { ...(byId.get(f.id) ?? {}), ...f });
	return [...byId.values()];
}

export function appendFinding(dir, finding) {
	if (!finding.id || !finding.claim || !finding.settlement_criterion) throw new Error("a finding needs id, claim and settlement_criterion");
	const out = { status: "candidate", verifiedOn: [], evidence: [], ts: Date.now(), ...finding };
	fs.appendFileSync(path.join(dir, "findings.jsonl"), JSON.stringify(out) + "\n");
	return out;
}

export function settleFinding(dir, id, { status, verifiedOn = [] }) {
	if (!["candidate", "verified", "refuted"].includes(status)) throw new Error(`bad finding status ${status}`);
	fs.appendFileSync(path.join(dir, "findings.jsonl"), JSON.stringify({ id, status, verifiedOn, settledAt: Date.now() }) + "\n");
}
