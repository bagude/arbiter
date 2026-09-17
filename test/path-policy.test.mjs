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

	// Re-review C3: a wrapper argument may be option-like, a duration or an assignment, never
	// a bare word. A bare word is a command NAME, and accepting one handed the body straight
	// back to it — `cat -e` and `head -e` are real flags, so each of these printed the file.
	assert.equal(ev(`time cat node -e "../oracle/run.mjs"`).ok, false, "time cat");
	assert.equal(ev(`timeout 30 cat node -e "../oracle/run.mjs"`).ok, false, "timeout cat");
	assert.equal(ev(`env cat node -e "../../../secret.txt"`).ok, false, "env cat");
	assert.equal(ev(`nice head node -e "../../../secret.txt"`).ok, false, "nice head");

	// The wrapper allowance: roster/implementer.md asks for an explicit timeout, so these
	// bodies must still be masked or the degenerate literals are denied all over again.
	for (const cmd of [
		`timeout 30 node -e 'console.log(relative(".", "a"), segs("/"), segs(".."))'`,
		`timeout 30.5 node -e 'segs("..")'`,
		`timeout 30s node -e 'segs("..")'`,
		`timeout -k 5 30 node -e 'segs("..")'`,
		`env FOO=1 node -e 'segs("/")'`,
		`nice node -e 'segs("..")'`,
		`nice -n 10 node -e 'segs("..")'`,
		`stdbuf -o0 node -e 'segs("..")'`,
		`FOO=1 node -e 'segs("..")'`,
		`cd src && timeout 30 node -e 'segs("..")'`,
		// M6: the joined equals form and a backticked substitution are masked too.
		`node --eval='segs("..")'`,
		`node --print='segs("..")'`,
		"echo `node -e 'segs(\"..\")'`",
		`echo $(node -e 'segs("..")')`,
		`echo x | node -e 'segs("..")'`,
	]) {
		assert.equal(ev(cmd).ok, true, cmd);
	}
	// A wrapper cannot smuggle a path of its own: everything before the opening quote is
	// still judged normally.
	assert.equal(ev(`timeout ../oracle/run.mjs node -e "x"`).ok, false, "the wrapper's own argument");
	assert.equal(ev(`env FOO=../oracle node -e "x"`).ok, false, "the wrapper's own assignment");
	// M6, documented and fail-closed: ANSI-C quoting is not masked, so its degenerate literal
	// is judged as a raw fragment and denied. A false positive, never an escape — its
	// shell-level escapes are a second decoding layer the policy does not model.
	assert.equal(ev(`node -e $'segs("..")'`).ok, false, "ANSI-C quoting stays unmasked, and fails closed");
	fs.rmSync(dir, { recursive: true, force: true });
});

// Re-review C2: judgeLiteral read the literal's SOURCE text, but node opens its VALUE.
// Every escape that changes a character defeated the name check and the existence check at
// once, and each of these was denied before this guard grew a mask. Not the documented
// runtime-assembly residual: one literal spells the whole path and the guard sees all of it.
test("v3 bash: a literal is judged by its decoded value, not only its source text", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-escape-"));
	const taskDir = path.join(dir, "tasks", "pathnorm");
	const root = path.join(taskDir, "ws-builder");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "oracle"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "oracle", "run.mjs"), "// hidden\n");
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "agents", "worker.md"), "# worker\n");
	fs.writeFileSync(path.join(dir, "secret.txt"), "s\n");
	const ev = (command) => decidePath({ root, tool: "bash", input: { command } });
	const B = "\\"; // one backslash, as bash hands it to node

	// Every spelling below decodes to a path the guard must refuse.
	for (const [why, body] of [
		["\\uXXXX", `readFileSync('../${B}u006fracle/run.mjs')`],
		["an unrecognised escape just drops its backslash", `readFileSync('../ora${B}cle/run.mjs')`],
		["\\xXX", `readFileSync('../${B}x6fracle/run.mjs')`],
		["\\u{...}", `readFileSync('../${B}u{6f}racle/run.mjs')`],
		["legacy octal, live in the sloppy mode node -e runs in", `readFileSync('../${B}157racle/run.mjs')`],
		["a template literal", "readFileSync(`../" + B + "u006fracle/run.mjs`)"],
		["an escaped .pi", `readFileSync('.${B}u0070i/agents/worker.md')`],
		["a file outside the workspace", `readFileSync('../../../sec${B}u0072et.txt')`],
	]) {
		assert.equal(ev(`node -e "${body}"`).ok, false, why);
	}

	// The collapsed source spelling still has to be judged: `\\\\` is the pathnorm degenerate
	// input, and as raw source it resolves to the drive root, which exists and is outside the
	// workspace. Judging the decoded value alone would deny it.
	assert.equal(ev(`node -e 'normalize("${B}${B}")'`).ok, true, "the backslash degenerate input");
	assert.equal(ev(`node -e 'join(".", "..", "./", "../", "/")'`).ok, true, "the separator-only literals");
	// Escapes that decode to something harmless stay data.
	assert.equal(ev(`node -e "split('a${B}tb')"`).ok, true, "a tab escape");
	assert.equal(ev(`node -e 'format("cost: $5")'`).ok, true, "literal dollar text");
	assert.equal(ev(`node -e 'readFileSync("src/tasks/todo.json")'`).ok, true, "inside the workspace");
	fs.rmSync(dir, { recursive: true, force: true });
});

// The invariant, round 3: a span the matcher does not recognise is JUDGED, never erased.
// Blanking an unrecognised span is fail-open, and three review rounds found three faces of
// that one mistake. A backslash before a line terminator makes BODY_STRING miss the literal
// entirely, so it fell into the code branch and was blanked — reading the oracle.
test("v3 bash: an unrecognised span is judged, not erased", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-span-"));
	const taskDir = path.join(dir, "tasks", "pathnorm");
	const root = path.join(taskDir, "ws-builder");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "oracle"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "oracle", "run.mjs"), "// hidden\n");
	const ev = (command) => decidePath({ root, tool: "bash", input: { command } });
	const B = "\\";
	const NL = "\n";

	// A literal BODY_STRING cannot match still has its path judged.
	assert.equal(ev(`node -e 'readFileSync("../ora${B}${NL}cle/run.mjs")'`).ok, false, "line continuation, double-quoted literal");
	assert.equal(ev(`node -e "readFileSync('../ora${B}${NL}cle/run.mjs')"`).ok, false, "line continuation, single-quoted literal");
	assert.equal(ev(`node -e "const p = '../oracle/run.mjs';${NL}readFileSync(p)"`).ok, false, "a plain newline in the body");
	assert.equal(ev("node -e 'readFileSync(String.raw`../oracle/run.mjs`)'").ok, false, "a tagged template");
	assert.equal(ev(`node -e 'readFileSync(${B}'../oracle/run.mjs${B}')'`).ok, false, "a same-quote escape the matcher misses");

	// And the twelve one-liners a worker would actually write all still pass. A code span is
	// judged, so this is where a fail-closed default would show up as a false positive.
	for (const cmd of [
		`node -e 'console.log(s.replace(/${B}/+/g, "/"))'`,
		`node -e 'console.log(sum(a) / sum(b))'`,
		`node -e 'fetch("https://example.com/a/b")'`,
		`node -e 'normalize("a/b") // see src/pathnorm.mjs'`,
		`node -e 'const f = (a, b) => a > b ? a / b : b / a; console.log(f(1, 2))'`,
		`node -e "import('./src/pathnorm.mjs').then(m => console.log(m.normalize('a//b')))"`,
		`node -e 'apply(doc, [{op:"add", path:"/a/c", value:1}])'`,
		`node -e 'render("{{#items}}x{{/items}}", d)'`,
		`node -e "const segs = (s) => s.split('/').filter((x) => x && x !== '.'); console.log(segs('..'), segs('/c/d'), rel('..', '/c/d'))"`,
		`node -e 'require("../ws-builder/src/pathnorm.mjs")'`,
		`node -e 'console.log(1..toString())'`,
		`node -e 'const f = (...xs) => xs.join("/"); console.log(f("a","b"))'`,
	]) {
		assert.equal(ev(cmd).ok, true, cmd);
	}
	// A run of separators is the same degenerate input as a lone one: `//` resolves to the
	// drive root, exactly as `/` does, and is also how a line comment starts.
	assert.equal(ev(`node -e 'x("//", "${B}${B}", "/")'`).ok, true, "separator runs are data");
	fs.rmSync(dir, { recursive: true, force: true });
});

// The invariant, round 4: a template literal carrying a ${...} substitution is CODE, not one
// path string. BODY_STRING matched it whole, so the braces glued onto the following ".." and
// the span resolved back INSIDE the workspace, while a substitution placed inside the name
// split it. The value node opens is the path either way.
test("v3 bash: a template substitution does not hide a path", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "path-policy-tmpl-"));
	const taskDir = path.join(dir, "tasks", "pathnorm");
	const root = path.join(taskDir, "ws-builder");
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.mkdirSync(path.join(taskDir, "oracle"), { recursive: true });
	fs.writeFileSync(path.join(taskDir, "oracle", "run.mjs"), "// hidden\n");
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "agents", "worker.md"), "# worker\n");
	fs.writeFileSync(path.join(dir, "secret.txt"), "s\n");
	const ev = (command) => decidePath({ root, tool: "bash", input: { command } });
	const T = String.fromCharCode(96); // a backtick, so this file can hold template bodies
	const B = "\\";

	// The substitution is the whole path, or junk in front of it.
	assert.equal(ev(`node -e 'readFileSync(${T}\${"../oracle/run.mjs"}${T})'`).ok, false, "T2 the substitution is the path");
	assert.equal(ev(`node -e 'readFileSync(${T}\${""}../oracle/run.mjs${T})'`).ok, false, "T1 junk prefix");
	assert.equal(ev(`node -e 'readFileSync(${T}\${""}.pi/agents/worker.md${T})'`).ok, false, "T3 .pi");
	assert.equal(ev(`node -e 'readFileSync(${T}\${""}../../../secret.txt${T})'`).ok, false, "T4 outside the workspace");
	// The substitution splits the name, so no piece spells anything out of bounds.
	assert.equal(ev(`node -e 'readFileSync(${T}../ora\${""}cle/run.mjs${T})'`).ok, false, "S1 split name");
	assert.equal(ev(`node -e 'readFileSync(${T}.\${""}./oracle/run.mjs${T})'`).ok, false, "S2 split dots");
	// A split name AND an escape spelling one of its characters is one shape, not two: the
	// elided spelling is judged in both spellings, like every other literal.
	assert.equal(ev(`node -e 'readFileSync(${T}../ora\${""}${B}u0063le/run.mjs${T})'`).ok, false, "split name plus an escape");

	// Templates without a substitution keep their existing verdicts.
	assert.equal(ev(`node -e 'readFileSync(${T}../oracle/run.mjs${T})'`).ok, false, "a plain template still denies");
	assert.equal(ev("node -e 'readFileSync(String.raw`../oracle/run.mjs`)'").ok, false, "String.raw still denies");
	assert.equal(ev(`node -e 'readFileSync(${T}src/pathnorm.mjs${T})'`).ok, true, "a workspace path is still data");
	assert.equal(ev(`node -e 'join(${T}a${T}, ${T}b${T})'`).ok, true, "template data is still data");
	// Documented residual, unchanged: a substitution computed at runtime is not recoverable
	// from the literal's own text. Only a sandbox closes that.
	assert.equal(ev(`node -e 'const d = f(); readFileSync(${T}\${d}oracle/run.mjs${T})'`).ok, true, "runtime assembly inside a template");
	// Pre-existing and NOT introduced here (review M7, verified identical at d02524e): a
	// substitution followed by a separator reads as shell env indirection, so this denies
	// although it opens nothing. Pinned so the status is recorded rather than drifting.
	assert.equal(ev(`node -e 'const d = f(); readFileSync(${T}\${d}/run.mjs${T})'`).ok, false, "M7, pre-existing");
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
