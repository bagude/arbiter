// Verify that a task's oracle is self-consistent before any agent ever sees it:
//   reference.mjs must pass every hidden test; the shipped stub must pass none;
//   probe.mjs must run and answer. Prints one JSON line per task and exits non-zero
//   if any task fails a check.
//
//   node tools/verify-task.mjs <task> [<task> ...]
//   node tools/verify-task.mjs --all
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TASKS = path.join(here, "..", "tasks");

function runHidden(taskDir, srcFile) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-verify-"));
	try {
		const name = path.basename(taskDir);
		fs.mkdirSync(path.join(scratch, "src"));
		fs.copyFileSync(srcFile, path.join(scratch, "src", `${name}.mjs`));
		const tests = fs.readdirSync(path.join(taskDir, "oracle")).filter((f) => f.endsWith(".test.mjs"));
		for (const f of tests) fs.copyFileSync(path.join(taskDir, "oracle", f), path.join(scratch, f));
		const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], { cwd: scratch, encoding: "utf8", timeout: 120_000 });
		const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		return { pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0), fail: Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0), tests };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function runProbe(taskDir) {
	const probe = path.join(taskDir, "oracle", "probe.mjs");
	if (!fs.existsSync(probe)) return { ok: false, error: "no probe.mjs" };
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-verify-"));
	try {
		const name = path.basename(taskDir);
		fs.mkdirSync(path.join(scratch, "src"));
		fs.copyFileSync(path.join(taskDir, "oracle", "reference.mjs"), path.join(scratch, "src", `${name}.mjs`));
		const r = spawnSync(process.execPath, [probe, scratch], { encoding: "utf8", input: "[]", timeout: 60_000 });
		const last = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
		let parsed;
		try {
			parsed = JSON.parse(last);
		} catch {
			return { ok: false, error: `probe printed no JSON: ${(r.stderr ?? "").slice(0, 200)}` };
		}
		return { ok: Array.isArray(parsed), error: Array.isArray(parsed) ? undefined : "probe output is not an array" };
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

export function verifyTask(name) {
	const taskDir = path.join(TASKS, name);
	const problems = [];
	const need = ["spec.md", "ws-builder/README.md", `ws-builder/src/${name}.mjs`, `oracle/${name}.test.mjs`, "oracle/reference.mjs", "oracle/probe.mjs"];
	for (const f of need) if (!fs.existsSync(path.join(taskDir, f))) problems.push(`missing ${f}`);
	if (problems.length) return { task: name, ok: false, problems };
	const ref = runHidden(taskDir, path.join(taskDir, "oracle", "reference.mjs"));
	const stub = runHidden(taskDir, path.join(taskDir, "ws-builder", "src", `${name}.mjs`));
	const probe = runProbe(taskDir);
	if (ref.pass + ref.fail === 0) problems.push("hidden test ran no tests");
	if (ref.fail > 0) problems.push(`reference fails ${ref.fail}/${ref.pass + ref.fail} hidden tests`);
	// A hidden suite may include one static check a stub passes by construction (e.g.
	// pathnorm's "the source does not import node:path"); more than one is a suite
	// that grades something the stub already has.
	if (stub.pass > 1) problems.push(`stub passes ${stub.pass} hidden tests`);
	if (!probe.ok) problems.push(`probe: ${probe.error}`);
	return { task: name, ok: problems.length === 0, tests: ref.pass + ref.fail, reference: `${ref.pass}/${ref.pass + ref.fail}`, stub: `${stub.pass}/${stub.pass + stub.fail}`, probe: probe.ok, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let names = process.argv.slice(2);
	if (names[0] === "--all") names = fs.readdirSync(TASKS).filter((n) => fs.existsSync(path.join(TASKS, n, "oracle", "reference.mjs")));
	let bad = 0;
	for (const n of names) {
		const r = verifyTask(n);
		if (!r.ok) bad++;
		console.log(JSON.stringify(r));
	}
	process.exit(bad ? 1 : 0);
}
