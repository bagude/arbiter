import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decidePath } from "../lib/path-policy.mjs";

// The workspace root as the supervisor would set it: an absolute path in the
// platform's native form. Every case below is stated against this root.
const ROOT = path.resolve("C:/work/runs/.ws-run/ws-builder");
const decide = (tool, input) => decidePath({ root: ROOT, tool, input });

test("a relative path inside the workspace is allowed", () => {
	assert.deepEqual(decide("read", { path: "src/glob.mjs" }), { ok: true });
});

test("an absolute path inside the workspace is allowed in either slash form", () => {
	assert.equal(decide("read", { path: "C:/work/runs/.ws-run/ws-builder/src/glob.mjs" }).ok, true);
	assert.equal(decide("read", { path: "C:\\work\\runs\\.ws-run\\ws-builder\\README.md" }).ok, true);
});

test("a path that climbs out of the workspace is denied and names the fragment", () => {
	const r = decide("read", { path: "../../tasks/glob/oracle/glob.test.mjs" });
	assert.equal(r.ok, false);
	assert.match(r.reason, /workspace/);
	assert.equal(r.fragment, "../../tasks/glob/oracle/glob.test.mjs");
});

test("an absolute path outside the workspace is denied", () => {
	assert.equal(decide("read", { path: "C:/work/runs/2026-09-11T20-14-14/sessions/x.jsonl" }).ok, false);
	assert.equal(decide("write", { path: "C:\\Users\\me\\AppData\\Local\\Temp\\chk.mjs" }).ok, false);
});

test("the workspace's own .pi directory is protected", () => {
	assert.equal(decide("read", { path: ".pi/agents/worker.md" }).ok, false);
	assert.equal(decide("ls", { path: ".pi" }).ok, false);
	assert.equal(decide("read", { path: "C:/work/runs/.ws-run/ws-builder/.pi/subagents.json" }).ok, false);
});

test("a directory tool with no path defaults to the workspace and is allowed", () => {
	assert.deepEqual(decide("ls", {}), { ok: true });
	assert.deepEqual(decide("grep", { pattern: "x" }), { ok: true });
	assert.deepEqual(decide("find", { pattern: "*.mjs" }), { ok: true });
});

test("a sibling directory that merely shares the root's prefix is outside", () => {
	assert.equal(decide("read", { path: "C:/work/runs/.ws-run/ws-builder-other/x" }).ok, false);
});

test("tools without paths are allowed untouched", () => {
	assert.deepEqual(decide("send_mail", { to: "critic", kind: "status", body: "hi" }), { ok: true });
	assert.deepEqual(decide("subagent", { prompt: "x" }), { ok: true });
});

test("bash: workspace-relative commands are allowed", () => {
	assert.equal(decide("bash", { command: "node --test src/glob.test.mjs" }).ok, true);
	assert.equal(decide("bash", { command: "cd src && node -e \"import('./glob.mjs')\"" }).ok, true);
	assert.equal(decide("bash", { command: "node C:/work/runs/.ws-run/ws-builder/src/glob.mjs" }).ok, true);
	assert.equal(decide("bash", { command: "cd \"C:/work/runs/.ws-run/ws-builder\" && git status" }).ok, true);
});

test("bash: an absolute path outside the workspace is denied with the fragment", () => {
	const r = decide("bash", { command: "cd C:/Users/me/AppData/Local/Temp && node chk.mjs" });
	assert.equal(r.ok, false);
	assert.equal(r.fragment, "C:/Users/me/AppData/Local/Temp");
	assert.equal(decide("bash", { command: "cat 'C:\\work\\tasks\\glob\\oracle\\glob.test.mjs'" }).ok, false);
});

test("bash: climbing with .. is denied", () => {
	assert.equal(decide("bash", { command: "cat ../../tasks/glob/oracle/glob.test.mjs" }).ok, false);
	assert.equal(decide("bash", { command: "cd .. && ls" }).ok, false);
});

test("bash: POSIX-style absolute, home and temp references are denied", () => {
	assert.equal(decide("bash", { command: "ls /c/Users/me/.pi" }).ok, false);
	assert.equal(decide("bash", { command: "cat ~/.pi/agent/auth.json" }).ok, false);
	assert.equal(decide("bash", { command: "cd %TEMP% && node x.mjs" }).ok, false);
	assert.equal(decide("bash", { command: "cd $TMP && node x.mjs" }).ok, false);
	assert.equal(decide("bash", { command: "ls /tmp" }).ok, false);
});

test("bash: the workspace's .pi directory is protected too", () => {
	assert.equal(decide("bash", { command: "cat .pi/agents/worker.md" }).ok, false);
});

test("bash: /dev/null redirects and glob paths inside the workspace are not escapes (found live: a research worker was denied 4 times)", () => {
	assert.equal(decide("bash", { command: "grep -c silent_turn runs/*/audit.jsonl 2>/dev/null" }).ok, true);
	assert.equal(decide("bash", { command: "ls runs/*/summary.json | head; cat runs/2026-09-10T01-58-05/audit.jsonl > /dev/null" }).ok, true);
	assert.equal(decide("bash", { command: "node -e 'x' < /dev/null" }).ok, true);
	assert.equal(decide("bash", { command: "cat /dev/../etc/passwd" }).ok, false);
	assert.equal(decide("bash", { command: "cat /etc/passwd" }).ok, false);
});

// Path guard v2 — from review-guard run 2026-09-12T08-24-41 (R1–R7) and the three
// false positives the night batch exposed (path-like data in command arguments).
test("v2 bash: a `..` that resolves inside the workspace is allowed, one that escapes is denied", () => {
	assert.equal(decide("bash", { command: "node -e 'console.log(normalize(\"a/../b\"))'" }).ok, true, "quoted data that stays inside");
	assert.equal(decide("bash", { command: "cd src && cat ../README.md" }).ok, true, "cd src then .. is the root");
	assert.equal(decide("bash", { command: "cd src/lib; cat ../../README.md" }).ok, true);
	assert.equal(decide("bash", { command: "cd src && cat ../../README.md" }).ok, false, "climbs above the root");
	assert.equal(decide("bash", { command: "cat ../../tasks/glob/oracle/glob.test.mjs" }).ok, false);
	assert.equal(decide("bash", { command: "cd .. && ls" }).ok, false);
});

test("v2 bash: POSIX-absolute fragments are denied only when they exist on disk; path-like data is not a path", () => {
	assert.equal(decide("bash", { command: "node -e 'apply(doc, [{op:\"add\", path:\"/a/c\", value:1}])'" }).ok, true, "/a/c is a JSON pointer, not a place");
	assert.equal(decide("bash", { command: "node -e 'render(\"{{#items}}x{{/items}}\", d)'" }).ok, true);
	assert.equal(decide("bash", { command: "ls /" }).ok, false, "R2: the root");
	assert.equal(decide("bash", { command: "find / -name oracle" }).ok, false);
	assert.equal(decide("bash", { command: "cat /c/Users/x" }).ok, false, "msys drive path");
	assert.equal(decide("bash", { command: "cat ~/.pi/agent/auth.json" }).ok, false);
});

// Case 5 of docs/batch/harness-text-audit-2026-09-17.md: a path-string task writes "..",
// "/" and "/c/d" as data, and judging them as filesystem targets denied the tester's
// independent re-derivation of relative() twice, killing the one mechanical check that
// would have caught the bug. A literal inside an -e body is data UNLESS it resolves to
// something that really exists and really is out of bounds.
test("v3 bash: a node -e literal is data unless it names an existing place out of bounds", () => {
	// A real workspace with a real forbidden sibling: tasks/pathnorm/oracle is exactly what
	// the in-band guard exists to keep out of reach.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-eval-"));
	const root = path.join(dir, "ws-builder");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(dir, "tasks", "pathnorm", "oracle"), { recursive: true });
	fs.writeFileSync(path.join(dir, "tasks", "pathnorm", "oracle", "run.mjs"), "// hidden\n");
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "agents", "worker.md"), "# worker\n");
	const ev = (command) => decidePath({ root, tool: "bash", input: { command } });

	// The tester's real denied command: semicolons inside the body (the segment splitter is
	// not quote-aware, so the body must be masked before the split), "..", "/" and "/c/d".
	const tester = `node -e "const segs = (s) => s.split('/').filter((x) => x && x !== '.'); console.log(segs('..'), segs('/c/d'), rel('..', '/c/d'))" --timeout 20`;
	assert.equal(ev(tester).ok, true);
	assert.equal(ev(`node --input-type=module -e 'console.log(relative(".", "a"), relative("/c/d", "/c"))'`).ok, true);
	assert.equal(ev(`node -p "isAbsolute('/'); dirname('../a')"`).ok, true);
	// The six degenerate literals, each of which resolves somewhere that exists (the
	// filesystem root, the workspace's parent) while naming nothing.
	for (const lit of ["/", "\\\\", ".", "..", "./", "../"]) {
		assert.equal(ev(`node -e 'normalize("${lit}")'`).ok, true, `literal ${lit}`);
	}
	// Nothing at "../x", so it is data — including when the body really would read it.
	assert.equal(ev(`node -e "console.log(readFileSync('../x', 'utf8'))"`).ok, true);
	assert.equal(ev(`node -e 'join("../a", "a/../b")'`).ok, true);

	// An existing sibling outside the workspace is judged as a path, exactly as before.
	const oracle = ev(`node -e "console.log(readFileSync('../tasks/pathnorm/oracle/run.mjs', 'utf8'))"`);
	assert.equal(oracle.ok, false, "an existing file outside the workspace is not data");
	assert.equal(oracle.fragment, "../tasks/pathnorm/oracle/run.mjs");
	assert.equal(ev(`node -e 'readdirSync("../tasks/pathnorm/oracle")'`).ok, false, "the directory too");
	assert.equal(ev(`node -e 'readFileSync(".pi/agents/worker.md")'`).ok, false, "supervisor-owned, though inside");
	// Existence is checked against the real disk at decision time: a name with nothing
	// behind it is data until something is there.
	assert.equal(ev(`node -e 'readdirSync("../sibling")'`).ok, true);
	fs.mkdirSync(path.join(dir, "sibling"));
	assert.equal(ev(`node -e 'readdirSync("../sibling")'`).ok, false, "the same literal, once the directory is there");

	// The hidden directory's own names are judged whatever is on disk. This closes the
	// concatenation that a blanked ".." used to block by accident, and it is needed because
	// a POSIX-absolute fragment that does not exist is deliberately read as path-like data.
	assert.equal(ev(`node -e 'const p = ".." + "/tasks/pathnorm/oracle"; readdirSync(p)'`).ok, false, "assembled from two literals");
	assert.equal(ev(`node -e 'readdirSync("/tasks/pathnorm/oracle")'`).ok, false, "absolute and non-existent");
	assert.equal(ev(`node -e 'readFileSync("../TASKS/Pathnorm/Oracle/run.mjs")'`).ok, false, "case-insensitive");
	assert.equal(ev(`node -e 'readdirSync("../tasks/glob/oracle")'`).ok, false, "nothing there, refused on the name alone");
	// A workspace path that merely contains the word is still data.
	assert.equal(ev(`node -e 'readFileSync("src/tasks/todo.json")'`).ok, true);
	// Documented limit: full runtime assembly passes, because each literal is harmless on
	// its own — "tasks" and "oracle" both resolve inside the workspace. Only a sandbox
	// closes that one.
	assert.equal(ev(`node -e 'readdirSync(["..","tasks","pathnorm","oracle"].join("/"))'`).ok, true);

	// Everything outside the body is judged as before.
	assert.equal(ev("cat ../secret").ok, false);
	assert.equal(ev(`node -e "segs('..')" && cat ../tasks/pathnorm/oracle/run.mjs`).ok, false);
	assert.equal(ev(`cd ..; node -e "segs('..')"`).ok, false);
	assert.equal(ev(`node -e "segs('..')" > /c/Users/me/out.txt`).ok, false);
	// Not an -e body: -e belonging to another command is left alone.
	assert.equal(ev(`grep -e "../../tasks" src/*.mjs`).ok, false);
	fs.rmSync(dir, { recursive: true, force: true });
});

// Review C1: three ways the mask was defeated, each of which read the oracle, .pi or a file
// outside the workspace, and each denied before this guard grew a mask. Two root causes —
// NODE_EVAL matching `node … -e "` anywhere rather than in command position, and BODY_STRING
// not recognising a shell-escaped `\"…\"` literal, which then fell into the "code between
// literals" branch and was blanked without ever reaching judgeLiteral.
test("v3 bash: only a node in command position opens a body, and an escaped literal is still a literal", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-mask-"));
	const taskDir = path.join(dir, "tasks", "pathnorm");
	const root = path.join(taskDir, "ws-builder");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "oracle"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "oracle", "run.mjs"), "// hidden\n");
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "agents", "worker.md"), "# worker\n");
	fs.writeFileSync(path.join(dir, "secret.txt"), "s\n");
	const ev = (command) => decidePath({ root, tool: "bash", input: { command } });

	// A `\"…\"` literal is how a double-quoted body carries a string at all.
	assert.equal(ev(`node -e "require('fs').readFileSync(\\"../oracle/run.mjs\\")"`).ok, false, "escaped literal, oracle");
	assert.equal(ev(`node -e "require('fs').readFileSync(\\".pi/agents/worker.md\\")"`).ok, false, "escaped literal, .pi");
	// An inner escape must be carried, not dropped back into the blanked branch.
	assert.equal(ev(`node -e "readFileSync(\\"../oracle\\tmp/run.mjs\\")"`).ok, false, "escaped literal with an inner escape");
	// `-e` is a real cat/head flag, so these are commands, not bodies.
	assert.equal(ev(`cat node -e "../oracle/run.mjs"`).ok, false, "cat, not node");
	assert.equal(ev(`head -20 node -e "../../../secret.txt"`).ok, false, "head, not node");
	// The fake body ran to the quote in the last echo and swallowed the real cat between them.
	assert.equal(ev(`echo "node -e '" ; cat ../oracle/run.mjs ; echo "'"`).ok, false, "a fake body must not hide a real path");

	// The wrapper allowance: roster/implementer.md asks for an explicit timeout, so these
	// bodies must still be masked or the degenerate literals are denied all over again.
	for (const cmd of [
		`timeout 30 node -e 'console.log(relative(".", "a"), segs("/"), segs(".."))'`,
		`timeout -k 5 30 node -e 'segs("..")'`,
		`env FOO=1 node -e 'segs("/")'`,
		`nice node -e 'segs("..")'`,
		`FOO=1 node -e 'segs("..")'`,
		`cd src && timeout 30 node -e 'segs("..")'`,
	]) {
		assert.equal(ev(cmd).ok, true, cmd);
	}
	// A wrapper cannot smuggle a path of its own: everything before the opening quote is
	// still judged normally.
	assert.equal(ev(`timeout ../oracle/run.mjs node -e "x"`).ok, false, "the wrapper's own argument");
	fs.rmSync(dir, { recursive: true, force: true });
});

test("v3 bash: the node -e existence check is injectable and decides both branches", () => {
	const root = path.resolve("C:/work/runs/.ws-run/ws-builder");
	const outside = path.resolve("C:/work/runs/.ws-run/secrets");
	// A literal the name rule does not reach, so the verdict turns purely on existence.
	const cmd = `node -e 'readdirSync("../secrets")'`;
	assert.equal(decidePath({ root, tool: "bash", input: { command: cmd }, exists: () => false }).ok, true);
	const denied = decidePath({ root, tool: "bash", input: { command: cmd }, exists: (p) => path.resolve(p) === outside });
	assert.equal(denied.ok, false);
	assert.equal(denied.fragment, "../secrets");
	// The name rule never consults exists.
	const byName = decidePath({ root, tool: "bash", input: { command: `node -e 'readdirSync(".." + "/tasks/pathnorm/oracle")'` }, exists: () => false });
	assert.equal(byName.ok, false);
	assert.equal(byName.fragment, "/tasks/pathnorm/oracle");
	// An existence oracle that says yes to everything must still pass the degenerate
	// literals, or the tester's command breaks again.
	assert.equal(decidePath({ root, tool: "bash", input: { command: `node -e 'relative(".", "..")'` }, exists: () => true }).ok, true);
});

test("v2 bash: the protected .pi directory — case-insensitive, and globs that can name it", () => {
	assert.equal(decide("bash", { command: "cat .PI/agents/worker.md" }).ok, false, "R1");
	assert.equal(decide("bash", { command: "ls .pi*" }).ok, false, "R7");
	assert.equal(decide("bash", { command: "ls .p?" }).ok, false);
	assert.equal(decide("bash", { command: "ls .[pi]i" }).ok, false);
	assert.equal(decide("bash", { command: "cat src/.pinned" }).ok, true, "a file whose name merely starts with .pi");
});

test("v2 bash: UNC paths and any env-var indirection into a path are denied", () => {
	assert.equal(decide("bash", { command: "type \\\\server\\share\\flag.txt" }).ok, false, "R3");
	assert.equal(decide("bash", { command: "cat //server/share/flag.txt" }).ok, false);
	assert.equal(decide("bash", { command: "type %USERNAME%\\Desktop\\note.txt" }).ok, false, "R4");
	assert.equal(decide("bash", { command: "cat $HOMEDRIVE$HOMEPATH/x" }).ok, false);
	assert.equal(decide("bash", { command: "cat $env:WINDIR\\x" }).ok, false);
	assert.equal(decide("bash", { command: "echo $PATH" }).ok, true, "an env var not used as a path");
});

test("bash: a dot-dot inside a version range is not a path segment", () => {
	assert.equal(decide("bash", { command: "npm view foo@1..2" }).ok, true);
});

test("v3 bash: a bare `/` is a place only after a filesystem command — division inside a one-liner is not (R10, seen live in dw-explore)", () => {
	assert.equal(decide("bash", { command: 'uv run python -c "print(round(100.0 * sum(a) / sum(b), 1))"' }).ok, true);
	assert.equal(decide("bash", { command: "echo $((a / b))" }).ok, true);
	assert.equal(decide("bash", { command: "ls /" }).ok, false);
	assert.equal(decide("bash", { command: "find / -name secret" }).ok, false);
	assert.equal(decide("bash", { command: "rm -rf /" }).ok, false);
});

test("v3 bash: a variable the command line binds itself is not env indirection (R9, seen live in every dw-bronze run)", () => {
	assert.equal(decide("bash", { command: "for s in tx nm ok; do ls remote/$s/arcgis; done" }).ok, true);
	assert.equal(decide("bash", { command: "s=tx; ls remote/$s/mft && cat remote/${s}/x" }).ok, true);
	assert.equal(decide("bash", { command: "for d in a b; do cd remote/$d && ls; done" }).ok, true);
	assert.equal(decide("bash", { command: "cat $HOMEDRIVE$HOMEPATH/x" }).ok, false);
	assert.equal(decide("bash", { command: "ls $UNBOUND/x" }).ok, false);
});

test("memory store paths are refused through every route (retrieval goes through the tools)", () => {
	const root = "C:/Users/x/arbiter/runs/.ws-1/ws-builder";
	const cases = [
		["read", { path: "C:/Users/x/arbiter/memory/records.jsonl" }],
		["bash", { command: "cat C:/Users/x/arbiter/memory/records.jsonl" }],
		["bash", { command: "cat ../../memory/records.jsonl" }],
		["bash", { command: "cat $ARBITER_HOME/memory/records.jsonl" }],
		["read", { path: "../../memory/index/abc.sqlite" }],
	];
	for (const [tool, input] of cases) assert.equal(decidePath({ root, tool, input }).ok, false, `${tool} ${JSON.stringify(input)}`);
});
