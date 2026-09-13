import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, loadPages, verifyQuote } from "../lib/research/quotes.mjs";
import { checkSnippet, runSnippet, valuesMatch } from "../lib/research/snippets.mjs";
import { resolveCitations, citationRules } from "../lib/research/citations.mjs";
import { makeRecord, appendLog } from "../lib/memory.mjs";
import { resolveLedger, buildIndex } from "../lib/memory-index.mjs";

test("quotes verify after whitespace and punctuation normalisation, and short or absent ones fail", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-pages-"));
	fs.writeFileSync(path.join(dir, "p03.txt"), "The Power-Law Exponential Model [Ilk et al. (2008, 2009)] — a  four-parameter\nrelation for the rate–time behavior of tight gas wells.\n");
	const pages = loadPages(dir);
	assert.equal(pages.size, 1);
	assert.equal(verifyQuote(pages, 3, "the power-law exponential model [Ilk et al. (2008, 2009)] - a four-parameter relation").ok, true);
	assert.match(verifyQuote(pages, 3, "a four parameter relation").reason, /too short/);
	assert.match(verifyQuote(pages, 3, "the stretched exponential model is a two parameter relation for rates").reason, /not found verbatim/);
	assert.match(verifyQuote(pages, 9, "x".repeat(50)).reason, /no such page/);
	assert.equal(normalize("A‐B  “q”"), 'a-b"q"');
});

test("snippets: the deny-list refuses filesystem, process and network code; a clean snippet runs on its rows", () => {
	assert.match(checkSnippet("import os\nprint(1)").reason, /refused construct: import os/);
	assert.match(checkSnippet("print(open('x').read())").reason, /refused construct: open\(/);
	assert.match(checkSnippet("from subprocess import run").reason, /refused/);
	assert.equal(checkSnippet("import json, sys\nprint(json.dumps({'n': 3}))").ok, true);
	assert.match(checkSnippet("import json, sys\nrows = json.load(__builtins__.open(sys.argv[1]))").reason, /refused/, "open through builtins is still refused");
	const good = "import json, sys, numpy as np\nrows = json.load(sys.stdin)\nq = np.array([100.0, 80.0, 64.0])\nD = -np.polyfit(np.arange(3), np.log(q), 1)[0]\nprint(json.dumps({'D': round(float(D), 6), 'n': int(len(q)), 'rows': len(rows)}))";
	const r = runSnippet(good, { rows: [1, 2, 3] });
	assert.equal(r.ok, true, r.error);
	assert.equal(valuesMatch(r.stdout, { D: 0.223144, n: 3, rows: 3 }).ok, true);
	assert.equal(valuesMatch(r.stdout, { D: 0.3, n: 3, rows: 3 }).ok, false);
});

test("rows arrive on stdin and a snippet reads them with json.load(sys.stdin)", () => {
	const code = "import json, sys\nrows = json.load(sys.stdin)\nprint(json.dumps({'count': len(rows)}))";
	const r = runSnippet(code, { rows: [[1], [2], [3]] });
	assert.equal(r.ok, true, r.error);
	assert.equal(valuesMatch(r.stdout, { count: 3 }).ok, true);
});

test("citations resolve within scopes and the claim rules hold", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-cite-"));
	const log = path.join(dir, "records.jsonl");
	const S = "dw@1";
	const rec = (over) => makeRecord({ scope: "repo:research-x", kind: "semantic", source: "supervisor", ts: 1, evidence: ["run:r1", "oracle:r1#1"], ...over });
	appendLog(log, [
		rec({ id: "m_aaaaaaaaaaaa", claim: "observed", snapshot: S, text: "verified fact", verification: { query_sha: "q", snapshot: S, reproduced: true, by: "oracle:r1#1" } }),
		rec({ id: "m_bbbbbbbbbbbb", claim: "observed", snapshot: S, text: "unverified observed" }),
		rec({ id: "m_cccccccccccc", claim: "interpreted", settlement_criterion: "x", text: "an interpretation" }),
		rec({ id: "m_dddddddddddd", scope: "repo:elsewhere", claim: "observed", text: "out of scope" }),
		rec({ id: "m_eeeeeeeeeeee", claim: "observed", text: "gone", verification: { query_sha: "q", snapshot: S, reproduced: true, by: "oracle:r1#1" } }),
		{ op: "tombstone", id: "m_eeeeeeeeeeee", ts: 2, reason: "x" },
	]);
	const idx = buildIndex(dir, resolveLedger(log));
	const resolved = resolveCitations(idx, ["repo:research-x"], ["m_aaaaaaaaaaaa", "m_bbbbbbbbbbbb", "m_cccccccccccc", "m_dddddddddddd", "m_eeeeeeeeeeee", "nope"]);
	assert.equal(resolved.get("m_aaaaaaaaaaaa").verified, true);
	assert.equal(resolved.get("m_dddddddddddd").found, false);
	assert.equal(resolved.get("nope").reason, "not a memory id");
	assert.deepEqual(citationRules("observed", ["m_aaaaaaaaaaaa"], resolved), []);
	assert.match(citationRules("observed", ["m_bbbbbbbbbbbb"], resolved)[0], /unverified/);
	assert.match(citationRules("observed", ["m_cccccccccccc"], resolved)[0], /is interpreted/);
	assert.deepEqual(citationRules("interpreted", ["m_cccccccccccc", "m_bbbbbbbbbbbb"], resolved), []);
	assert.match(citationRules("interpreted", ["m_eeeeeeeeeeee"], resolved)[0], /tombstoned/);
	assert.match(citationRules("hypothesis", ["m_dddddddddddd"], resolved)[0], /not in the index/);
});
