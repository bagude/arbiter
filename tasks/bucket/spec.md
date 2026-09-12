`createBucket({ capacity, refillPerSecond, initial = capacity })` — construct a token-bucket rate limiter. Returns an object with four methods: `take`, `available`, `timeUntil`, `reset`. Time is always passed in explicitly as milliseconds; the bucket never reads the clock itself (never calls `Date.now()` or similar).

## Construction

- `capacity` must be a positive finite number, else throw `RangeError` whose message starts with `invalid capacity`.
- `refillPerSecond` must be a non-negative finite number, else throw `RangeError` whose message starts with `invalid refill`.
- `initial` defaults to `capacity`. It must be a finite number within `[0, capacity]`, else throw `RangeError` whose message starts with `invalid initial`.

## Time

Every method takes an explicit `atMs` (milliseconds) argument. Time must be **non-decreasing** across the whole lifetime of a bucket: if a call's `atMs` is earlier than the `atMs` of any previous call to *any* method, throw `RangeError` whose message starts with `time went backwards`. Equal timestamps are allowed (elapsed time is zero, no refill happens). Before any call has been made there is no "previous" time, so the very first call may use any `atMs`, including a negative one.

Refilling is lazy and continuous: whenever any method runs, it first advances the bucket to `atMs` by computing elapsed seconds since the previous call as `(atMs - lastAtMs) / 1000`, adding `elapsed * refillPerSecond` tokens, and capping the result at `capacity`. This applies to every method, not only `take`. On the very first call there is no previous call, so **no refill accrues**: the first call of any method (including `available`) simply records its `atMs` as the reference time, and the bucket holds exactly `initial` tokens at that moment whatever its `atMs` is.

## Methods

- `take(n = 1, atMs)` — attempt to consume `n` tokens at time `atMs`. If at least `n` tokens are available (after the lazy refill above), subtract `n` from the bucket and return `true`. Otherwise leave the bucket's tokens unchanged and return `false`. `n` must be a positive finite number, else throw `RangeError` whose message starts with `invalid amount`. If `n > capacity`, `take` simply returns `false` — that alone is never an error.
- `available(atMs)` — apply the lazy refill for time `atMs` and return the current token count. The result may be fractional; it is never negative and never exceeds `capacity`.
- `timeUntil(n, atMs)` — apply the lazy refill for time `atMs`, then return the number of milliseconds until `n` tokens would be obtainable, assuming no further `take` calls happen. Return `0` if `n` tokens are already available right now. Return `Infinity` if `n > capacity` (it can never be satisfied), or if `refillPerSecond` is `0` and fewer than `n` tokens are currently available. Otherwise return the exact value `(n - available) / refillPerSecond * 1000`. `n` is validated exactly like in `take` (positive finite, else `invalid amount`).
- `reset(atMs)` — set the token count to `capacity` at time `atMs`. Subject to the same non-decreasing-time rule as every other method. Its return value carries no meaning.

## Floating point

Compare available tokens against a requested amount with a tolerance of `1e-9`. For example, if the bucket currently holds `0.9999999999` tokens and `1` token is requested, treat that as sufficient: `take(1, ...)` succeeds and `timeUntil(1, ...)` returns `0`.

## Errors

Every validation error is a `RangeError`. Messages start with exactly one of these prefixes — `invalid capacity`, `invalid refill`, `invalid initial`, `invalid amount`, `time went backwards` — and may contain further detail afterward.
