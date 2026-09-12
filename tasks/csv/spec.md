Implement two exports, an RFC 4180-style CSV parser and serialiser. Plain ESM, no dependencies.

## `parseCSV(text, { delimiter = ",", header = false } = {})`

- `text` must be a string; otherwise throw `TypeError` whose message starts with `text must be a string`.
- `delimiter` must be a single-character string; otherwise throw `RangeError` whose message starts with `invalid delimiter`.
- `text === ""` returns `[]`.
- Records are separated by `\n` or `\r\n` (each counts as **one** terminator). If the text ends with a terminator, that trailing terminator does **not** produce an extra empty record. A terminator anywhere else (including immediately after another terminator, i.e. a blank line) does produce a record.
- Within a record, fields are separated by `delimiter`.
- A field that starts with `"` is a **quoted field**: it ends at the next `"` that is not immediately followed by another `"`. `""` inside a quoted field is a literal `"`. A quoted field may contain delimiters and raw line breaks (`\n` or `\r\n`), which are kept verbatim in the field's value.
- A `"` that is not the first character of a field is a literal character (the field is not quoted).
- After a quoted field's closing `"`, the next character must be `delimiter`, a record terminator, or end of input; anything else throws `SyntaxError` whose message starts with `unexpected character after quote`.
- If a quoted field is never closed before the end of input, throw `SyntaxError` whose message starts with `unterminated quote at line N`, where `N` is the 1-based line number on which that field's opening `"` appears.
- Without `header`, each record becomes an array of strings (`string[][]`).
- With `header: true`, the first record is the header row (its fields are the key names) and every following record becomes an object keyed by those names:
  - A record with fewer fields than the header gets `""` for the missing trailing keys.
  - A record with more fields than the header throws `SyntaxError` whose message starts with `too many fields at line N`, `N` being the 1-based line on which that record starts.
  - If the header row has a repeated name, throw `SyntaxError` whose message starts with `duplicate header`.
  - These checks happen even if there are zero data records.

Line numbers start at 1 at the beginning of `text` and advance past every `\n` consumed, whether inside or outside a quoted field.

## `toCSV(rows, { delimiter = "," } = {})`

- `rows` must be an array of arrays; otherwise throw `TypeError`.
- `delimiter` follows the same single-character rule as above (`RangeError`, message starts with `invalid delimiter`).
- Each cell is stringified with `String(cell)`; `null` and `undefined` become `""`.
- A cell is wrapped in `"..."` (with any `"` doubled) when its stringified value contains `delimiter`, `"`, `\n`, `\r`, or has a leading or trailing space (`" "`); otherwise it is written as-is.
- Fields within a record are joined with `delimiter`; records are joined with `\n`. There is no trailing terminator after the last record. `toCSV([])` is `""`.

## Round-trip

For well-formed `text`, `parseCSV(toCSV(parseCSV(text)))` deep-equals `parseCSV(text)` (using the same `delimiter` throughout, `header: false`).
