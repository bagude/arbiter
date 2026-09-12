`createLRU({ capacity, ttlMs = Infinity, now = () => Date.now() })` builds an LRU cache with optional time-based expiry. It returns an object with `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`, `clear()`, `keys()`, and a `size` getter.

## Construction

- `capacity` must satisfy `Number.isInteger(capacity) && capacity > 0`. Otherwise throw `RangeError` whose message **starts with** `invalid capacity`.
- `ttlMs` defaults to `Infinity` (entries never expire). Otherwise it must be a finite number `> 0`, or `Infinity`; anything else (including `0`, negative numbers, `NaN`, non-numbers) throws `RangeError` whose message **starts with** `invalid ttl`. Capacity is validated before `ttlMs`, so an object with both invalid reports the capacity error.
- `now` defaults to `() => Date.now()` and is called with no arguments whenever the cache needs the current time. It is not validated.
- Keys may be any JS value; identity follows `Map` semantics (SameValueZero): `NaN` matches `NaN`; `+0` and `-0` are the same key.

## Expiry

- Each entry's expiry timestamp is set to `now() + ttlMs` at the moment it is inserted or updated by `set`. `get` never changes an entry's expiry.
- An entry is **expired** once `now() > expiresAt` (age strictly greater than `ttlMs`). With the default `ttlMs = Infinity`, no entry ever expires.
- Every method call — `get`, `set`, `has`, `delete`, `keys`, and reading `size` — first purges every currently-expired entry from the cache before doing anything else. Once purged, an expired entry behaves exactly as if it had never existed: it does not count toward `size` or `capacity`, is absent from `keys()`, and calling `set` on that same key again is treated as inserting a brand-new key (able to trigger eviction if the cache is now full).

## Recency

- The cache maintains a recency order over its live entries, least-recently-used first.
- `get(key)` and `set(key, value)`, when `key` is already present, move that key to the most-recently-used end.
- `has(key)`, `delete(key)`, and `keys()` never change recency order.

## Methods

- `get(key)` — after purging, if `key` is present return its value and refresh its recency; otherwise return `undefined`. Since a stored value may itself be `undefined`, `get` alone cannot distinguish "absent" from "stored `undefined`" — use `has` to check presence.
- `set(key, value)` — after purging: if `key` is already present, update its value, reset its expiry to `now() + ttlMs`, and refresh its recency. If `key` is not present and the cache already holds `capacity` live entries, evict the single least-recently-used entry first. Then insert `key` → `value` at the most-recently-used end with expiry `now() + ttlMs`. Returns the cache itself (for chaining).
- `has(key)` — after purging, return `true` if `key` is present, else `false`. Does not refresh recency.
- `delete(key)` — after purging, remove `key` if present and return `true`; return `false` if it was not present (including a key that had just expired).
- `clear()` — remove every entry, live or expired.
- `size` (getter) — after purging, the number of live entries.
- `keys()` — after purging, a fresh array of live keys ordered least-recently-used first, most-recently-used last.

## Examples

- `const c = createLRU({ capacity: 2 }); c.set("a", 1); c.set("b", 2); c.set("c", 3);` evicts `"a"`; `c.keys()` → `["b", "c"]`.
- `c.set("a",1); c.set("b",2); c.get("a"); c.set("c",3);` evicts `"b"` (least recently used); `c.keys()` → `["a","c"]`.
- With `ttlMs: 10` and an injectable `now`: `c.set("a", 1)` at `t = 0`; at `t = 10`, `c.has("a")` → `true` (age `10` is not `> 10`); at `t = 11` → `false`.
- On a `capacity: 1` cache, `c.set("a", 1)` then `c.set("a", 2)` does not evict `"a"`; `c.get("a")` → `2`.
- `createLRU({ capacity: 0 })`, `createLRU({ capacity: 1.5 })`, `createLRU({ capacity: -1 })`, `createLRU({})` all throw `RangeError` `invalid capacity…`.
- `createLRU({ capacity: 1, ttlMs: 0 })`, `createLRU({ capacity: 1, ttlMs: -5 })`, `createLRU({ capacity: 1, ttlMs: NaN })`, `createLRU({ capacity: 1, ttlMs: "10" })` all throw `RangeError` `invalid ttl…`.

## Non-goals

No LFU or other eviction policies, no async methods, no serialization, no iteration protocol beyond `keys()`, no event or callback hooks.
