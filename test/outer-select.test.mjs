import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidates } from "../tools/outer-select.mjs";

const pt = (i, cls, tool, params, S, gs) => ({ i, action: { cls, tool, params }, substantive: S ? { cls: S, gatherSteps: gs } : null });
const head = (i, pickClass, confidence) => ({ i, head: { pickClass, confidence } });
const jev = (i, pick, pPick = 0.9) => ({ i, score: { substantive: { pick, pPick } } });

test("selectCandidates keeps cheap, guard-free gathers both heads would skip, ranked by the 27B's confidence", () => {
	const points = [
		pt(0, "inspect", "read", { path: "README.md" }, "spawn", 3),            // first read: not cheap
		pt(1, "inspect", "ls", { path: "." }, "spawn", 1),                      // candidate
		pt(2, "spawn", "subagent", {}, "spawn", 0),
		pt(3, "inspect", "read", { path: "src/__tests__/t.mjs" }, "spawn", 1),  // tests read before a spawn: guard-required
		pt(4, "inspect", "read", { path: "README.md" }, "done", 2),             // re-read: candidate
		pt(5, "checkpoint", "checkpoint", {}, "done", 1),                       // heads disagree below
		pt(6, "memory", "memory_search", { query: "x" }, "resume", 1),          // not cheap
	];
	const heads = [head(0, "spawn", 1), head(1, "spawn", 0.97), head(3, "spawn", 0.99), head(4, "done", 1), head(5, "probe", 0.9), head(6, "resume", 0.99)];
	const jevs = [jev(1, "spawn"), jev(4, "done", 0.6)];
	const out = selectCandidates(points, heads, jevs, { minP: 0.95 });
	assert.deepEqual(out.map((c) => c.call), [5, 2], "the re-read (p 1.00) outranks the ls (0.97); nothing else qualifies");
	assert.equal(out[0].action, "done");
	assert.equal(out[1].jev, "spawn 0.90");
	// A Jev row that names a different action vetoes; a missing Jev row does not.
	assert.deepEqual(selectCandidates(points, heads, [jev(1, "probe")], { minP: 0.95 }).map((c) => c.call), [5]);
	assert.deepEqual(selectCandidates(points, heads, [], { minP: 0.95 }).map((c) => c.call), [5, 2]);
	// Below the confidence floor nothing is selected.
	assert.deepEqual(selectCandidates(points, heads, jevs, { minP: 1.01 }), []);
});
