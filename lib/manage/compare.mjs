// compare — turning a finished fork batch into numbers and into candidate findings (spec §5,
// §8). Everything here is PURE: it reads rows (tools/fork.mjs's forkRow output, each tagged
// with the branch `label` the manager chose) and returns tables and finding objects. Nothing
// in this file touches the disk, so the whole read-out of a comparison is testable from a
// synthetic table — which is what makes the numbers in a claim checkable later.
//
// The one judgement encoded here: a comparison always measures an A branch AGAINST the branch
// that forced nothing. A compare of two forced actions with no control has nothing to claim,
// and says so by returning no findings rather than by inventing a baseline.

/** The first oracle attempt of a replicate, from forkRow's joined "68/70, 70/70" string. */
export function firstOracle(oracle) {
	const first = String(oracle ?? "").split(",")[0]?.trim();
	const m = /^(\d+)\/(\d+)$/.exec(first ?? "");
	return m ? { pass: Number(m[1]), total: Number(m[2]) } : null;
}

/** Did this replicate pass the oracle on its FIRST attempt? A crashed replicate never did. */
export function passedFirstTry(row) {
	if (row.crashed) return false;
	const o = firstOracle(row.oracle);
	return Boolean(o && o.total > 0 && o.pass === o.total);
}

/**
 * One branch's read-out. `n` counts every replicate that was run, crashed included: a branch
 * whose replicates crash is a branch that did not deliver, and hiding those from the
 * denominator would let "3/3 first try" describe a branch that produced one usable run.
 * `meanWall` is over the replicates that reported a wall clock at all (a crash reports none),
 * and is null when none did.
 */
export function branchStats(rows) {
	const n = rows.length;
	const walls = rows.map((r) => r.wallSec).filter((w) => typeof w === "number");
	return {
		n,
		firstTry: rows.filter(passedFirstTry).length,
		crashed: rows.filter((r) => r.crashed).length,
		meanWall: walls.length ? Math.round((walls.reduce((a, b) => a + b, 0) / walls.length) * 10) / 10 : null,
	};
}

/** The per-branch table a `comparison_ready` trigger carries as its detail (spec §3's row). */
export function compareTable(branches, rows) {
	return branches.map((b) => {
		const mine = rows.filter((r) => r.label === b.label);
		return { label: b.label, firstAction: b.firstAction ?? null, message: Boolean(b.message), ...branchStats(mine) };
	});
}

/** The control branch: the one that forces nothing (spec's G). Named by `label === "G"` first,
 * so a compare that labels its control G is read as such even if a branch above it also left
 * `firstAction` unset. */
export function controlBranch(branches) {
	return branches.find((b) => b.label === "G" && !b.firstAction) ?? branches.find((b) => !b.firstAction) ?? null;
}

/**
 * The branches that did not deliver the comparison they were charged for. Returned as
 * `[{ label, rows, crashed, replicates }]`, empty when every branch stands up.
 *
 * A branch fails this gate two ways: it produced fewer rows than the replicates it was charged
 * for (a batch that stopped early), or every row it produced crashed (a branch that ran and
 * delivered nothing). Left unchecked, a batch abandoned on the collision preflight gives every
 * branch one crashed row, `firstTry 0/1` on both sides, `directionOf` says `same` — and a
 * candidate of that shape is then SETTLED `verified` against replicates of which none ran. §5
 * makes settled findings the basis for promoting a decision to a harness rule, so this is the
 * gate between a crashed batch and a rule.
 *
 * Deliberately NOT "every replicate finished". Crashes are a fact of these runs, and that
 * stricter gate would let a single crashed replicate anywhere in a batch suppress every finding
 * the batch paid for. Crashed rows stay in the denominators `branchStats` reports, which is
 * where they belong: a branch that crashed one of three delivered two, and its own claim says so.
 */
export function incompleteBranches(branches, rows, replicates) {
	return branches
		.map((b) => {
			const mine = rows.filter((r) => r.label === b.label);
			return { label: b.label, rows: mine.length, crashed: mine.filter((r) => r.crashed).length, replicates };
		})
		.filter((b) => b.rows < replicates || b.crashed === b.rows);
}

/**
 * The comparison's shape: what was recorded at the checkpoint against what the branch forced
 * instead — `read→done`, `ls→spawn`. It is the key a finding is settled under, so it names the
 * recorded TOOL (`read`, `ls`) rather than the recorded class (`inspect` covers both, and two
 * comparisons that differ in what was actually skipped would settle each other).
 */
export function shapeOf(recordedTool, firstAction) {
	return `${recordedTool ?? "?"}→${firstAction ?? "?"}`;
}

/** Which way a branch went against its control, on first-try oracle. `same` is a real answer,
 * not a missing one: "forcing this changes nothing" is the finding half the compares produce. */
export function directionOf(a, g) {
	if (a.firstTry === g.firstTry) return "same";
	return a.firstTry > g.firstTry ? "better" : "worse";
}

/**
 * Candidate findings from a finished comparison — one per (control, forced) pair, in the claim
 * shape §5 names. `rows` are forkRow rows tagged with their branch `label`; `recordedTool` is
 * the source point's own tool (from the run's decisions.jsonl) and `evidence` the per-branch
 * report paths, by label.
 *
 * Returns [] when the compare has no control branch: with nothing that forced nothing there is
 * no "vs continuing" to claim, and a made-up baseline would be worse than no finding.
 */
export function findingsFromCompare({ compareId, branches, rows, recordedTool = null, checkpoint = null, evidence = {}, scope = "harness:fork" }) {
	const control = controlBranch(branches);
	if (!control) return [];
	const g = branchStats(rows.filter((r) => r.label === control.label));
	const out = [];
	for (const b of branches) {
		if (b.label === control.label || !b.firstAction) continue;
		const a = branchStats(rows.filter((r) => r.label === b.label));
		const shape = shapeOf(recordedTool, b.firstAction);
		const wall = (s) => (s.meanWall === null ? "—" : `${s.meanWall} s`);
		out.push({
			id: `f-${compareId}-${b.label}`,
			scope,
			shape,
			checkpoint,
			compareId,
			direction: directionOf(a, g),
			claim: `At ${shape}, forcing ${b.firstAction} vs continuing: first-try oracle ${a.firstTry}/${a.n} vs ${g.firstTry}/${g.n}, mean wall ${wall(a)} vs ${wall(g)}`,
			settlement_criterion: "same direction on a second run of the same shape",
			evidence: [evidence[b.label], evidence[control.label]].filter(Boolean),
			stats: { forced: a, control: g },
		});
	}
	return out;
}

/**
 * What to do with a fresh candidate given the findings a task already holds.
 *
 * The rule, stated here because it is the whole point of `settlement_criterion`: a second
 * comparison of the SAME shape is not a second finding, it is the settlement of the first. So
 * when a `candidate` with this shape already exists, this returns a settlement of THAT finding —
 * `verified` when the new comparison went the same way, `refuted` when it went another way —
 * and the new candidate is not appended. Two compares that both say `same` agree, and so settle
 * `verified`: "forcing this changes nothing" is a claim like any other, and it held twice.
 *
 * A shape whose finding is already `verified` or `refuted` is settled; a third comparison of it
 * appends nothing and settles nothing (`{ action: "skip" }`), so re-running a batch cannot
 * flip a settled record back and forth.
 */
export function settleOrAppend(existing, finding) {
	const prior = existing.filter((f) => f.shape === finding.shape);
	const candidate = prior.find((f) => f.status === "candidate");
	if (candidate) {
		const status = candidate.direction === finding.direction ? "verified" : "refuted";
		return { action: "settle", id: candidate.id, status, verifiedOn: [...(candidate.verifiedOn ?? []), String(finding.compareId)] };
	}
	if (prior.length) return { action: "skip", id: prior[0].id, reason: `shape ${finding.shape} is already settled (${prior[0].status})` };
	return { action: "append", finding };
}
