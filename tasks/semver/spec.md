Implement `parse(v)`, `compare(a, b)`, and `satisfies(v, range)` per Semantic Versioning 2.0.0 (semver.org), plus a small range language for `satisfies`. All three take version strings. A version string may start with an optional literal `v` (e.g. `v1.2.3`), stripped before parsing; nothing else is stripped.

## Version grammar

A version is `MAJOR.MINOR.PATCH` optionally followed by `-PRERELEASE` and/or `+BUILD`, matched **in full** (anchored) after stripping the optional leading `v`.

- `MAJOR`, `MINOR`, `PATCH` each match `0` or `[1-9][0-9]*` — no leading zeros.
- `PRERELEASE` is one or more dot-separated identifiers, each matching `[0-9A-Za-z-]+`. An identifier made up **only of ASCII digits** must also have no leading zero (unless it is exactly `0`); an identifier containing any letter or `-` has no such restriction.
- `BUILD` is one or more dot-separated identifiers, each matching `[0-9A-Za-z-]+` (leading zeros allowed here).

## `parse(v)`

Returns `{ major, minor, patch, prerelease, build }`: `major`/`minor`/`patch` are numbers, `prerelease`/`build` are arrays of the identifier strings (`[]` when the part is absent). Throws `SyntaxError` whose message starts with `invalid version` when `v` is not a string or does not match the grammar above.

## `compare(a, b)`

Parses `a` and `b` (same errors as `parse`) and returns `-1`, `0`, or `1`. Build metadata is ignored.

1. Compare `major`, then `minor`, then `patch`, numerically; a difference decides the result.
2. Otherwise, a version **with** a prerelease has **lower** precedence than the same major.minor.patch **without** one.
3. Otherwise (both have a prerelease), compare identifiers pairwise, left to right:
   - both identifiers all-digits → compare numerically;
   - both identifiers not all-digits → compare as strings, ASCII code-point order;
   - one all-digits, one not → the all-digits one is lower, regardless of value;
   - equal pair → move to the next identifier;
   - one array runs out first → that (shorter) one is lower; if all shared identifiers are equal and both arrays are the same length, the versions are equal.

Precedence chain (each strictly less than the next): `1.0.0-alpha`, `1.0.0-alpha.1`, `1.0.0-alpha.beta`, `1.0.0-beta`, `1.0.0-beta.2`, `1.0.0-beta.11`, `1.0.0-rc.1`, `1.0.0`.

## `satisfies(v, range)`

`v` must parse as a version (same errors as `parse`). `range` is one or more **comparator sets** joined by `||` (optional whitespace around `||`); `v` satisfies the range if it satisfies **any** set. A comparator set is one or more whitespace-separated **comparators**; `v` satisfies the set only if it satisfies **every** comparator in it. Splitting `range` on `||` and each set on whitespace must leave no empty piece.

A comparator is one of:

- `*` — matches any version (subject to the Prereleases rule below).
- `OP VERSION` (no space between `OP` and `VERSION`), `OP` ∈ `=`, `>`, `>=`, `<`, `<=`; a version with no `OP` at all means `=`. `VERSION` may be a full version or a **partial version** (below).
- `~VERSION` — patch-level range; `VERSION` must be a full `x.y.z` (optionally `-prerelease`): equivalent to `>=x.y.z <x.(y+1).0`.
- `^VERSION` — caret range; `VERSION` must be a full `x.y.z` (optionally `-prerelease`): equivalent to `>=x.y.z <(x+1).0.0`, except `^0.y.z` with `y>0` means `>=0.y.z <0.(y+1).0`, and `^0.0.z` means `>=0.0.z <0.0.(z+1)`.
- `A - B` — hyphen range: the literal token `-` surrounded by whitespace, with `A` and `B` each a full-or-partial version; it must be the **only** comparator in its set. Equivalent to `>=A' <=B'` where `A'` fills `A` as a `>=` bound and `B'` fills `B` as a `<=` bound (Partial versions below).

A partial version never carries a prerelease or build metadata; only `=`/no-op/`>`/`>=`/`<`/`<=` comparators and hyphen endpoints may be partial. `~` and `^` require a full `x.y.z`; a partial version there is a range error, as is `+build` anywhere in a range.

### Partial versions

`VERSION` may omit trailing components: `1` (major only) or `1.2` (major.minor). Missing components are filled depending on the operator:

- `=`, no-op, `>`, `>=`: missing components become `0` (`>=1.2` → `>=1.2.0`; `1` → `=1.0.0`).
- `<`, `<=`: the comparator becomes `< NEXT`, where `NEXT` increments the last given component by one and zeros everything after it (`<1.2` → `<1.3.0`; `<=1` → `<2.0.0`).

## Prereleases

A version `v` with a non-empty `prerelease` satisfies a comparator set only if it also meets this: at least one comparator in that set is written with a full version carrying an explicit prerelease (`x.y.z-pre...`, under any of `=`/no-op/`>`/`>=`/`<`/`<=`/`~`/`^`, or as a hyphen endpoint) whose `major.minor.patch` equals `v`'s. A version with no prerelease is never subject to this restriction.

## Errors

- `parse`: `SyntaxError` starting `invalid version` — see Version grammar.
- `compare`: the same, propagated from parsing `a` or `b`.
- `satisfies`: the same (from `parse`) for an invalid `v`; `SyntaxError` starting `invalid range` for a malformed `range` — empty range or comparator set, unknown operator, malformed or disallowed-partial version, `+build` in a range, or a malformed hyphen range.
