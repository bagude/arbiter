// jev-tests — can Jev tell a wrong test expectation from a right one, given only the spec?
//
//   node tools/jev-tests.mjs <suite.mjs> [...] [--list <file of suite paths>] [--spec tasks/pathnorm/spec.md]
//                            [--reference tasks/pathnorm/oracle/reference.mjs] [--limit N] [--dry-run]
//
// Every tester suite this harness has produced had at least one expectation that contradicts
// the stated rule (docs/batch/roster-topology*.md: 7 of 8). This tool (1) runs each suite
// against the task's REFERENCE implementation through a recording assert shim, so every
// assertion gets a ground truth (the reference is the oracle's own model of the spec);
// (2) asks Jev, per unique assertion, whether the expected value follows from the spec —
// a noul plus a three-way choice — with the spec and the one assertion line as the state;
// (3) scores Jev against the truth: AUC, catches and false alarms at 0.5, a τ-curve, and the
// list of wrong expectations with whether Jev caught them. Assertions are deduplicated by
// their source line across suites, since fork replicates inherit the source run's suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askJev } from "../lib/jev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

function readKey() {
	const env = (process.env.TYPESAFE_API_KEY ?? "").trim();
	if (env) return env;
	for (const dir of [ROOT, path.resolve(ROOT, "..", ".."), path.resolve(ROOT, "..")]) {
		const f = path.join(dir, ".env");
		if (fs.existsSync(f)) { const m = fs.readFileSync(f, "utf8").match(/^TYPESAFE_API_KEY=(\S+)/m); if (m) return m[1]; }
	}
	return "";
}

// The shim: every assert method records {line, pass} and never throws, so one run of a
// self-executing suite yields every assertion's truth instead of stopping at the first miss.
const SHIM = `
import fs from "node:fs";
import { strict as real } from "node:assert";
const records = [];
function suiteLines() {
	// Every frame inside the suite, innermost first; the harness picks the first that is a
	// call site rather than a helper definition or a test() block header.
	const out = [];
	for (const s of String(new Error().stack).split("\\n")) {
		const m = s.match(/\\((.*?):(\\d+):\\d+\\)\\s*$/) ?? s.match(/at (.*?):(\\d+):\\d+\\s*$/);
		if (m && m[1].replace(/\\\\/g, "/").endsWith(process.env.SUITE_BASENAME)) out.push(Number(m[2]));
	}
	return out;
}
function record(pass, detail) { records.push({ lines: suiteLines(), pass, ...detail }); }
function wrap(name) {
	return (...args) => { try { real[name](...args); record(true, { method: name }); } catch (e) { record(false, { method: name, error: String(e.message).slice(0, 200) }); } };
}
const assert = (v, m) => { try { real.ok(v, m); record(true, { method: "ok" }); } catch (e) { record(false, { method: "ok", error: String(e.message).slice(0, 200) }); } };
for (const n of ["strictEqual", "equal", "deepStrictEqual", "deepEqual", "notStrictEqual", "notEqual", "ok", "match", "doesNotThrow", "fail"]) assert[n] = wrap(n);
// assert.rejects returns a promise: a sync try/catch would score it as a pass unconditionally.
assert.rejects = async (...args) => { try { await real.rejects(...args); record(true, { method: "rejects" }); } catch (e) { record(false, { method: "rejects", error: String(e.message).slice(0, 200) }); } };
assert.throws = (fn, validator, m) => {
	try { real.throws(fn, validator, m); record(true, { method: "throws" }); } catch (e) { record(false, { method: "throws", error: String(e.message).slice(0, 200) }); }
};
assert.strict = assert;
process.on("exit", () => { fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify(records)); });
export default assert;
export { assert as strict };
`;

/**
 * Run one suite against the reference; return every recorded assertion with its source line.
 * A helper like eq(actual, expected, msg) records the HELPER's line (where assert is called);
 * the caller's line is what we want, so the innermost frame inside the suite that is not the
 * helper definition wins: we take the LAST suite frame on the stack, which is the call site.
 */
export function truthFor(suiteFile, referenceFile, { module = null } = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-tests-"));
	const src = fs.readFileSync(suiteFile, "utf8");
	const refUrl = pathToFileURL(path.resolve(referenceFile)).href;
	const shimUrl = pathToFileURL(path.join(tmp, "assert-shim.mjs")).href;
	// The module under test is named after the reference (reference.mjs stands in for
	// src/<module>.mjs; the tester imports it as ../<module>.mjs or ./<module>.mjs).
	// The module under test: --module, else the task directory name when the reference sits in
	// tasks/<task>/oracle/ (the reference basename is always "reference", so it cannot be the name).
	const refDir = path.dirname(path.resolve(referenceFile));
	const modName = module ?? (path.basename(refDir) === "oracle" ? path.basename(path.dirname(refDir)) : null);
	if (!modName) throw new Error("cannot infer the module under test from " + referenceFile + " — pass --module <name>");
	const esc = modName.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
	const modRe = new RegExp("from\\s+[\"'](?:\\.\\./|\\./|\\.\\./src/)" + esc + "\\.m?js[\"']", "g");
	const rewritten = src
		.replace(modRe, `from ${JSON.stringify(refUrl)}`)
		.replace(/from\s+["']node:assert\/strict["']/g, `from ${JSON.stringify(shimUrl)}`)
		.replace(/from\s+["']node:assert["']/g, `from ${JSON.stringify(shimUrl)}`)
		.replace(/import\s+\{\s*test\s*\}\s+from\s+["']node:test["'];?/g, "const test = (n, fn) => fn();")
		.replace(/process\.exit\(\s*\d*\s*\)/g, "void 0");
	const suiteCopy = path.join(tmp, path.basename(suiteFile));
	fs.writeFileSync(path.join(tmp, "assert-shim.mjs"), SHIM);
	fs.writeFileSync(suiteCopy, rewritten);
	const recordFile = path.join(tmp, "records.json");
	const r = spawnSync(process.execPath, [suiteCopy], { env: { ...process.env, SUITE_BASENAME: path.basename(suiteFile), RECORD_FILE: recordFile }, encoding: "utf8", timeout: 30000 });
	const records = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : [];
	const lines = src.split(/\r?\n/);
	// Frame numbers come from the REWRITTEN file; the rewrite is line-preserving, but the test
	// import becomes an arrow on its own line, so the definition test must read rewritten lines.
	const rlines = rewritten.split(/\r?\n/);
	fs.rmSync(tmp, { recursive: true, force: true });
	// The call site is the innermost suite frame that is not a helper definition or a
	// test()/it()/describe() header (a suite in blocks would otherwise collapse every
	// assertion onto the block's first line and lose all but one).
	const isDefinition = (t) => /^\s*(async\s+)?(function|const|let|var)\b/.test(t) || /=>\s*\{?\s*$/.test(t) || /^\s*(test|it|describe)\s*\(/.test(t);
	const closed = (t) => { let d = 0; for (const ch of t) { if (ch === "(") d++; else if (ch === ")") d--; } return d === 0; };
	const withSource = records.map((x) => {
		// Outermost first: the innermost frame is the helper's own body (assert.* inside eq), the
		// outermost is a test() header when the suite is in blocks; the call site is the outermost
		// frame that is neither.
		const line = [...(x.lines ?? [])].reverse().find((n) => !isDefinition((rlines[n - 1] ?? "").trim())) ?? null;
		const source = line ? (lines[line - 1] ?? "").trim() : "";
		// A multi-line assertion yields an unclosed fragment; it is kept for the count but
		// carries no source, so it is never sent to Jev as if it were the whole assertion.
		return { ...x, line, source: closed(source) ? source : "" };
	});
	return { records: withSource, exit: r.status, stderr: (r.stderr ?? "").slice(0, 400) };
}

export function questionFor(spec, assertion) {
	return {
		state: `SPECIFICATION\n\n${spec}\n\nASSERTION (one line from a test suite written against the specification; the helper eq(actual, expected) asserts strict equality and throwsTypeError(fn, prefix) asserts a TypeError whose message starts with prefix):\n\n${assertion}`,
		questions: {
			follows: { type: "noul", instructions: "The expected value in the ASSERTION is exactly what the SPECIFICATION's rules require for that input." },
			verdict: { type: "choice", instructions: "Judge the ASSERTION's expected value against the SPECIFICATION.", criteria: { correct: "the expected value is what the rules require", wrong: "the rules require a different value (or a different error) for this input", undetermined: "the specification does not determine the value for this input" } },
		},
	};
}

export function auc(rows) {
	const pos = rows.filter((r) => !r.pass), neg = rows.filter((r) => r.pass);
	if (!pos.length || !neg.length) return null;
	let s = 0;
	for (const p of pos) for (const n of neg) s += p.pFollows < n.pFollows ? 1 : p.pFollows === n.pFollows ? 0.5 : 0;
	return s / (pos.length * neg.length);
}

async function main() {
	const argv = process.argv.slice(2);
	const spec = { suites: [], specFile: path.join(ROOT, "tasks", "pathnorm", "spec.md"), reference: path.join(ROOT, "tasks", "pathnorm", "oracle", "reference.mjs"), limit: Infinity, dryRun: false, stripLabels: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--spec") spec.specFile = path.resolve(argv[++i]);
		else if (a === "--reference") spec.reference = path.resolve(argv[++i]);
		else if (a === "--module") spec.module = argv[++i];
		else if (a === "--limit") spec.limit = Number(argv[++i]);
		else if (a === "--dry-run") spec.dryRun = true;
		else if (a === "--list") spec.suites.push(...fs.readFileSync(path.resolve(argv[++i]), "utf8").split(/\r?\n/).filter(Boolean).map((p) => path.resolve(p)));
		else if (a === "--strip-labels") spec.stripLabels = true;
		else spec.suites.push(path.resolve(a));
	}
	if (!spec.suites.length) { console.error("usage: node tools/jev-tests.mjs <suite.mjs> [...] [--list f] [--spec f] [--reference f] [--limit N] [--strip-labels] [--dry-run]"); process.exit(2); }
	const specText = fs.readFileSync(spec.specFile, "utf8");
	const key = spec.dryRun ? "" : readKey();
	if (!spec.dryRun && !key) { console.error("no TYPESAFE_API_KEY"); process.exit(2); }

	const bySource = new Map();
	for (const suite of spec.suites) {
		const { records, exit, stderr } = truthFor(suite, spec.reference, { module: spec.module ?? null });
		const withSource = records.filter((r) => r.source);
		console.error(`${path.relative(ROOT, suite)}: ${records.length} assertions (${records.filter((r) => !r.pass).length} fail against the reference)${exit ? `, exit ${exit}` : ""}${!records.length && stderr ? `\n${stderr}` : ""}`);
		for (const r of withSource) {
			if (!bySource.has(r.source)) bySource.set(r.source, { source: r.source, pass: r.pass, method: r.method, error: r.error ?? null, suites: 0 });
			bySource.get(r.source).suites += 1;
		}
	}
	const unique = [...bySource.values()].slice(0, spec.limit);
	const wrong = unique.filter((u) => !u.pass);
	console.log(`${unique.length} unique assertions across ${spec.suites.length} suite(s); ${wrong.length} contradict the reference`);
	if (spec.dryRun) { for (const w of wrong) console.log(`  WRONG  ${w.source}   (${w.error})`); return; }

	const rows = [];
	for (const u of unique) {
		// --strip-labels drops the tester's own message argument (the third argument of eq/throws
		// helpers), which often restates the misconception the expectation encodes.
		const shown = spec.stripLabels ? stripLabel(u.source) : u.source;
		const q = questionFor(specText, shown);
		const r = await askJev({ state: q.state, questions: q.questions, key });
		if (!r.ok) { console.log(`ERR ${r.status} ${r.errorType}  ${u.source}`); continue; }
		const pFollows = r.answers.follows?.noul ?? 0;
		const verdict = r.answers.verdict?.choice ?? "?";
		const conf = r.answers.verdict?.confidence ?? 0;
		rows.push({ ...u, pFollows, verdict, conf, probabilities: r.answers.verdict?.probabilities ?? null, ms: r.ms });
		const right = u.pass ? pFollows >= 0.5 : pFollows < 0.5;
		console.log(`${u.pass ? "ok   " : "WRONG"} follows=${pFollows.toFixed(2)} ${verdict.padEnd(12)} c=${conf.toFixed(2)} ${right ? "=" : "≠"}  ${u.source.slice(0, 110)}`);
	}
	const n = rows.length;
	const wrongRows = rows.filter((r) => !r.pass), okRows = rows.filter((r) => r.pass);
	const caught = wrongRows.filter((r) => r.pFollows < 0.5).length;
	const falseAlarm = okRows.filter((r) => r.pFollows < 0.5).length;
	const flagged = rows.filter((r) => r.verdict === "wrong");
	console.log("");
	console.log(`${n} assertions · ${wrongRows.length} wrong · noul<0.5 flags: caught ${caught}/${wrongRows.length}, false alarms ${falseAlarm}/${okRows.length} · verdict=wrong: ${flagged.length} flagged, ${flagged.filter((r) => !r.pass).length} truly wrong · AUC ${auc(rows)?.toFixed(3) ?? "—"} · ${(rows.reduce((s, r) => s + r.ms, 0) / Math.max(n, 1)).toFixed(0)} ms/assertion`);
	console.log("τ (flag when follows<τ)  flagged  caught  false-alarms");
	for (const t of [0.2, 0.3, 0.5, 0.7, 0.8, 0.9]) {
		const f = rows.filter((r) => r.pFollows < t);
		console.log(`${t.toFixed(2).padEnd(24)} ${String(f.length).padStart(7)}  ${String(f.filter((r) => !r.pass).length).padStart(6)}  ${String(f.filter((r) => r.pass).length).padStart(12)}`);
	}
	console.log("\nwrong expectations:");
	for (const r of wrongRows) console.log(`  follows=${r.pFollows.toFixed(2)} ${r.verdict.padEnd(12)} ${r.source.slice(0, 120)}   ← reference: ${r.error}`);
	const out = path.join(ROOT, "runs", "jev-tests.jsonl");
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	console.log(`\nrows: ${path.relative(ROOT, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1); });


/**
 * eq(actual, expected, 'label') → eq(actual, expected); throwsTypeError(fn, prefix, 'label') →
 * without the label. Only the LAST top-level argument is dropped, and only when it is a string
 * literal and at least two arguments remain, so a two-argument assertion keeps its expectation.
 */
export function stripLabel(line) {
	const m = line.match(/^(\w+)\((.*)\)\s*;?\s*$/s);
	if (!m) return line;
	const args = [];
	let depth = 0, quote = null, cur = "";
	const body = m[2];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (quote) { cur += ch; if (ch === "\\") { cur += body[++i] ?? ""; } else if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
		if ("([{".includes(ch)) depth++;
		if (")]}".includes(ch)) depth--;
		if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
		cur += ch;
	}
	if (cur.trim()) args.push(cur.trim());
	const last = args[args.length - 1] ?? "";
	const isString = last.startsWith('"') || last.startsWith("'") || last.startsWith("`");
	if (args.length < 3 || !isString) return line;
	return `${m[1]}(${args.slice(0, -1).join(", ")});`;
}
