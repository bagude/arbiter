// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCSV, toCSV } from "./src/csv.mjs";

function throwsWith(fn, Ctor, prefix) {
	assert.throws(fn, (err) => {
		assert.ok(err instanceof Ctor, `expected ${Ctor.name}, got ${err && err.constructor && err.constructor.name}`);
		assert.ok(err.message.startsWith(prefix), `expected message to start with ${JSON.stringify(prefix)}, got ${JSON.stringify(err.message)}`);
		return true;
	});
}

// --- parseCSV basics ---

test("empty text yields []", () => {
	assert.deepEqual(parseCSV(""), []);
});

test("single field, no terminator", () => {
	assert.deepEqual(parseCSV("a"), [["a"]]);
});

test("simple row", () => {
	assert.deepEqual(parseCSV("a,b,c"), [["a", "b", "c"]]);
});

test("multiple rows separated by \\n", () => {
	assert.deepEqual(parseCSV("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("trailing \\n does not add an empty record", () => {
	assert.deepEqual(parseCSV("a,b\n"), [["a", "b"]]);
});

test("CRLF terminator", () => {
	assert.deepEqual(parseCSV("a,b\r\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("trailing CRLF does not add an empty record", () => {
	assert.deepEqual(parseCSV("a,b\r\n"), [["a", "b"]]);
});

test("blank line produces an empty record", () => {
	assert.deepEqual(parseCSV("a\n\nb"), [["a"], [""], ["b"]]);
});

test("leading blank line", () => {
	assert.deepEqual(parseCSV("\na"), [[""], ["a"]]);
});

test("text that is just a terminator", () => {
	assert.deepEqual(parseCSV("\n"), [[""]]);
});

test("empty fields between delimiters", () => {
	assert.deepEqual(parseCSV("a,,b"), [["a", "", "b"]]);
});

test("trailing delimiter yields a trailing empty field", () => {
	assert.deepEqual(parseCSV("a,b,\nc,d,e"), [["a", "b", ""], ["c", "d", "e"]]);
});

test("lone CR (not CRLF) is a literal character", () => {
	assert.deepEqual(parseCSV("a\rb,c"), [["a\rb", "c"]]);
});

// --- quoting ---

test("basic quoted field", () => {
	assert.deepEqual(parseCSV('"a"'), [["a"]]);
});

test("quoted field alone is an empty string", () => {
	assert.deepEqual(parseCSV('""'), [[""]]);
});

test("quoted empty field among others", () => {
	assert.deepEqual(parseCSV('a,"",b'), [["a", "", "b"]]);
});

test("quoted field containing the delimiter", () => {
	assert.deepEqual(parseCSV('"a,b",c'), [["a,b", "c"]]);
});

test("quoted field containing an embedded newline", () => {
	assert.deepEqual(parseCSV('"a\nb",c'), [["a\nb", "c"]]);
});

test("quoted field containing an embedded CRLF", () => {
	assert.deepEqual(parseCSV('"a\r\nb",c'), [["a\r\nb", "c"]]);
});

test("doubled quote inside a quoted field is a literal quote", () => {
	assert.deepEqual(parseCSV('"a""b"'), [['a"b']]);
});

test("quote inside an unquoted field is a literal character", () => {
	assert.deepEqual(parseCSV('a"b,c'), [['a"b', "c"]]);
});

test("unterminated quoted field throws SyntaxError with line 1", () => {
	throwsWith(() => parseCSV('"abc'), SyntaxError, "unterminated quote at line 1");
});

test("unterminated quoted field reports the opening line, not the current one", () => {
	throwsWith(() => parseCSV('"ab\ncd'), SyntaxError, "unterminated quote at line 1");
});

test("unterminated quoted field on a later record", () => {
	throwsWith(() => parseCSV('a,b\n"c'), SyntaxError, "unterminated quote at line 2");
});

test("garbage after a closing quote throws SyntaxError", () => {
	throwsWith(() => parseCSV('"ab"x'), SyntaxError, "unexpected character after quote");
});

// --- delimiter option ---

test("custom delimiter", () => {
	assert.deepEqual(parseCSV("a;b;c", { delimiter: ";" }), [["a", "b", "c"]]);
});

test("invalid delimiter: multi-character string", () => {
	throwsWith(() => parseCSV("a,b", { delimiter: ";;" }), RangeError, "invalid delimiter");
});

test("invalid delimiter: non-string", () => {
	throwsWith(() => parseCSV("a,b", { delimiter: 5 }), RangeError, "invalid delimiter");
});

// --- text validation ---

test("non-string text (number) throws TypeError", () => {
	throwsWith(() => parseCSV(42), TypeError, "text must be a string");
});

test("non-string text (null) throws TypeError", () => {
	throwsWith(() => parseCSV(null), TypeError, "text must be a string");
});

// --- unicode ---

test("unicode and emoji field content", () => {
	assert.deepEqual(parseCSV("héllo,wörld\n😀,b"), [["héllo", "wörld"], ["😀", "b"]]);
});

// --- header mode ---

test("header mode basic", () => {
	assert.deepEqual(parseCSV("a,b\n1,2\n3,4", { header: true }), [
		{ a: "1", b: "2" },
		{ a: "3", b: "4" },
	]);
});

test("header mode: short row padded with empty strings", () => {
	assert.deepEqual(parseCSV("a,b,c\n1,2", { header: true }), [{ a: "1", b: "2", c: "" }]);
});

test("header mode: too many fields throws with correct line", () => {
	throwsWith(() => parseCSV("a,b\n1,2\n3,4,5", { header: true }), SyntaxError, "too many fields at line 3");
});

test("header mode: duplicate header name throws", () => {
	throwsWith(() => parseCSV("a,b,a\n1,2,3", { header: true }), SyntaxError, "duplicate header");
});

test("header mode: duplicate header throws even with zero data rows", () => {
	throwsWith(() => parseCSV("a,a", { header: true }), SyntaxError, "duplicate header");
});

test("header mode: zero data rows yields []", () => {
	assert.deepEqual(parseCSV("a,b\n", { header: true }), []);
});

test("header mode: empty text yields []", () => {
	assert.deepEqual(parseCSV("", { header: true }), []);
});

test("header mode: quoted header names", () => {
	assert.deepEqual(parseCSV('"a,x",b\n1,2', { header: true }), [{ "a,x": "1", b: "2" }]);
});

// --- toCSV ---

test("toCSV basic", () => {
	assert.equal(
		toCSV([
			["a", "b"],
			["c", "d"],
		]),
		"a,b\nc,d",
	);
});

test("toCSV on empty array is empty string", () => {
	assert.equal(toCSV([]), "");
});

test("toCSV quotes a field containing the delimiter", () => {
	assert.equal(toCSV([["a,b", "c"]]), '"a,b",c');
});

test("toCSV quotes and doubles embedded quotes", () => {
	assert.equal(toCSV([['a"b']]), '"a""b"');
});

test("toCSV quotes a field containing a newline", () => {
	assert.equal(toCSV([["a\nb"]]), '"a\nb"');
});

test("toCSV quotes a field containing a carriage return", () => {
	assert.equal(toCSV([["a\rb"]]), '"a\rb"');
});

test("toCSV quotes a field with a leading space", () => {
	assert.equal(toCSV([[" a"]]), '" a"');
});

test("toCSV quotes a field with a trailing space", () => {
	assert.equal(toCSV([["a "]]), '"a "');
});

test("toCSV does not quote internal spaces", () => {
	assert.equal(toCSV([["a b"]]), "a b");
});

test("toCSV stringifies null and undefined as empty", () => {
	assert.equal(toCSV([[null, undefined, "x"]]), ",,x");
});

test("toCSV stringifies non-string cells with String()", () => {
	assert.equal(toCSV([[42, true]]), "42,true");
});

test("toCSV with a custom delimiter", () => {
	assert.equal(
		toCSV([["a", "b"]], { delimiter: ";" }),
		"a;b",
	);
});

test("toCSV quotes on the custom delimiter, not comma", () => {
	assert.equal(toCSV([["a,b"]], { delimiter: ";" }), "a,b");
	assert.equal(toCSV([["a;b"]], { delimiter: ";" }), '"a;b"');
});

test("toCSV invalid delimiter throws RangeError", () => {
	throwsWith(() => toCSV([["a"]], { delimiter: "ab" }), RangeError, "invalid delimiter");
});

test("toCSV rejects non-array rows", () => {
	throwsWith(() => toCSV("nope"), TypeError, "rows must be an array");
});

test("toCSV rejects a non-array row", () => {
	throwsWith(() => toCSV([{ a: 1 }]), TypeError, "each row must be an array");
});

// --- round-trips ---

test("round-trip: simple table", () => {
	const text = "a,b,c\n1,2,3\n4,5,6";
	assert.deepEqual(parseCSV(toCSV(parseCSV(text))), parseCSV(text));
});

test("round-trip: fields needing quotes", () => {
	const text = '"hello, world","she said ""hi""","multi\nline"\nplain,text,here';
	assert.deepEqual(parseCSV(toCSV(parseCSV(text))), parseCSV(text));
});

test("round-trip: CRLF input", () => {
	const text = "a,b\r\nc,d\r\n";
	assert.deepEqual(parseCSV(toCSV(parseCSV(text))), parseCSV(text));
});

test("round-trip: unicode content", () => {
	const text = "héllo,😀\nwörld,b";
	assert.deepEqual(parseCSV(toCSV(parseCSV(text))), parseCSV(text));
});

test("round-trip: empty and blank fields", () => {
	const text = "a,,c\n,,\n";
	assert.deepEqual(parseCSV(toCSV(parseCSV(text))), parseCSV(text));
});
