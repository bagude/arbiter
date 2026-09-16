import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoster, selectSpecialists, rosterSection } from "../lib/roster.mjs";

// prompts/orchestrator.md carries a single {{ROSTER}} placeholder in place of the old
// hard-coded "subagent_type \"worker\"" sentence; supervisor.mjs's prompt-assembly loop
// throws if it is missing and otherwise substitutes rosterSection(CONFIG.workers.specialists)
// there, once, before the orchestrator process exists. This test exercises the same
// substitution supervisor.mjs performs, without spawning anything.
const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = fs.readFileSync(path.join(here, "..", "prompts", "orchestrator.md"), "utf8");

test("prompts/orchestrator.md carries the {{ROSTER}} placeholder exactly once", () => {
	const matches = PROMPT.match(/\{\{ROSTER\}\}/g) ?? [];
	assert.equal(matches.length, 1);
});

test("substituting {{ROSTER}} for a legacy use: [\"worker\"] selection renders today's sentence", () => {
	const roster = loadRoster(path.join(here, "..", "roster"));
	const specialists = selectSpecialists(roster, ["worker"]);
	const replaced = PROMPT.replace("{{ROSTER}}", () => rosterSection(specialists));
	assert.doesNotMatch(replaced, /\{\{ROSTER\}\}/);
	assert.match(
		replaced,
		/^- `subagent` \(subagent_type "worker"\): Builds one piece of the task from the orchestrator's brief\.\n {2}Workers do not have the specification/m,
	);
});
