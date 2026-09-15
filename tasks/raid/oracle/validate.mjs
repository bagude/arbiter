#!/usr/bin/env node
// Oracle for `raid`: runs the hidden node:test suites (raid.test.mjs, scene.test.mjs)
// against a fresh copy of the workspace's src/ in a scratch directory under the OS
// temp dir, exactly as the *.test.mjs oracle shape does — the validate.mjs shape is
// used only because the deliverable is several files (raid.mjs, scene.mjs,
// index.html and the vendored three.js), which the single-file test shape cannot
// stage. The hidden tests never land in the workspace. Usage: node validate.mjs
// <workspace>. Prints one JSON line {pass, total, summary, details}.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));

if (!ws || !fs.existsSync(path.join(ws, "src"))) {
	out({ pass: 0, total: 1, summary: "no src/ in the workspace; nothing to test", details: [] });
	process.exit(0);
}
const tests = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-raid-oracle-"));
let details = [];
let pass = 0;
let total = 0;
try {
	fs.cpSync(path.join(ws, "src"), path.join(scratch, "src"), { recursive: true });
	for (const f of tests) {
		fs.copyFileSync(path.join(here, f), path.join(scratch, f));
		const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", f], { cwd: scratch, encoding: "utf8", timeout: 45_000 });
		const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		const p = Number(/^# pass (\d+)/m.exec(text)?.[1] ?? 0);
		const fl = Number(/^# fail (\d+)/m.exec(text)?.[1] ?? 0);
		// A suite that cannot even load (syntax error, missing export at import time) reports
		// 0/0 from node; count it as one failed check so the run is never mistaken for empty.
		const t = p + fl || 1;
		pass += p;
		total += t;
		details.push({ file: f, pass: p, total: t, loadError: p + fl === 0 ? text.split("\n").filter((l) => /error|Error/.test(l)).slice(0, 3).join(" | ").slice(0, 300) : undefined });
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
const parts = details.map((d) => `${d.file.replace(".test.mjs", "")} ${d.pass}/${d.total}${d.loadError ? ` (did not load: ${d.loadError})` : ""}`);
out({ pass, total, summary: `${pass}/${total} hidden tests: ${parts.join("; ")}`, details });
