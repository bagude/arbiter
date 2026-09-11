`globMatch(pattern, path)` — return `true` if `path` matches the glob `pattern`, else `false`. The match is **anchored**: the whole path must match the whole pattern. Matching is **case-sensitive**.

Paths are `/`-separated. A path is a sequence of **segments** split on `/`. The empty string is a single empty segment.

## Wildcards

- `*` matches any sequence of characters **except `/`**, including the empty sequence.
- `?` matches exactly **one** character except `/`.
- `**` that forms an **entire segment** matches **zero or more whole segments**. Examples:
  - `a/**/b` matches `a/b`, `a/x/b`, `a/x/y/b`
  - `**/*.js` matches `c.js` and `a/b/c.js`
  - `a/**` matches `a`, `a/x`, `a/x/y`
  - `**` alone matches any path, including the empty path
- `**` that is **not** an entire segment (e.g. `a**b`) behaves exactly like a single `*`. Consecutive `*` inside a segment collapse to one `*`.

## Character classes

- `[abc]` matches one character from the set. Ranges are allowed: `[a-z]`, `[0-9]`.
- `[!abc]` — a `!` immediately after `[` negates the class: one character **not** in the set.
- A `]` placed **immediately** after the opening `[` (or after `[!`) is a **literal `]`** and does not close the class: `[]a]` matches `]` or `a`; `[!]a]` matches anything except `]` or `a`.
- A class **never matches `/`**, whether negated or not.

## Braces

- `{a,b}` matches either alternative. Alternatives may be **empty**: `a{,.txt}` matches `a` and `a.txt`.
- Braces may **nest**: `{a,b{c,d}}` matches `a`, `bc`, `bd`.
- A `}` with no matching `{` is a literal `}`. A `,` outside braces is a literal `,`.

## Escaping

- A backslash `\` makes the **next character literal**: `\*` matches only `*`; `a\[b` matches only `a[b`; `a\{b` matches only `a{b`.

## Dotfiles

- A segment of the path that **starts with `.`** can only be matched by a pattern segment that **starts with a literal `.`**. In particular, `*`, `?`, `**`, and a character class do **not** match a leading `.`.
  - `*` does not match `.env`; `.*` does.
  - `**/*` does not match `.git/x`; `src/**/*.js` does not match `src/.hidden/a.js`.

## Empty pattern

- The empty pattern matches only the empty path.

## Errors

Throw a **`SyntaxError`** whose message **starts with** `invalid glob` when:
- `pattern` is not a string,
- a `[` class is never closed,
- a `{` is never closed,
- the pattern ends with an unescaped trailing `\`.

A non-string `path` returns `false` (no throw).
