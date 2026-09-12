// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { normalize, join, relative, isAbsolute, dirname, basename } from "./src/pathnorm.mjs";

const fns = { normalize, join, relative, isAbsolute, dirname, basename };

const cases = [
	// normalize
	["normalize", [""], "."],
	["normalize", ["."], "."],
	["normalize", [".."], ".."],
	["normalize", ["/"], "/"],
	["normalize", ["//"], "/"],
	["normalize", ["a"], "a"],
	["normalize", ["a/"], "a"],
	["normalize", ["a//b"], "a/b"],
	["normalize", ["a/./b"], "a/b"],
	["normalize", ["./a"], "a"],
	["normalize", ["a/b/../c"], "a/c"],
	["normalize", ["a/../../b"], "../b"],
	["normalize", ["../../a"], "../../a"],
	["normalize", ["/.."], "/"],
	["normalize", ["/a/../../b"], "/b"],
	["normalize", ["a/./b//c/"], "a/b/c"],
	["normalize", ["a/.."], "."],
	["normalize", [".env"], ".env"],
	["normalize", ["//a"], "/a"],
	["normalize", ["a/b/"], "a/b"],
	// join
	["join", [], "."],
	["join", ["a", "b"], "a/b"],
	["join", ["a/", "/b"], "a/b"],
	["join", ["a", "", "b"], "a/b"],
	["join", ["/a", "b", "../c"], "/a/c"],
	["join", ["..", "a"], "../a"],
	// relative
	["relative", ["/a/b", "/a/b/c"], "c"],
	["relative", ["/a/b/c", "/a/b"], ".."],
	["relative", ["/a/b", "/c/d"], "../../c/d"],
	["relative", ["a", "a/b"], "b"],
	["relative", ["a/b", "a"], ".."],
	["relative", ["/a", "/a"], "."],
	["relative", ["a", "a"], "."],
	["relative", ["..", "../a"], "a"],
	["relative", ["../a", ".."], ".."],
	["relative", ["/a/b/c", "/a/x/y"], "../../x/y"],
	["relative", [".", "a"], "a"],
	["relative", ["a", "."], ".."],
	// isAbsolute
	["isAbsolute", ["/a"], true],
	["isAbsolute", ["a"], false],
	["isAbsolute", ["../a"], false],
	["isAbsolute", ["/a/.."], true],
	["isAbsolute", [""], false],
	// dirname
	["dirname", ["/"], "/"],
	["dirname", ["a"], "."],
	["dirname", ["."], "."],
	["dirname", [".."], "."],
	["dirname", ["/a"], "/"],
	["dirname", ["/a/b"], "/a"],
	["dirname", ["a/b"], "a"],
	["dirname", ["../a"], ".."],
	// basename
	["basename", ["/"], ""],
	["basename", ["."], "."],
	["basename", ["a"], "a"],
	["basename", ["/a/b.txt"], "b.txt"],
	["basename", ["a/../b"], "b"],
	["basename", ["a/b.txt", ".txt"], "b"],
	["basename", [".txt", ".txt"], ".txt"],
	["basename", ["a/b.txt", ".md"], "b.txt"],
];

for (const [fn, args, expected] of cases) {
	test(`${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}) === ${JSON.stringify(expected)}`, () => {
		assert.deepEqual(fns[fn](...args), expected);
	});
}

const typeErrors = [
	["normalize", [42]],
	["join", ["a", 5]],
	["relative", [5, "a"]],
	["relative", ["a", {}]],
	["isAbsolute", [null]],
	["dirname", [undefined]],
	["basename", [42]],
	["basename", ["a", 5]],
];

for (const [fn, args] of typeErrors) {
	test(`${fn}(${args.map((a) => JSON.stringify(a)).join(", ")}) throws path must be a string`, () => {
		assert.throws(
			() => fns[fn](...args),
			(err) => err instanceof TypeError && /^path must be a string/.test(err.message),
		);
	});
}

const mixedErrors = [
	["/a", "b"],
	["a", "/b"],
];

for (const [from, to] of mixedErrors) {
	test(`relative(${JSON.stringify(from)}, ${JSON.stringify(to)}) throws mixed absolute and relative`, () => {
		assert.throws(
			() => relative(from, to),
			(err) => err instanceof TypeError && /^mixed absolute and relative/.test(err.message),
		);
	});
}

test("does not import node:path", () => {
	const src = fs.readFileSync(new URL("./src/pathnorm.mjs", import.meta.url), "utf8");
	assert.equal(/from\s+["']node:path["']|from\s+["']path["']|require\(\s*["'](node:)?path["']\s*\)/.test(src), false);
});
