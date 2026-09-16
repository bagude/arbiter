import { test } from "node:test";
import assert from "node:assert/strict";
import { renderConsole } from "../tools/build-console.mjs";

// Run data is arbitrary transcript text: shell snippets routinely contain `$&`, "$`"
// and `$'`, which are substitution patterns for a string replacement. They must reach
// the page verbatim.
test("run data carrying $ substitution patterns is inserted verbatim", () => {
	const data = '{"a":"x$&y$\'z"}';
	assert.equal(renderConsole("const RUNS = __RUNS_DATA__;", data), 'const RUNS = {"a":"x$&y$\'z"};');
});

test("a backtick pattern does not splice the template's own text into the data", () => {
	const out = renderConsole("HEAD const RUNS = __RUNS_DATA__; TAIL", '{"cmd":"echo `pwd` $`"}');
	assert.equal(out, 'HEAD const RUNS = {"cmd":"echo `pwd` $`"}; TAIL');
	assert.equal(out.match(/HEAD/g).length, 1);
	assert.equal(out.match(/TAIL/g).length, 1);
});

// A transcript that quotes HTML would otherwise end the page's own <script> element.
test("a closing script tag in the data is escaped", () => {
	const out = renderConsole("const RUNS = __RUNS_DATA__;", '{"t":"<script>x</script>"}');
	assert.equal(out, 'const RUNS = {"t":"<script>x<\\/script>"};');
	assert.equal(/<\/script/i.test(out), false);
});

test("only the first token is replaced", () => {
	assert.equal(renderConsole("a __RUNS_DATA__ b __RUNS_DATA__", "X"), "a X b __RUNS_DATA__");
});
