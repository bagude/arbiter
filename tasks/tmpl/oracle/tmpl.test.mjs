// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "./src/tmpl.mjs";

const cases = [
	// plain text / no tags
	["hello", {}, "hello"],
	["", {}, ""],
	// escaped interpolation
	["{{x}}", { x: "hi" }, "hi"],
	["<{{x}}>", { x: "<b>" }, "<&lt;b&gt;>"],
	["{{x}}", { x: `&<>"'` }, "&amp;&lt;&gt;&quot;&#39;"],
	["{{ x }}", { x: "hi" }, "hi"],
	// raw interpolation
	["{{{x}}}", { x: "<b>" }, "<b>"],
	["{{{x}}}", { x: `&<>"'` }, `&<>"'`],
	// missing / nullish
	["{{missing}}", {}, ""],
	["{{x}}", { x: null }, ""],
	["{{{x}}}", { x: null }, ""],
	// numbers / booleans stringified
	["{{x}}", { x: 42 }, "42"],
	["{{x}}", { x: 0 }, "0"],
	["{{x}}", { x: true }, "true"],
	["{{x}}", { x: false }, "false"],
	// dotted paths
	["{{u.name}}", { u: { name: "Amy" } }, "Amy"],
	["{{u.a.b}}", { u: { a: { b: "deep" } } }, "deep"],
	["{{u.name}}", { u: {} }, ""],
	["{{a.x}}", { a: {}, x: "outer" }, ""], // dotted path does not fall back to outer frame
	// context stack fallback for plain names
	["{{#a}}{{x}}{{/a}}", { a: { y: 1 }, x: "outer" }, "outer"],
	["{{#a}}{{x}}{{/a}}", { a: { x: "inner" }, x: "outer" }, "inner"],
	// current-context tag
	["{{.}}", "hello", "hello"],
	["{{#nums}}{{.}}-{{/nums}}", { nums: [1, 2, 3] }, "1-2-3-"],
	["{{#words}}{{.}}/{{/words}}", { words: ["a", "b"] }, "a/b/"],
	// comments
	["a{{! comment }}b", {}, "ab"],
	["{{! just a comment }}", {}, ""],
	// whitespace preserved
	["a\n{{x}}\nb", { x: "X" }, "a\nX\nb"],
	["{{#a}}\n{{x}}\n{{/a}}", { a: { x: "X" } }, "\nX\n"],
	// sections: array
	["{{#items}}({{.}})/{{/items}}", { items: [1, 2] }, "(1)/(2)/"],
	["{{#items}}x{{/items}}", { items: [] }, ""],
	["{{#users}}{{name}}-{{/users}}", { users: [{ name: "A" }, { name: "B" }] }, "A-B-"],
	// sections: truthy object pushes context
	["{{#a}}{{x}}{{/a}}", { a: { x: 1 } }, "1"],
	// sections: truthy primitive keeps current frame
	["{{#a}}{{x}}{{/a}}", { a: true, x: 1 }, "1"],
	// sections: falsy skip
	["{{#a}}x{{/a}}", { a: false }, ""],
	["{{#a}}x{{/a}}", { a: 0 }, ""],
	["{{#a}}x{{/a}}", { a: "" }, ""],
	["{{#a}}x{{/a}}", { a: [] }, ""],
	["{{#a}}x{{/a}}", {}, ""],
	// inverted sections
	["{{^a}}x{{/a}}", { a: false }, "x"],
	["{{^a}}x{{/a}}", { a: [] }, "x"],
	["{{^a}}x{{/a}}", {}, "x"],
	["{{^a}}x{{/a}}", { a: true }, ""],
	["{{^a}}x{{/a}}", { a: [1] }, ""],
	["{{^a}}{{x}}{{/a}}", { x: "outer" }, "outer"], // context stack unchanged
	// nested sections
	["{{#a}}{{#b}}{{x}}{{/b}}{{/a}}", { a: { b: { x: 1 } } }, "1"],
	["{{#list}}{{#.}}x{{/.}}{{/list}}", { list: [[1], []] }, "x"],
	["{{^a}}{{#b}}{{.}}{{/b}}{{/a}}", { b: [1, 2] }, "12"],
	["{{#a}}{{^b}}y{{/b}}{{/a}}", { a: true, b: false }, "y"],
	["{{#a}}{{^b}}y{{/b}}{{/a}}", { a: true, b: true }, ""],
	// dotted key on section
	["{{#u.active}}yes{{/u.active}}", { u: { active: true } }, "yes"],
	["{{#u.active}}yes{{/u.active}}", { u: { active: false } }, ""],
];

for (const [template, data, expected] of cases) {
	test(`render(${JSON.stringify(template)}, ${JSON.stringify(data)}) === ${JSON.stringify(expected)}`, () => {
		assert.equal(render(template, data), expected);
	});
}

test("{{.}} over an object context stringifies via String()", () => {
	const obj = { toString: () => "obj" };
	assert.equal(render("{{.}}", obj), "obj");
});

test("render(template) with omitted data uses {}", () => {
	assert.equal(render("{{missing}}"), "");
});

test("render(template) with omitted data and a truthy check", () => {
	assert.equal(render("{{^missing}}ok{{/missing}}"), "ok");
});

// errors
test("non-string template throws TypeError", () => {
	assert.throws(
		() => render(42, {}),
		(err) => err instanceof TypeError && /^template must be a string/.test(err.message),
	);
});

test("undefined template throws TypeError", () => {
	assert.throws(
		() => render(undefined, {}),
		(err) => err instanceof TypeError && /^template must be a string/.test(err.message),
	);
});

test("unterminated {{ tag throws SyntaxError", () => {
	assert.throws(
		() => render("hi {{name", {}),
		(err) => err instanceof SyntaxError && /^unterminated tag/.test(err.message),
	);
});

test("unterminated {{{ tag throws SyntaxError", () => {
	assert.throws(
		() => render("hi {{{name}}", {}),
		(err) => err instanceof SyntaxError && /^unterminated tag/.test(err.message),
	);
});

test("unclosed section throws SyntaxError", () => {
	assert.throws(
		() => render("{{#a}}hi", {}),
		(err) => err instanceof SyntaxError && /^unclosed section/.test(err.message),
	);
});

test("unclosed inverted section throws SyntaxError", () => {
	assert.throws(
		() => render("{{^a}}hi", {}),
		(err) => err instanceof SyntaxError && /^unclosed section/.test(err.message),
	);
});

test("close tag with no open section throws SyntaxError", () => {
	assert.throws(
		() => render("{{/a}}", {}),
		(err) => err instanceof SyntaxError && /^unexpected close/.test(err.message),
	);
});

test("close tag after all sections closed throws SyntaxError", () => {
	assert.throws(
		() => render("{{#a}}x{{/a}}{{/b}}", {}),
		(err) => err instanceof SyntaxError && /^unexpected close/.test(err.message),
	);
});

test("mismatched close tag throws SyntaxError", () => {
	assert.throws(
		() => render("{{#a}}hi{{/b}}", {}),
		(err) => err instanceof SyntaxError && /^mismatched close/.test(err.message),
	);
});

test("mismatched close with still-open inner section throws SyntaxError", () => {
	assert.throws(
		() => render("{{#a}}{{#b}}hi{{/a}}", {}),
		(err) => err instanceof SyntaxError && /^mismatched close/.test(err.message),
	);
});
