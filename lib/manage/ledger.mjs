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

/**
 * The row that used this idempotency key, or null.
 *
 * `executedOnly` (the default) matches only rows that actually ran (`verified === true`). A
 * refusal is a ledger row too, and matching those as well made a refused key unusable: the
 * manager corrects the instruction the harness just rejected, retries it under the same key —
 * which is what §3's key is, a name for one answer to one packet — and the correction is
 * refused as a duplicate of its own rejection, with the operator told "already executed" about
 * something that never executed. Only an execution can be duplicated.
 *
 * Pass `{ executedOnly: false }` to ask the other question: has this key been SEEN at all,
 * refused or not, which is what an audit of a packet's history wants.
 */
export function findByKey(dir, idempotencyKey, { executedOnly = true } = {}) {
	const rows = readLedger(dir);
	// A row that a later `reversed` row names did not happen. The row goes down BEFORE the act,
	// so an act that was recorded and then could not be carried out — the executor's
	// compare-and-swap losing to another writer — is retracted by a row, never by an edit; the
	// ledger stays append-only. A retracted row must stop counting as an execution, or the
	// honest retry under the same key is refused as a duplicate of something that never ran.
	const reversed = new Set(rows.filter((r) => r.kind === "reversed" && Number.isFinite(r.forSeq)).map((r) => r.forSeq));
	return rows.find((r) => r.instruction?.idempotencyKey === idempotencyKey && !reversed.has(r.seq) && (!executedOnly || r.verified === true)) ?? null;
}

/** Retracts an earlier row: it was written before the act, and the act did not happen. */
export function reverseRow(dir, seq, reason) {
	return appendLedger(dir, { kind: "reversed", forSeq: seq, reason });
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
