Six pure functions over POSIX-style, `/`-separated path **strings**. No `node:path` (or `"path"`) import is allowed — implement the logic over plain strings.

Non-string arguments always throw a **`TypeError`** whose message **starts with** `path must be a string`. Backslashes are ordinary characters, never separators.

## `normalize(p)`

- Collapse repeated `/`: `a//b` → `a/b`.
- Remove `.` segments: `a/./b` → `a/b`. Note a segment merely **starting** with `.` (a dotfile like `.env`) is not a `.` segment: `a/.env/b` is unchanged.
- Resolve `..` against a preceding real segment: `a/b/../c` → `a/c`.
- A `..` that has no preceding real segment to cancel:
  - in an **absolute** path, is dropped (you cannot go above `/`): `/..` → `/`, `/a/../../b` → `/b`.
  - in a **relative** path, is kept, and further leading `..`s stack up: `../a` → `../a`, `../../a` → `../../a`, `a/../../b` → `../b`.
- Drop a trailing `/`, except when the whole path is the root: `a/b/` → `a/b`, but `/` stays `/`.
- The empty string, and any path that normalises to nothing, become `.`: `normalize("")` → `.`, `normalize(".")` → `.`, `normalize("a/..")` → `.`.
- More examples: `a/./b//c/` → `a/b/c`; `//` → `/`; `//a` → `/a` (leading doubled slash is still absolute, still collapsed).

## `join(...parts)`

- Concatenate all `parts` with `/`, ignoring parts that are the empty string, then run the result through `normalize`.
- `join("a", "b")` → `a/b`; `join("a/", "/b")` → `a/b`; `join("a", "", "b")` → `a/b`; `join()` → `.`.
- Every part must be a string (same error as above).

## `relative(from, to)`

- Normalise both `from` and `to` first.
- Both must be absolute, or both must be relative. Otherwise throw a **`TypeError`** whose message **starts with** `mixed absolute and relative`.
- Returns the relative path that, appended (via `join`) to `from` (treated as a directory, not a file), reaches `to`, using `..` to climb where needed. Returns `.` when `from` and `to` normalise to the same path.
- There is no working directory: the computation is purely **lexical** on the normalised segment lists. Drop the longest common leading run of segments; every remaining segment of `from` — whatever it is, a leading `..` included — contributes one `..`; the remaining segments of `to` follow. So `relative("../a", "b")` → `../../b`, `relative("a/b", "../c")` → `../../../c`, `relative("../x/y", "../x/z")` → `../z`.
- Examples: `relative("/a/b", "/a/b/c")` → `c`; `relative("/a/b/c", "/a/b")` → `..`; `relative("/a/b", "/c/d")` → `../../c/d`; `relative("a", "a/b")` → `b`; `relative("a/b", "a")` → `..`; `relative("/a", "/a")` → `.`; `relative("..", "../a")` → `a`.

## `isAbsolute(p)`

- `true` if `p` starts with `/`, else `false`. Does not require `p` to be normalised first: `isAbsolute("../a")` → `false`, `isAbsolute("/a/..")` → `true`.

## `dirname(p)`

- POSIX semantics, computed on `normalize(p)`.
- `dirname("/")` → `/`. `dirname("a")` → `.`. `dirname(".")` → `.`. `dirname("/a")` → `/`. `dirname("/a/b")` → `/a`. `dirname("a/b")` → `a`. `dirname("..")` → `.`. `dirname("../a")` → `..`.

## `basename(p, ext?)`

- POSIX semantics, computed on `normalize(p)`: the last `/`-separated segment.
- `basename("/")` → `""` (the root has no name). `basename(".")` → `.`. `basename("/a/b.txt")` → `b.txt`. `basename("a/../b")` → `b`.
- If `ext` is given (a non-empty string) and the basename ends with it, strip it — unless the basename **equals** `ext` exactly, in which case it is left alone: `basename("a/b.txt", ".txt")` → `b`; `basename(".txt", ".txt")` → `.txt`; `basename("a/b.txt", ".md")` → `b.txt`.
- If `ext` is provided it must be a string (same error as above); omitting it entirely is fine.

## Error summary

- Any non-string argument where a path (or `join` part, or `ext`) is expected: `TypeError`, message starts with `path must be a string`.
- `relative` with one absolute and one relative argument (after normalising both): `TypeError`, message starts with `mixed absolute and relative`.
