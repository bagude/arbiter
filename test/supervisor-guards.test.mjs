import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi's extension runner returns the FIRST blocking tool_call result, so a guard
// that denies `subagent` must precede pre-spawn-compact in supervisor.mjs's GUARDS
// list or its reason never reaches the model. Read the source rather than import
// supervisor.mjs (importing it starts a run).
test("GUARDS lists topology.ts immediately before pre-spawn-compact.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const t = names.indexOf("topology.ts");
	assert.ok(t >= 0, `topology.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[t + 1], "pre-spawn-compact.ts");
});

// pi's extension runner returns the FIRST blocking tool_call result, so the fork's
// forcing must be seen before the topology nudge on the same spawn.
test("GUARDS lists fork-force.ts immediately before topology.ts", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	const names = [...src.matchAll(/path\.join\(here, "ext", (?:"guards", )?"([^"]+)"\)/g)].map((m) => m[1]);
	const f = names.indexOf("fork-force.ts");
	assert.ok(f >= 0, `fork-force.ts missing from GUARDS: ${names.join(", ")}`);
	assert.equal(names[f + 1], "topology.ts");
});

// Fork mode is env-driven and lives entirely inside supervisor.mjs, which no test
// can import (importing it starts a run). Task 6 is the real verification; this
// pins the shape so the four load-bearing pieces cannot quietly go missing:
// the fork spec is read, the orchestrator is resumed from a session FILE, the
// lifecycle records the continue, and the kickoff is skipped when forking.
test("supervisor carries fork mode: forkSpec, --session, fork:continue, guarded kickoff", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, "..", "supervisor.mjs"), "utf8");
	assert.match(src, /import \{[^}]*\bforkSpec\b[^}]*\} from "\.\/lib\/fork\.mjs"/, "supervisor must import forkSpec from ./lib/fork.mjs");
	// The quotes matter: bare --session also matches the existing "--session-dir".
	assert.ok(src.includes('"--session"'), 'supervisor must pass "--session" (the truncated file) to the forked orchestrator');
	assert.ok(src.includes('ev: "fork:continue"'), "supervisor must append a fork:continue lifecycle event");
	const lines = src.split("\n");
	const k = lines.findIndex((l) => l.includes("M.kickoff.orchestrator()"));
	assert.ok(k >= 0, "M.kickoff.orchestrator() missing from supervisor.mjs");
	const window = lines.slice(Math.max(0, k - 3), k + 4).join("\n");
	assert.ok(window.includes("FORK"), `the orchestrator kickoff must sit in a branch guarded by FORK; found:\n${window}`);
});
