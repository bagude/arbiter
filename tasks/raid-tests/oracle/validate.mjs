#!/usr/bin/env node
// Oracle for `raid-tests`: the deliverable is a test suite, src/raid.test.mjs, for the
// given src/raid.mjs. Checks: (1) the suite passes against the pristine module and has
// at least 10 tests; (2) for each planted bug in mutants.mjs, the suite fails against
// the mutated module (the mutant is "killed"). A suite that does not pass on the
// pristine module scores 0 — a suite that fails everywhere kills nothing.
// The pristine module comes from this task's own copy, never from the workspace.
// Usage: node validate.mjs <workspace>. Prints one JSON line {pass, total, summary, details}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MUTANTS, applyMutant } from "./mutants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRISTINE = fs.readFileSync(path.join(here, "..", "ws-builder", "src", "raid.mjs"), "utf8");
const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
const total = 1 + MUTANTS.length;

const suitePath = ws && path.join(ws, "src", "raid.test.mjs");
if (!suitePath || !fs.existsSync(suitePath)) {
	out({ pass: 0, total, summary: "src/raid.test.mjs missing", details: [] });
	process.exit(0);
}
const suite = fs.readFileSync(suitePath, "utf8");

function runSuite(raidSource) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-raid-tests-"));
	try {
		fs.mkdirSync(path.join(scratch, "src"));
		fs.writeFileSync(path.join(scratch, "src", "raid.mjs"), raidSource);
		fs.writeFileSync(path.join(scratch, "src", "raid.test.mjs"), suite);
		const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "src/raid.test.mjs"], { cwd: scratch, encoding: "utf8", timeout: 40_000 });
		const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		const pass = Number(/^# pass (\d+)/m.exec(text)?.[1] ?? 0);
		const fail = Number(/^# fail (\d+)/m.exec(text)?.[1] ?? 0);
		const loaded = /^# tests (\d+)/m.test(text);
		return { pass, fail, ran: pass + fail, loaded, exit: r.status, failing: (text.match(/^not ok \d+ - (.*)$/gm) ?? []).map((l) => l.replace(/^not ok \d+ - /, "")).slice(0, 6) };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

const base = runSuite(PRISTINE);
const details = [{ check: "passes-on-pristine", ok: base.loaded && base.fail === 0 && base.exit === 0 && base.ran >= 10, ran: base.ran, fail: base.fail, failing: base.failing }];
let pass = 0;
if (details[0].ok) {
	pass = 1;
	for (const m of MUTANTS) {
		const r = runSuite(applyMutant(PRISTINE, m));
		const killed = r.fail > 0 || r.exit !== 0;
		if (killed) pass++;
		details.push({ check: m.id, stage: m.stage, killed, failing: r.failing });
	}
} else {
	for (const m of MUTANTS) details.push({ check: m.id, stage: m.stage, killed: false, skipped: "suite does not pass on the pristine module" });
}
const killed = details.slice(1).filter((d) => d.killed).length;
const survivors = details.slice(1).filter((d) => !d.killed).map((d) => `stage ${d.stage}`);
const byStage = {};
for (const s of survivors) byStage[s] = (byStage[s] ?? 0) + 1;
const summary = details[0].ok
	? `${pass}/${total}: suite passes on the pristine module (${base.ran} tests); ${killed}/${MUTANTS.length} planted bugs caught${survivors.length ? `; uncaught by stage: ${Object.entries(byStage).map(([s, n]) => `${s} ×${n}`).join(", ")}` : ""}`
	: `0/${total}: suite does not pass on the pristine module (${base.ran} tests ran, ${base.fail} failed${base.loaded ? "" : ", or the file did not load"}${base.ran < 10 ? "; fewer than 10 tests" : ""}). Failing: ${base.failing.join(" | ").slice(0, 400) || "n/a"}`;
out({ pass, total, summary, details });
