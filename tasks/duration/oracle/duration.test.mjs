// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "./src/duration.mjs";

const ok = [
	["1h30m", 5400],
	["1h 30m", 5400],
	["2d", 172800],
	["45S", 45],
	["90", 90],
	["1.5h", 5400],
	["  10m ", 600],
	["30m1h", 5400],
	["0", 0],
	["0s", 0],
	["1.5s", 2],
	["1D2H", 93600],
];

for (const [input, expected] of ok) {
	test(`parses ${JSON.stringify(input)} -> ${expected}`, () => {
		assert.equal(parseDuration(input), expected);
	});
}

const bad = ["", "1m1m", "-5m", "5x", "90 1h", ".5h", "1h extra", 42, null];

for (const input of bad) {
	test(`rejects ${JSON.stringify(input)}`, () => {
		assert.throws(
			() => parseDuration(input),
			(err) => err instanceof RangeError && /^invalid duration/.test(err.message),
		);
	});
}
