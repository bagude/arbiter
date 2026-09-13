import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPages, recall, lint, renderLint, scopeFile } from "../lib/wiki.mjs";
import { makeRecord, foldLog } from "../lib/memory.mjs";

const DAY = 86_400_000;
const rec = (over) => makeRecord({ scope: "task:orbit", kind: "episodic", text: "x", evidence: [], confidence: 0.5, source: "human", ts: 1000, ...over });

function fixture() {
	const records = foldLog([
		rec({ id: "m_1", status: "promoted", scope: "task:orbit", kind: "procedural", text: "orbit: split stages 1-2, 3-4, 5 across three workers", confidence: 0.7, source: "supervisor", evidence: ["run:r1", "oracle:r1#1"], ts: 10 }),
		rec({ id: "m_2", status: "promoted", scope: "task:orbit", kind: "episodic", text: "orbit via orchestrator: SUCCESS in 1086s. Oracle: 48/48.", confidence: 0.9, source: "supervisor", evidence: ["run:r1", "oracle:r1#1"], ts: 20 }),
		rec({ id: "m_3", status: "candidate", scope: "task:orbit", kind: "semantic", text: "an agent claim about orbit", confidence: 0.4, source: "agent", evidence: ["run:r1", "mail:r1#3"], ts: 30 }),
		rec({ id: "m_4", status: "tombstoned", scope: "task:orbit", kind: "semantic", text: "a forgotten claim", ts: 40 }),
		rec({ id: "m_5", status: "promoted", scope: "global", kind: "semantic", text: "llama.cpp qwen3-27b omits bash timeouts", confidence: 0.6, source: "human", ts: 50 }),
		rec({ id: "m_6", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-recon via orchestrator: SUCCESS in 435s. Oracle: 15/15. KPI digest: TX landed 2026-02-11", confidence: 0.9, source: "supervisor", evidence: ["run:r2", "oracle:r2#1"], ts: 60 }),
		rec({ id: "m_7", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS in 800s. Oracle: 17/17. Findings digest: O1 Two wells hold 60% of oil | O2 December 1992 holds 76% || next: is 1992 a catch-up?", confidence: 0.9, source: "supervisor", evidence: ["run:r3", "oracle:r3#1"], ts: 70 }),
		rec({ id: "m_8", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS in 600s. Oracle: 14/14. Findings digest: O1 Only NM has production | O2 Two wells hold 60% of oil || next: water cut?", confidence: 0.9, source: "supervisor", evidence: ["run:r4", "oracle:r4#1"], ts: 80 }),
	]);
	const runSummaries = new Map([
		["r1", { runId: "r1", task: "orbit", reason: "SUCCESS: oracle passed", wallSec: 1086, workers: 3, doneAttempts: 1, toolCalls: 120, config: { pattern: "orchestrator", roles: { orchestrator: { provider: "llama.cpp", model: "qwen3-27b" } } }, guards: { path: { denied: { orchestrator: 2 } }, bash_timeout: { rewritten: { "worker:a": 5 } } }, memory: { injected: [] } }],
		["r2", { runId: "r2", task: "dw-recon", reason: "SUCCESS: oracle passed", wallSec: 435, workers: 1, doneAttempts: 1, toolCalls: 69, config: { pattern: "orchestrator", roles: {}, repo: "dw" }, guards: {}, memory: { injected: ["m_1"] } }],
	]);
	return { records, runSummaries };
}

test("scopeFile maps scopes to page paths", () => {
	assert.equal(scopeFile("global"), "scopes/global");
	assert.equal(scopeFile("task:orbit"), "scopes/task-orbit");
	assert.equal(scopeFile("repo:data-warehousers"), "scopes/repo-data-warehousers");
});

test("buildPages: index, schema, scope pages with Facts/History/Candidates, run pages, guard pages — all linked", () => {
	const pages = buildPages({ ...fixture(), now: 100 * DAY });
	assert.ok(pages.has("INDEX.md") && pages.has("SCHEMA.md"));
	const orbit = pages.get("scopes/task-orbit.md");
	assert.match(orbit, /^# task:orbit\n/);
	assert.match(orbit, /## Facts\n[\s\S]*- \[procedural\] orbit: split stages 1-2, 3-4, 5 across three workers \(m_1, conf 0\.7, evidence: \[\[runs\/r1\]\] oracle:r1#1\)/);
	assert.match(orbit, /## History\n[\s\S]*- orbit via orchestrator: SUCCESS in 1086s\. Oracle: 48\/48\. \(m_2, .*\[\[runs\/r1\]\]/);
	assert.match(orbit, /## Candidates\n[\s\S]*- \[semantic, agent\] an agent claim about orbit \(m_3/);
	assert.doesNotMatch(orbit, /forgotten claim/);
	const run = pages.get("runs/r1.md");
	assert.match(run, /^# run r1\n/);
	assert.match(run, /task: \[\[scopes\/task-orbit\]\]/);
	assert.match(run, /SUCCESS: oracle passed/);
	assert.match(run, /\[\[guards\/path\]\]: denied 2/);
	assert.match(run, /Oracle: 48\/48/);
	const guard = pages.get("guards/path.md");
	assert.match(guard, /^# guard path\n/);
	assert.match(guard, /\[\[runs\/r1\]\].*denied 2/);
	const index = pages.get("INDEX.md");
	assert.match(index, /## Repos\n[\s\S]*\[\[scopes\/repo-dw\]\]/);
	assert.match(index, /## Tasks\n[\s\S]*\[\[scopes\/task-orbit\]\] — 1 fact, 1 candidate, last run: r1 SUCCESS/);
	assert.match(index, /## Guards\n[\s\S]*\[\[guards\/path\]\]/);
	assert.match(index, /## Runs\n[\s\S]*\[\[runs\/r2\]\]/);
});

test("buildPages: a run referenced by a record but absent on disk still gets a stub page", () => {
	const { records } = fixture();
	const pages = buildPages({ records, runSummaries: new Map(), now: 100 * DAY });
	assert.match(pages.get("runs/r1.md"), /no summary on disk/);
});

test("recall reads pages in scope order (repo, task, global), Facts before History, within the budget, and reports the ids", () => {
	const pages = buildPages({ ...fixture(), now: 100 * DAY });
	const full = recall({ pages, scopes: ["global", "task:orbit", "repo:dw"], budgetChars: 10_000 });
	assert.match(full.text, /^# MEMORY \(wiki excerpt; scopes: repo:dw, task:orbit, global\)\n/);
	assert.ok(full.text.indexOf("## repo:dw") < full.text.indexOf("## task:orbit") && full.text.indexOf("## task:orbit") < full.text.indexOf("## global"));
	assert.deepEqual(full.ids, ["m_8", "m_6", "m_7", "m_1", "m_2", "m_5"]);
	assert.doesNotMatch(full.text, /agent claim|forgotten/);
	// digests: newest per task first (explore r4, then recon r2), then the older explore r3
	assert.match(full.text, /## repo:dw\n- \[\[runs\/r4\]\] Findings digest: O1 Only NM has production[^\n]*\n- \[\[runs\/r2\]\] KPI digest: TX landed 2026-02-11 \(m_6\)\n- \[\[runs\/r3\]\] Findings digest:/);
	// explorations: every title once, newest first; the duplicate title appears one time
	const repoPage = pages.get("scopes/repo-dw.md");
	assert.match(repoPage, /## Explorations\n\n3 distinct observation title\(s\)[^\n]*\n\n- \[unreviewed ·\] Only NM has production \(\[\[runs\/r4\]\]\)\n- \[unreviewed ·\] Two wells hold 60% of oil \(\[\[runs\/r4\]\]\)\n- \[unreviewed ·\] December 1992 holds 76% \(\[\[runs\/r3\]\]\)\n/);
	// the History line for a digest-bearing record is stripped of the digest
	assert.match(full.text, /- dw-recon via orchestrator: SUCCESS in 435s\. Oracle: 15\/15\. \(m_6, conf 0\.9/);
	assert.equal((full.text.match(/KPI digest/g) ?? []).length, 1);
	const tight = recall({ pages, scopes: ["task:orbit"], budgetChars: 160 });
	assert.deepEqual(tight.ids, ["m_1"]);
	const none = recall({ pages, scopes: ["task:nothing"], budgetChars: 1000 });
	assert.deepEqual(none, { text: "", ids: [] });
});

test("lint: unbacked promotions, missing runs, stale candidates, cross-scope duplicates, scopes without runs", () => {
	const { records, runSummaries } = fixture();
	records.set("m_7", rec({ id: "m_7", status: "promoted", scope: "task:orbit", kind: "semantic", text: "promoted with nothing behind it", source: "agent", ts: 70 }));
	records.set("m_8", rec({ id: "m_8", status: "candidate", scope: "global", kind: "semantic", text: "an agent claim about orbit", source: "agent", ts: 80 }));
	records.set("m_9", rec({ id: "m_9", status: "promoted", scope: "task:lonely", kind: "semantic", text: "no runs here", source: "human", ts: 90 }));
	records.set("m_10", { ...rec({ id: "m_10", status: "promoted", scope: "task:orbit", kind: "semantic", text: "an agent note a human ruled on", source: "agent", ts: 95 }), promotedBy: "human" });
	const findings = lint({ records, runSummaries: new Map([["r1", runSummaries.get("r1")]]), now: 100 * DAY, staleDays: 14 });
	const rules = (id) => findings.filter((f) => f.id === id).map((f) => f.rule);
	assert.deepEqual(rules("m_7"), ["unbacked-promotion"]);
	assert.ok(findings.some((f) => f.rule === "missing-run" && f.id === "m_6" && /r2/.test(f.detail)));
	assert.ok(findings.some((f) => f.rule === "stale-candidate" && f.id === "m_3"));
	assert.ok(findings.some((f) => f.rule === "cross-scope-duplicate" && /m_3/.test(f.detail) && /m_8/.test(f.detail)));
	assert.ok(findings.some((f) => f.rule === "scope-without-runs" && f.scope === "task:lonely"));
	assert.ok(!findings.some((f) => f.rule === "unbacked-promotion" && f.id === "m_5"), "a human promotion is backed");
	assert.ok(!findings.some((f) => f.rule === "unbacked-promotion" && f.id === "m_10"), "an agent record a human promoted is backed");
	const md = renderLint(findings, 100 * DAY);
	assert.match(md, /^# LINT/);
	assert.match(md, /unbacked-promotion/);
});

test("Explorations lists per-observation records with claim and verified marks, and legacy digests only when not superseded", () => {
	const records = foldLog([
		rec({ id: "m_o1", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", summary: "TX water_bbl is 100% NULL", text: "TX water_bbl is 100% NULL — all rows.", snapshot: "dw@1", verification: { query_sha: "a", snapshot: "dw@1", reproduced: true, by: "oracle:r5#1" }, evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 90 }),
		rec({ id: "m_o2", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "interpreted", settlement_criterion: "check the loader", summary: "TX water is missing by source design", text: "TX water is missing by source design — …", evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 91 }),
		rec({ id: "m_7", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS. Findings digest: O1 Two wells hold 60% of oil || next: x?", evidence: ["run:r3", "oracle:r3#1"], source: "supervisor", ts: 70 }),
		rec({ id: "m_8", status: "promoted", scope: "repo:dw", kind: "episodic", text: "dw-explore via orchestrator: SUCCESS. Findings digest: O1 Only NM has production", evidence: ["run:r4", "oracle:r4#1"], source: "supervisor", ts: 80 }),
		{ op: "update", id: "m_8", ts: 81, superseded_by: "m_x" },
	]);
	const pages = buildPages({ records, runSummaries: new Map(), now: 100 * DAY });
	const page = pages.get("scopes/repo-dw.md");
	assert.match(page, /- \[observed ✓\] TX water_bbl is 100% NULL \(\[\[runs\/r5\]\]\)/);
	assert.match(page, /- \[interpreted ·\] TX water is missing by source design \(\[\[runs\/r5\]\]\) — settles by: check the loader/);
	assert.match(page, /- \[unreviewed ·\] Two wells hold 60% of oil/);
	assert.ok(!page.includes("Only NM has production"), "a superseded digest is not listed");
});

test("lint flags observed records without verification", () => {
	const records = foldLog([
		rec({ id: "m_v", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", text: "verified thing", verification: { query_sha: "a", snapshot: "dw@1", reproduced: true, by: "oracle:r5#1" }, evidence: ["run:r5", "oracle:r5#1"], source: "supervisor", ts: 1 }),
		rec({ id: "m_u", status: "promoted", scope: "repo:dw", kind: "semantic", claim: "observed", text: "unverified thing", evidence: ["run:r5"], source: "agent", ts: 2 }),
	]);
	const findings = lint({ records, runSummaries: new Map(), now: 100 * DAY });
	assert.deepEqual(findings.filter((x) => x.rule === "observed-unverified").map((x) => x.id), ["m_u"]);
});
