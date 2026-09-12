Three exports: `diff(a, b)`, `apply(doc, ops)`, `pointer(path)`. All values are plain JSON: objects, arrays, strings, numbers, booleans, `null`.

## `pointer(path)`

Decodes an RFC 6901 JSON Pointer string into an array of reference tokens.

- `path` must be a string starting with `/`, or the empty string `""` (root, decodes to `[]`).
- Split on `/` (dropping the leading empty segment); decode each token by replacing `~1` with `/` **then** `~0` with `~` (in that order).
- Examples: `pointer("")` → `[]`; `pointer("/")` → `[""]`; `pointer("/a/b")` → `["a","b"]`; `pointer("/a~1b")` → `["a/b"]`; `pointer("/a~0b")` → `["a~b"]`; `pointer("/a~01")` → `["a~1"]`.
- Any other string (non-empty, not starting with `/`) or a non-string `path` throws `SyntaxError` starting `invalid pointer`.

## `diff(a, b)`

Returns an array of JSON Patch operations (`{op, path, value?}`, `path` an encoded JSON Pointer string) such that `apply(a, diff(a, b))` deep-equals `b`.

- `a === b` (by value; `-0` equals `0`) at any position → no operation.
- Both plain objects: walk keys of `a` in insertion order, then keys of `b` not in `a` in `b`'s insertion order. A key in `a` but not `b` → `remove`. A key only in `b` → `add` with `b`'s value. A key in both with unequal values → recurse into it (same rules) if both values are plain objects or both are arrays; otherwise → `replace` with `b`'s value.
- Both arrays: compare index by index over the shared length, same recurse-or-replace rule as object values. Extra trailing elements in `b` → `add`, one op per index, in ascending index order, each with the exact target index. Extra trailing elements in `a` → `remove`, one op per index, in **descending** index order (highest index first), so the ops apply correctly in sequence.
- Anything else that differs (mismatched types, or two non-container values) → a single `replace` at the current path with `b`'s value; at the root this is `{op:"replace", path:"", value:b}`.
- `diff(x, x)` → `[]`.
- Encode each path segment by replacing `~` with `~0` then `/` with `~1` (reverse of `pointer`'s decoding).
- If `a` or `b` (at any depth) contains `NaN`, throw `TypeError` starting `not JSON`.

## `apply(doc, ops)`

Applies an array of RFC 6902 operations to `doc` and returns a **new** document; `doc` (and any object/array reachable from it) is never mutated. Ops are applied in array order, each against the result of the previous one.

Each op has a `path` (and `move`/`copy` also have `from`), decoded via the same rules as `pointer`. An op whose `path`/`from` fails `pointer`'s validation throws `SyntaxError` starting `invalid pointer`. An `op` field that isn't one of the six below throws `RangeError` starting `unknown op`.

- `add`: on an object, sets the key (creating or overwriting it). On an array, inserts at the index, shifting later elements right; index `-` (last token) appends; a numeric index equal to the array's length also appends; an index greater than the length, or a malformed index (anything besides `-` or a non-negative integer with no leading zeros), throws `RangeError` starting `index out of range`. `path: ""` replaces the whole document with `value`.
- `remove`: deletes the object key or array index (array elements after it shift left) and returns its former value internally for use by `move`. A missing key, an out-of-range or malformed array index, throws `RangeError` starting `path not found`.
- `replace`: like `remove` immediately followed by `add` at the same spot with `value`; a missing key or index throws `RangeError` starting `path not found` (same as `remove`). `path: ""` replaces the whole document.
- `move`: equivalent to `remove` at `from` (whatever errors `remove` would throw, `move` throws) followed by `add` at `path` with the removed value.
- `copy`: like `move` but the source is left in place and the value added at `path` is a deep copy, so mutating one side later never affects the other.
- `test`: reads the value at `path` (same resolution as `remove`/`replace`; a missing path throws `RangeError` starting `path not found`) and deep-equal compares it to `value`; on mismatch throws `Error` starting `test failed at <path>` (the literal `path` string from the op).

## Errors

- `diff`: `TypeError` starting `not JSON` for `NaN` anywhere in `a` or `b`.
- `pointer` / any op's `path` or `from`: `SyntaxError` starting `invalid pointer`.
- `apply`: `RangeError` starting `unknown op`, `RangeError` starting `path not found`, `RangeError` starting `index out of range`, `Error` starting `test failed at <path>`, as specified above.
