import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionEntryToEvents } from "../lib/session-adapter.mjs";

const [sessionHeader, assistant, toolResult] = fs.readFileSync("test/fixtures/session-entries.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("non-message entries produce nothing", () => {
	assert.deepEqual(sessionEntryToEvents(sessionHeader), []);
});
test("an assistant message yields tool_execution_start per toolCall and one message_end", () => {
	const evs = sessionEntryToEvents(assistant);
	const starts = evs.filter((e) => e.type === "tool_execution_start");
	assert.ok(starts.length >= 1);
	assert.equal(starts[0].toolName, "read");
	assert.deepEqual(starts[0].args, { path: "README.md" });
	assert.equal(typeof starts[0].toolCallId, "string");
	const end = evs.find((e) => e.type === "message_end");
	assert.equal(end.message.role, "assistant");
	assert.equal(typeof end.message.usage.input, "number");
});
test("a toolResult message yields tool_execution_end with the same id", () => {
	const evs = sessionEntryToEvents(toolResult);
	assert.deepEqual(evs, [{ type: "tool_execution_end", toolCallId: toolResult.message.toolCallId }]);
});
