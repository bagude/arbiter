import { test } from "node:test";
import assert from "node:assert/strict";
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
