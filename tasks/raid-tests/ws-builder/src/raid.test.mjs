import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "./raid.mjs";

// The suite for src/raid.mjs. Graded by whether it catches planted bugs — see README.md.

test("module loads with its sample champions", () => {
	assert.equal(typeof R.makeChampion, "function");
	assert.deepEqual(Object.keys(R.SAMPLE_CHAMPIONS), ["kael", "vell", "grim", "nyx"]);
});
