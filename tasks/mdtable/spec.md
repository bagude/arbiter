`renderTable(header, rows, { align } = {})` — render an aligned Markdown table as a string. `header` is an array of cell values; `rows` is an array of row arrays; `align` is an optional array of `"left" | "right" | "center"`, one per column, defaulting to `"left"` (a short `align` array leaves the remaining trailing columns `"left"`; extra entries beyond `header.length` are ignored).

## Cell text
Every cell (header or row) is converted to text before anything else: `null`/`undefined` become `""`; a non-string value is passed through `String()`; a string is used as-is. Then, in the resulting text, every `|` is replaced with `\|` and every `\n` is replaced with `<br>`. This escaped text is what gets measured and padded.

## Column widths and padding
For each column, the width is the length (`.length`, UTF-16 code units) of its widest escaped cell text, header included, with a floor of **3**. Every cell in that column — header, separator, and data — is padded with spaces to exactly that width:
- `"left"` (default): pad on the right.
- `"right"`: pad on the left.
- `"center"`: split the padding as evenly as possible; when it is odd, the **extra space goes on the right**.

Rows shorter than `header.length` are padded with `""` cells on the right. Layout:
- Cells in a line are joined with `" | "`, with a leading `"| "` and trailing `" |"`.
- Lines (header, separator, then each data row in order) are joined with `"\n"`, no trailing newline.
- The separator line's cells are all dashes, stretched to the column's width: `"-".repeat(width)` for `"left"`, ending in `:` for `"right"` (`"-".repeat(width-1) + ":"`), or bracketed by `:` for `"center"` (`":" + "-".repeat(width-2) + ":"`). `:--` (leading colon only) is never produced.

Worked example — `renderTable(["Name","Age"], [["Alice","30"],["Bo","5"]], { align: ["left","right"] })`:
```
| Name  | Age |
| ----- | --: |
| Alice |  30 |
| Bo    |   5 |
```
Three columns with `align: ["left","center","right"]`, `renderTable(["A","BB","CCC"], [["x","yy","zzz"],["1","22","333"]], ...)`:
```
| A   | BB  | CCC |
| --- | :-: | --: |
| x   | yy  | zzz |
| 1   | 22  | 333 |
```
Center with an odd gap, `renderTable(["H"], [["ab"],["a"]], { align: ["center"] })` (width 3, `"a"` gets 1 space left / 1 right... here gap is 1, so 0 left / 1 right):
```
|  H  |
| :-: |
| ab  |
|  a  |
```
Escaping, `renderTable(["a|b","c"], [["x|y","z"]])`:
```
| a\|b | c   |
| ---- | --- |
| x\|y | z   |
```
A `\n` cell, `renderTable(["a"], [["line1\nline2"]])` → row cell renders as `line1<br>line2`.

## Errors (`renderTable`)
All are `RangeError`:
- `header.length === 0` → message starts with `header must not be empty`.
- Any `rows[i]` with more elements than `header.length` → message starts with `row N has too many cells` (`N` is the 0-based row index, checked before any shorter row is padded).
- Any `align` entry (within `header.length`) that is not `"left"`, `"right"`, or `"center"` → message starts with `invalid align`.

## `parseTable(text)`
Inverts `renderTable`. Returns `{ header, rows, align }` where `header` and each row are arrays of strings and `align` is the per-column array recovered from the separator line.

- `text` is split on `"\n"`. Line 0 is the header, line 1 must be a valid separator line, every line after that is one data row (an empty `text` after line 1 yields `rows: []`).
- Each line is tokenized into cells: strip an optional leading and/or trailing `|` (each may be surrounded by whitespace, which is trimmed off the whole line first), then split the remainder on every `|` that is **not** immediately preceded by `\`. Each resulting cell is trimmed of surrounding whitespace, then unescaped (`\|` → `|`, `<br>` → `\n`).
- The separator line must tokenize to exactly `header.length` cells, each matching one of `/^-{3,}$/` (→ `"left"`), `/^-{2,}:$/` (→ `"right"`), `/^:-{1,}:$/` (→ `"center"`); anything else (including a lone leading colon like `:--`, or a mismatched cell count) makes it not a valid separator line.
- If there are fewer than 2 lines, or line 1 is not a valid separator line, throw a `SyntaxError` whose message starts with `not a table`.

`parseTable` tolerates missing leading/trailing pipes and arbitrary extra whitespace around cells: `parseTable("a | b\n--- | ---\n1 | 2")` and `parseTable("|  a  |  b  |\n| --- | --- |\n|  1  |  2  |")` both parse to `{ header: ["a","b"], rows: [["1","2"]], align: ["left","left"] }`.

## Round-trip
For any valid `header` (non-empty array), `rows` (each no longer than `header`), and `align` (valid or omitted), `parseTable(renderTable(header, rows, { align }))` deep-equals `{ header: header.map(String-and-escape-inverted-back-to-original-text), rows: <rows, each padded to header.length with "", every cell stringified>, align: <align padded to header.length with "left", or all "left" if omitted> }`. In practice, since escaping round-trips exactly, `header` and cell values that were already plain strings come back identical.
