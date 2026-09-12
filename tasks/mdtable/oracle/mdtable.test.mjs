// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTable, parseTable } from "./src/mdtable.mjs";

function throwsRange(fn, prefix) {
	assert.throws(
		fn,
		(e) => e instanceof RangeError && e.message.startsWith(prefix),
		`expected RangeError starting "${prefix}..."`,
	);
}

function throwsSyntax(fn, prefix = "not a table") {
	assert.throws(
		fn,
		(e) => e instanceof SyntaxError && e.message.startsWith(prefix),
		`expected SyntaxError starting "${prefix}..."`,
	);
}

// ---- renderTable: basics ----------------------------------------------------

test("renderTable: default align is left for all columns", () => {
	assert.equal(renderTable(["a", "b"], [["1", "2"]]), "| a   | b   |\n| --- | --- |\n| 1   | 2   |");
});

test("renderTable: explicit left+right alignment", () => {
	assert.equal(
		renderTable(["Name", "Age"], [["Alice", "30"], ["Bo", "5"]], { align: ["left", "right"] }),
		"| Name  | Age |\n| ----- | --: |\n| Alice |  30 |\n| Bo    |   5 |",
	);
});

test("renderTable: left, center, right together", () => {
	assert.equal(
		renderTable(["A", "BB", "CCC"], [["x", "yy", "zzz"], ["1", "22", "333"]], { align: ["left", "center", "right"] }),
		"| A   | BB  | CCC |\n| --- | :-: | --: |\n| x   | yy  | zzz |\n| 1   | 22  | 333 |",
	);
});

test("renderTable: center alignment puts the extra space on the right", () => {
	assert.equal(
		renderTable(["H"], [["ab"], ["a"]], { align: ["center"] }),
		"|  H  |\n| :-: |\n| ab  |\n|  a  |",
	);
});

test("renderTable: minimum column width is 3 even for a single-char column", () => {
	assert.equal(renderTable(["a"], [["b"]]), "| a   |\n| --- |\n| b   |");
});

test("renderTable: astral characters measured in UTF-16 code units", () => {
	assert.equal(renderTable(["\u{1F600}"], [["a"]]), "| \u{1F600}  |\n| --- |\n| a   |");
});

test("renderTable: single column with multiple rows", () => {
	assert.equal(
		renderTable(["only"], [["one"], ["two"]]),
		"| only |\n| ---- |\n| one  |\n| two  |",
	);
});

test("renderTable: ragged column widths across several rows", () => {
	assert.equal(
		renderTable(["id", "name"], [["1", "alice"], ["22", "bob"], ["333", "c"]]),
		"| id  | name  |\n| --- | ----- |\n| 1   | alice |\n| 22  | bob   |\n| 333 | c     |",
	);
});

test("renderTable: empty rows array renders just header and separator", () => {
	assert.equal(renderTable(["a", "b"], []), "| a   | b   |\n| --- | --- |");
});

test("renderTable: no trailing newline", () => {
	const out = renderTable(["a"], [["1"]]);
	assert.ok(!out.endsWith("\n"));
	assert.equal(out.split("\n").length, 3);
});

// ---- renderTable: cell coercion ----------------------------------------------

test("renderTable: non-string cells are stringified, null/undefined become empty", () => {
	assert.equal(
		renderTable(["n"], [[42], [null], [undefined], [true]]),
		"| n    |\n| ---- |\n| 42   |\n|      |\n|      |\n| true |",
	);
});

test("renderTable: numeric header cells are stringified", () => {
	assert.equal(renderTable([1, 2], [["a", "b"]]), "| 1   | 2   |\n| --- | --- |\n| a   | b   |");
});

test("renderTable: numeric and decimal row cells", () => {
	assert.equal(renderTable(["n"], [[1], [2.5]]), "| n   |\n| --- |\n| 1   |\n| 2.5 |");
});

test("renderTable: short rows are padded with empty cells", () => {
	assert.equal(
		renderTable(["a", "b", "c"], [["x"]]),
		"| a   | b   | c   |\n| --- | --- | --- |\n| x   |     |     |",
	);
});

// ---- renderTable: escaping ----------------------------------------------------

test("renderTable: a pipe inside a cell is escaped as \\|", () => {
	assert.equal(
		renderTable(["a|b", "c"], [["x|y", "z"]]),
		"| a\\|b | c   |\n| ---- | --- |\n| x\\|y | z   |",
	);
});

test("renderTable: a newline inside a cell becomes <br>", () => {
	assert.equal(
		renderTable(["a"], [["line1\nline2"]]),
		"| a              |\n| -------------- |\n| line1<br>line2 |",
	);
});

test("renderTable: pipe and newline together in one cell", () => {
	assert.equal(
		renderTable(["x"], [["a|b\nc"]]),
		"| x         |\n| --------- |\n| a\\|b<br>c |",
	);
});

// ---- renderTable: align option edge cases -------------------------------------

test("renderTable: align shorter than header defaults remaining columns to left", () => {
	assert.equal(
		renderTable(["a", "b", "c"], [["1", "2", "3"]], { align: ["right"] }),
		"|   a | b   | c   |\n| --: | --- | --- |\n|   1 | 2   | 3   |",
	);
});

test("renderTable: align longer than header ignores extra entries", () => {
	assert.equal(
		renderTable(["a"], [["1"]], { align: ["right", "center", "left"] }),
		"|   a |\n| --: |\n|   1 |",
	);
});

test("renderTable: omitting options entirely is equivalent to all-left", () => {
	assert.equal(renderTable(["a", "b"], [["1", "2"]]), renderTable(["a", "b"], [["1", "2"]], {}));
});

// ---- renderTable: errors -------------------------------------------------------

test("renderTable: empty header throws RangeError", () => {
	throwsRange(() => renderTable([], []), "header must not be empty");
});

test("renderTable: a row longer than the header throws RangeError naming the row", () => {
	throwsRange(() => renderTable(["a"], [["x", "y"]]), "row 0 has too many cells");
});

test("renderTable: the too-many-cells row index is 0-based and reports the offending row", () => {
	throwsRange(() => renderTable(["a", "b"], [["1", "2"], ["3", "4", "5"]]), "row 1 has too many cells");
});

test("renderTable: an invalid align value throws RangeError", () => {
	throwsRange(() => renderTable(["a"], [], { align: ["up"] }), "invalid align");
});

test("renderTable: invalid align is detected at whichever column holds it", () => {
	throwsRange(() => renderTable(["a", "b"], [], { align: ["left", "bogus"] }), "invalid align");
});

// ---- parseTable: round-trips ---------------------------------------------------

test("parseTable: round-trips a left+right table", () => {
	const text = renderTable(["Name", "Age"], [["Alice", "30"], ["Bo", "5"]], { align: ["left", "right"] });
	assert.deepEqual(parseTable(text), { header: ["Name", "Age"], rows: [["Alice", "30"], ["Bo", "5"]], align: ["left", "right"] });
});

test("parseTable: round-trips a left+center+right table", () => {
	const text = renderTable(["A", "BB", "CCC"], [["x", "yy", "zzz"], ["1", "22", "333"]], { align: ["left", "center", "right"] });
	assert.deepEqual(parseTable(text), { header: ["A", "BB", "CCC"], rows: [["x", "yy", "zzz"], ["1", "22", "333"]], align: ["left", "center", "right"] });
});

test("parseTable: round-trips escaped pipes back to literal pipes", () => {
	const text = renderTable(["a|b", "c"], [["x|y", "z"]]);
	assert.deepEqual(parseTable(text), { header: ["a|b", "c"], rows: [["x|y", "z"]], align: ["left", "left"] });
});

test("parseTable: round-trips <br> back to a newline", () => {
	const text = renderTable(["a"], [["line1\nline2"]]);
	assert.deepEqual(parseTable(text), { header: ["a"], rows: [["line1\nline2"]], align: ["left"] });
});

test("parseTable: round-trips numeric cells as their stringified form", () => {
	const text = renderTable(["id", "label"], [[1, "x"], [22, "yy"]], { align: ["right", "left"] });
	assert.deepEqual(parseTable(text), { header: ["id", "label"], rows: [["1", "x"], ["22", "yy"]], align: ["right", "left"] });
});

test("parseTable: round-trips a table rendered with default (omitted) align", () => {
	const text = renderTable(["a", "b"], [["1", "2"]]);
	assert.deepEqual(parseTable(text), { header: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] });
});

test("parseTable: round-trips a table with no data rows", () => {
	const text = renderTable(["a", "b"], []);
	assert.deepEqual(parseTable(text), { header: ["a", "b"], rows: [], align: ["left", "left"] });
});

// ---- parseTable: tolerant parsing ----------------------------------------------

test("parseTable: tolerates a table with no leading or trailing pipes", () => {
	assert.deepEqual(parseTable("a | b\n--- | ---\n1 | 2"), { header: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] });
});

test("parseTable: tolerates a missing leading pipe only", () => {
	assert.deepEqual(parseTable("a | b |\n--- | --- |\n1 | 2 |"), { header: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] });
});

test("parseTable: tolerates a missing trailing pipe only", () => {
	assert.deepEqual(parseTable("| a | b\n| --- | ---\n| 1 | 2"), { header: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] });
});

test("parseTable: tolerates arbitrary extra whitespace around cells and lines", () => {
	assert.deepEqual(
		parseTable("  |   a   |   b   |  \n  | ---   | ---   |  \n  |  1    |  2    |  "),
		{ header: ["a", "b"], rows: [["1", "2"]], align: ["left", "left"] },
	);
});

test("parseTable: detects right alignment from a --: separator cell", () => {
	assert.deepEqual(parseTable("| a |\n| --: |\n| 1 |"), { header: ["a"], rows: [["1"]], align: ["right"] });
});

test("parseTable: detects center alignment from a :-: separator cell", () => {
	assert.deepEqual(parseTable("| a |\n| :-: |\n| 1 |"), { header: ["a"], rows: [["1"]], align: ["center"] });
});

test("parseTable: an escaped pipe inside a cell does not split the cell", () => {
	assert.deepEqual(parseTable("| a\\|b |\n| --- |\n| x |"), { header: ["a|b"], rows: [["x"]], align: ["left"] });
});

test("parseTable: a table with only header and separator has an empty rows array", () => {
	assert.deepEqual(parseTable("| a | b |\n| --- | --- |"), { header: ["a", "b"], rows: [], align: ["left", "left"] });
});

test("parseTable: multiple data rows keep their order", () => {
	assert.deepEqual(
		parseTable("| id | name |\n| --- | --- |\n| 1 | alice |\n| 2 | bob |"),
		{ header: ["id", "name"], rows: [["1", "alice"], ["2", "bob"]], align: ["left", "left"] },
	);
});

// ---- parseTable: errors ---------------------------------------------------------

test("parseTable: a single line throws SyntaxError", () => {
	throwsSyntax(() => parseTable("just one line"));
});

test("parseTable: an empty string throws SyntaxError", () => {
	throwsSyntax(() => parseTable(""));
});

test("parseTable: a separator line with non-dash content throws SyntaxError", () => {
	throwsSyntax(() => parseTable("a | b\nfoo | bar"));
});

test("parseTable: a separator line with the wrong column count throws SyntaxError", () => {
	throwsSyntax(() => parseTable("a | b\n--- | --- | ---"));
});

test("parseTable: a leading-colon-only separator cell (:--) is rejected", () => {
	throwsSyntax(() => parseTable("a | b\n:-- | ---"));
});

test("parseTable: a separator cell shorter than width 3 is rejected", () => {
	throwsSyntax(() => parseTable("a\n--"));
});
