// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch } from "./src/glob.mjs";

const cases = [
	// basics
	["*.js", "a.js", true],
	["*.js", "a/b.js", false],
	["a?c", "abc", true],
	["a?c", "a/c", false],
	["a?c", "ac", false],
	["a/b", "a/b", true],
	["a/*", "a/b/c", false],
	["a/*/c", "a/b/c", true],
	["A", "a", false],
	["", "", true],
	["", "a", false],
	// globstar
	["**/*.js", "a/b/c.js", true],
	["**/*.js", "c.js", true],
	["a/**/b", "a/b", true],
	["a/**/b", "a/x/y/b", true],
	["a/**", "a", true],
	["a/**", "a/x/y", true],
	["a/**", "b/x", false],
	["**", "a/b", true],
	["**", "", true],
	["a**b", "axxb", true],
	["a**b", "ax/xb", false],
	// classes
	["[abc].txt", "b.txt", true],
	["[abc].txt", "d.txt", false],
	["[a-c]x", "bx", true],
	["[!abc]", "d", true],
	["[!abc]", "a", false],
	["[]a]", "]", true],
	["[]a]", "a", true],
	["[!]a]", "b", true],
	["[!]a]", "]", false],
	["a[/]b", "a/b", false],
	["a[!x]b", "a/b", false],
	// braces
	["*.{js,ts}", "a.ts", true],
	["*.{js,ts}", "a.rs", false],
	["a{,.txt}", "a", true],
	["a{,.txt}", "a.txt", true],
	["{a,b{c,d}}", "bd", true],
	["{a,b{c,d}}", "bc", true],
	["{a,b{c,d}}", "b", false],
	["a}b", "a}b", true],
	["a,b", "a,b", true],
	// escapes
	["\\*", "*", true],
	["\\*", "a", false],
	["a\\[b", "a[b", true],
	["a\\{b", "a{b", true],
	// dotfiles
	["*", ".env", false],
	[".*", ".env", true],
	["?env", ".env", false],
	["**/*", ".git/x", false],
	["**", ".a/b", false],
	["src/**/*.js", "src/.hidden/a.js", false],
	["src/**/*.js", "src/lib/a.js", true],
	["[.]env", ".env", false],
	// non-string path
	["*", 42, false],
];

for (const [pattern, path, expected] of cases) {
	test(`globMatch(${JSON.stringify(pattern)}, ${JSON.stringify(path)}) === ${expected}`, () => {
		assert.equal(globMatch(pattern, path), expected);
	});
}

const bad = ["[abc", "{a,b", "abc\\", 42];
for (const pattern of bad) {
	test(`rejects ${JSON.stringify(pattern)}`, () => {
		assert.throws(
			() => globMatch(pattern, "x"),
			(err) => err instanceof SyntaxError && /^invalid glob/.test(err.message),
		);
	});
}
