import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDER_TOOLS, ORCHESTRATOR_TOOLS, WORKER_TOOLS, PATTERNS } from "../lib/patterns.mjs";

// context_usage is registered unconditionally on every role (see the GUARDS list in
// supervisor.mjs), but supervisor.mjs passes each role's tool list to pi as an
// allowlist (`-t cfg.tools`) that also filters extension-registered tools — so the
// tool is only reachable if every one of these lists names it explicitly.

test("BUILDER_TOOLS includes context_usage", () => {
	assert.ok(BUILDER_TOOLS.split(",").includes("context_usage"));
});

test("ORCHESTRATOR_TOOLS includes context_usage", () => {
	assert.ok(ORCHESTRATOR_TOOLS.split(",").includes("context_usage"));
});

test("WORKER_TOOLS includes context_usage", () => {
	assert.ok(WORKER_TOOLS.includes("context_usage"));
});

test("dyad critic's tool string includes context_usage", () => {
	assert.ok(PATTERNS.dyad.tools.critic.split(",").includes("context_usage"));
});
