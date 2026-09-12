Closed-interval set algebra on real numbers. Implement and export from `src/intervals.mjs`: `normalize`, `union`, `intersect`, `subtract`, `contains`, `insert`, `gaps`, `measure`.

## Intervals and sets

An **interval** is `[lo, hi]`: an array of exactly two finite numbers with `lo <= hi`. Both ends are **closed** (included in the interval). A single point is written `[3, 3]`.

A **set** is an array of intervals. A set is in **canonical form** when it is sorted ascending by `lo`, and no two intervals overlap or touch — if one interval's `hi` equals or exceeds another's `lo`, they share a point and must be merged into one interval. Example: `[[1,2],[2,3]]` is not canonical (they touch at `2`); it normalizes to `[[1,3]]`. `[[1,2],[3,4]]` **is** canonical: there is a genuine gap between `2` and `3` — these are real numbers, not integers, so there is no "adjacent integer" merging.

Every function below accepts sets/intervals that need **not** be canonical, and always **returns** a set in canonical form. Inputs are never mutated: every returned array, outer and inner, is freshly allocated.

## Functions

- `normalize(intervals)` — the canonical form of `intervals`.
- `union(a, b)` — the canonical set of points in `a` or `b` (or both). Equivalent to `normalize([...a, ...b])`.
- `intersect(a, b)` — the canonical set of points in both `a` and `b`. Two intervals that only touch at a boundary intersect in a single point: `intersect([[0,2]], [[2,4]])` → `[[2,2]]`.
- `subtract(a, b)` — the points in `a` and not in `b`. Every interval is closed, and there is no way to represent an "open" endpoint, so a cut that lands **strictly inside** an interval of `a` keeps the cut point on **both** sides of the split — it does not vanish: `subtract([[0,10]], [[3,5]])` → `[[0,3],[5,10]]`. Subtracting a single point from the middle behaves the same way: `subtract([[0,5]], [[2,2]])` → `[[0,2],[2,5]]`. When `b` fully covers an interval of `a` (its bounds reach or exceed both ends of that interval), that interval disappears with no remainder: `subtract([[0,5]], [[0,5]])` → `[]`. Unlike every other function here, `subtract`'s result is **not** re-merged into strict canonical form when a cut leaves two remainder pieces touching at the cut point: those two pieces stay separate, because merging them back would erase the fact that the point between them was removed. (Its output is still sorted, and never contains overlapping intervals — only this one touching case is exempt from merging.)
- `contains(set, x)` — `true` if the number `x` falls inside some interval of `set` (`lo <= x <= hi`, endpoints included), else `false`. `x` is compared numerically; `NaN` never matches anything, so `contains(set, NaN)` is always `false`.
- `insert(set, interval)` — fold one interval into `set`. Equivalent to `union(set, [interval])`.
- `gaps(set, lo, hi)` — the complement of `set` within the closed bounds `[lo, hi]`: every point of `[lo, hi]` not covered by `set`. Equivalent to `subtract([[lo, hi]], set)`, including that same touching-but-not-merged exception when an interval or point of `set` cuts through the interior of `[lo, hi]`. Intervals of `set` extending outside `[lo, hi]` are clipped.
- `measure(set)` — the total length of `set`: the sum of `hi - lo` over its canonical intervals. A set made only of points has measure `0`.

## Examples

- `normalize([[3,4],[1,2],[2,3]])` → `[[1,4]]`
- `normalize([[1,2],[1,2]])` → `[[1,2]]`
- `union([[0,2]], [[1,3],[5,6]])` → `[[0,3],[5,6]]`
- `intersect([[0,4]], [[2,6]])` → `[[2,4]]`
- `intersect([[0,2]], [[3,4]])` → `[]`
- `subtract([[0,10]], [[2,4],[6,8]])` → `[[0,2],[4,6],[8,10]]`
- `contains([[0,2],[5,7]], 2)` → `true` (endpoint is included)
- `contains([[0,2],[5,7]], 3)` → `false` (falls in the gap)
- `insert([[0,1],[5,6]], [1,5])` → `[[0,6]]`
- `gaps([[2,4],[6,8]], 0, 10)` → `[[0,2],[4,6],[8,10]]`
- `measure([[0,2],[5,5],[7,10]])` → `5`

## Validation

Every function that takes a `set` argument (`normalize`'s `intervals`; both arguments of `union`, `intersect`, `subtract`; the `set` of `contains`, `insert`, and `gaps`) requires a plain **array** for it. If it is not an array, throw a **`TypeError`** whose message starts with `set must be an array`. When a function takes two set arguments, check the first parameter before the second.

Every interval that appears inside a set argument — and the standalone `interval` argument of `insert` — must be an array of exactly **two finite numbers** `[lo, hi]` with `lo <= hi`. Otherwise throw a **`RangeError`** whose message starts with `invalid interval`. This is checked for every element of a set, even ones a particular operation would otherwise discard: an invalid interval anywhere in `b` still makes `subtract(a, b)` throw, even if it lies nowhere near `a`.

`gaps(set, lo, hi)` additionally requires `lo` and `hi` to be finite numbers with `lo <= hi`. Otherwise throw a **`RangeError`** whose message starts with `invalid bounds`.

Check order for every function: the array-ness of set argument(s) first, left to right; then, for `gaps` only, the bounds; then the validity of the individual intervals inside the set argument(s).
