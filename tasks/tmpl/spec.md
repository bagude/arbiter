`render(template, data)` — render a Mustache-style template string against `data`, returning the
rendered string. `data` is the initial (outermost) context; if omitted, an empty object `{}` is used.

## Interpolation

- `{{name}}` — looks up `name` (see Lookup below) and inserts it, HTML-escaping `& < > " '` as
  `&amp; &lt; &gt; &quot; &#39;`.
  `render("<{{x}}>", { x: "<b>" })` → `"<&lt;b&gt;>"`
- `{{{name}}}` — same lookup, inserted **without** escaping.
  `render("{{{x}}}", { x: "<b>" })` → `"<b>"`
- `{{name.a.b}}` — dotted path: `name` is resolved via the context stack, then `.a` and `.b` are plain
  property lookups on that value only (no further stack fallback if they're missing).
  `render("{{u.name}}", { u: { name: "Amy" } })` → `"Amy"`
- `{{.}}` — the current (innermost) context value itself, HTML-escaped like `{{name}}`.
  `render("{{#nums}}{{.}}-{{/nums}}", { nums: [1, 2] })` → `"1-2-"`
- `{{! anything }}` — a comment, removed from the output entirely. Its text runs up to the first `}}`.
- Whitespace just inside a tag's delimiters is trimmed: `{{ name }}` behaves like `{{name}}`.

## Sections

`{{#key}}...{{/key}}` looks up `key` via the context stack:
- **array** — the block is rendered once per element, with that element pushed as the new innermost
  context. `render("{{#items}}({{.}})/{{/items}}", { items: [1, 2] })` → `"(1)/(2)/"`
- **truthy, non-array object** — rendered once with the object pushed as the new innermost context.
  `render("{{#a}}{{x}}{{/a}}", { a: { x: 1 } })` → `"1"`
- **truthy, non-array primitive** — rendered once with the context stack left unchanged.
  `render("{{#a}}{{x}}{{/a}}", { a: true, x: 1 })` → `"1"`
- **falsy** (`false`, `null`, `undefined`, `0`, `""`, or `[]`) — the block is skipped entirely.

`{{^key}}...{{/key}}` is an inverted section: the block is rendered once, context stack unchanged, exactly
when `key`'s value is falsy (same definition as above); otherwise nothing is rendered.

Sections nest freely, and a section may appear inside an inverted section or vice versa:
`render("{{^a}}{{#b}}{{.}}{{/b}}{{/a}}", { b: [1, 2] })` → `"12"` (`a` is missing, so falsy, so the
inverted block runs; inside it `{{#b}}` sees the original outer context, unaffected by `^a`).
`render("{{#list}}{{#.}}x{{/.}}{{/list}}", { list: [[1], []] })` → `"x"` (each element becomes the
context for `{{#.}}`; the non-empty array is truthy, the empty one is falsy).

An array of objects works with plain interpolation inside the section:
`render("{{#users}}{{name}}-{{/users}}", { users: [{ name: "A" }, { name: "B" }] })` → `"A-B-"`

## Lookup

Interpolation and section-key lookup walk the context stack from innermost (most recently pushed) to
outermost, and use the value from the first frame that owns the name's first segment. A name not found
anywhere on the stack, or a dotted path that hits `null`/`undefined` partway through, renders as `""` —
lookup never throws. Values are stringified with `String()`; `null`/`undefined` become `""`; numbers and
booleans render as their `String()` form (e.g. `42`, `true`).

## Whitespace

Tags render exactly in place. There is no "standalone line" stripping: newlines and spaces around a tag
(including a section's opening/closing tags) are preserved verbatim in the output.

## Errors

- `template` is not a string → `TypeError` whose message starts with `template must be a string`.
- `{{name` (or `{{{name`) with no matching closing `}}` (`}}}`) before the template ends → `SyntaxError`
  starting with `unterminated tag`.
- `{{#key}}` or `{{^key}}` with no matching `{{/key}}` before the template ends → `SyntaxError` starting
  with `unclosed section`.
- `{{/key}}` with no open section on the stack → `SyntaxError` starting with `unexpected close`.
- A close tag whose name doesn't match the innermost open section, e.g. `{{#a}}...{{/b}}` → `SyntaxError`
  starting with `mismatched close`.
