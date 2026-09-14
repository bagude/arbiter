import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Drives ext/guards/pre-spawn-compact.ts through tsx with a fake `pi`: a `context`
// event caches the message list's size, then `tool_call` events are fed against it.
// The guard is opt-in — it registers nothing unless ARBITER_PRE_SPAWN_COMPACT is set.
const PI = "C:/Users/user/open_harnessess/pi/pi";

function run({ contextMessages, calls, env = {} }) {
	const lifecycle = path.join(os.tmpdir(), `pre-spawn-compact-${process.pid}-${Date.now()}.jsonl`);
	const driver = path.join(os.tmpdir(), `pre-spawn-compact-driver-${process.pid}.mjs`);
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const mod = await import(pathToFileURL(${JSON.stringify(path.resolve("ext/guards/pre-spawn-compact.ts"))}).href);
		const handlers = {};
		mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, events: { on() {} } });
		const ctx = { cwd: "C:/ws", sessionManager: { getSessionFile: () => undefined } };
		const out = [];
		if (handlers.context) await handlers.context({ type: "context", messages: ${JSON.stringify(contextMessages ?? [])} }, ctx);
		for (const input of ${JSON.stringify(calls)}) {
			out.push(handlers.tool_call ? await handlers.tool_call({ type: "tool_call", toolCallId: "t1", toolName: "subagent", input }, ctx) : "not-registered");
		}
		console.log(JSON.stringify({ registered: Object.keys(handlers), out }));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, NODE_PATH: `${PI}/node_modules`, ARBITER_PRE_SPAWN_COMPACT: "", ...env },
	});
	assert.equal(r.status, 0, r.stderr);
	const lines = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	return { ...JSON.parse(r.stdout.trim()), lines };
}

const BIG_MESSAGES = [{ role: "user", content: "x".repeat(150000) }];

test("not registered when ARBITER_PRE_SPAWN_COMPACT is unset", () => {
	const { registered, out } = run({ contextMessages: BIG_MESSAGES, calls: [{}] });
	assert.deepEqual(registered, []);
	assert.deepEqual(out, ["not-registered"]);
});

test("a fresh foreground spawn is denied when context is over threshold, and reports the deny", () => {
	const { registered, out, lines } = run({
		contextMessages: BIG_MESSAGES,
		calls: [{}],
		env: { ARBITER_PRE_SPAWN_COMPACT: JSON.stringify({ thresholdChars: 100000 }) },
	});
	assert.deepEqual(registered, ["context", "tool_call"]);
	assert.equal(out[0].block, true);
	assert.match(out[0].reason, /checkpoint/);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].ev, "guard:pre_spawn_compact_denied");
	assert.equal(lines[0].data.role, "orchestrator");
	assert.equal(lines[0].data.thresholdChars, 100000);
});

test("one-shot: the very next attempt goes through unconditionally, even with the same fat context", () => {
	const { out, lines } = run({
		contextMessages: BIG_MESSAGES,
		calls: [{}, {}],
		env: { ARBITER_PRE_SPAWN_COMPACT: JSON.stringify({ thresholdChars: 100000 }) },
	});
	assert.equal(out[0].block, true, "first attempt denied");
	assert.equal(out[1], null, "second attempt let through (guard returns undefined; JSON carries it as null)");
	assert.equal(lines.length, 1, "only the first attempt is reported");
});

test("under threshold, a resume, or a background spawn: never denied", () => {
	const smallMessages = [{ role: "user", content: "hi" }];
	const { out: underThreshold } = run({ contextMessages: smallMessages, calls: [{}], env: { ARBITER_PRE_SPAWN_COMPACT: JSON.stringify({ thresholdChars: 100000 }) } });
	assert.equal(underThreshold[0], null);

	const { out: resumed } = run({ contextMessages: BIG_MESSAGES, calls: [{ resume: "worker:abc" }], env: { ARBITER_PRE_SPAWN_COMPACT: JSON.stringify({ thresholdChars: 100000 }) } });
	assert.equal(resumed[0], null);

	const { out: background } = run({ contextMessages: BIG_MESSAGES, calls: [{ run_in_background: true }], env: { ARBITER_PRE_SPAWN_COMPACT: JSON.stringify({ thresholdChars: 100000 }) } });
	assert.equal(background[0], null);
});

test("ARBITER_PRE_SPAWN_COMPACT=1 means the default threshold (100000 chars)", () => {
	const { out } = run({ contextMessages: BIG_MESSAGES, calls: [{}], env: { ARBITER_PRE_SPAWN_COMPACT: "1" } });
	assert.equal(out[0].block, true);
});
