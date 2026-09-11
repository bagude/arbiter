`parseDuration(input)` — parse a human duration string and return the total number of **seconds as an integer**.

## Grammar

- Input is one or more **components**, each `<number><unit>`.
- Units (letters are case-insensitive):
  - `d` = 86400 seconds
  - `h` = 3600 seconds
  - `m` = 60 seconds
  - `s` = 1 second
- Components may be written with no separator (`1h30m`) or separated by whitespace (`1h 30m`).
- Components may appear in **any order** (`30m1h` is valid and equals `1h30m`).
- Each unit may appear **at most once**. A repeated unit (`1m1m`) is invalid.
- Leading and trailing whitespace is ignored.

## Numbers

- A number is a non-negative integer or decimal with a **leading digit** (`1.5h` valid; `.5h` invalid).
- Decimals are allowed on any unit.
- The final total is **rounded to the nearest integer; halves round up** (`1.5s` → 2).
- A **bare number with no unit** (`90`) means seconds. A bare number may only be used **alone** — mixing it with unit components (`90 1h`) is invalid.
- `0` and `0s` both return 0.

## Errors

On any invalid input, throw a **`RangeError`** whose message **starts with** `invalid duration`. Invalid inputs include: empty string, non-string values, unknown units, a negative sign, repeated units, a bare number mixed with units, and any trailing garbage.
