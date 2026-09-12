import { test } from "node:test";
import assert from "node:assert/strict";
import { dietMessages } from "../lib/policies/context-diet.mjs";

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: {}, stopReason: "toolUse" });
const think = (s) => ({ type: "thinking", thinking: s, thinkingSignature: "sig" });
const text = (s) => ({ type: "text", text: s });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, body, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], isError: false, ...extra });
const big = (n) => "x".repeat(n);

const OPTS = { ageAfterTurns: 2, ageTools: ["read", "bash"], ageMinChars: 100 };

test("thinking is dropped from assistant messages before the latest user message, kept after it", () => {
	const msgs = [
		user("do it"),
		assistant([think("old reasoning"), text("ok"), call("c1", "read", { path: "a" })]),
		result("c1", "read", "short"),
		user("next"),
		assistant([think("current reasoning"), call("c2", "read", { path: "b" })]),
		result("c2", "read", "short"),
	];
	const { messages, stats } = dietMessages(msgs, OPTS);
	assert.deepEqual(messages[1].content, [text("ok"), call("c1", "read", { path: "a" })]);
	assert.deepEqual(messages[4].content, [think("current reasoning"), call("c2", "read", { path: "b" })]);
	assert.equal(stats.thinkingDropped, 1);
});

test("thinking is dropped from every assistant message except the last, even with no later user message", () => {
	// In rpc runs an agent sees few user messages (kickoff, then supervisor mail); a
	// tool loop is many assistant messages under one user message. Only the last
	// assistant message's thinking can still matter (its in-flight tool call).
	const msgs = [
		user("go"),
		assistant([think("step 1"), call("c1", "read", {})]),
		result("c1", "read", "r"),
		assistant([think("step 2"), call("c2", "read", {})]),
		result("c2", "read", "r"),
		assistant([think("step 3"), text("done")]),
	];
	const { messages, stats } = dietMessages(msgs, OPTS);
	assert.deepEqual(messages[1].content, [call("c1", "read", {})]);
	assert.deepEqual(messages[3].content, [call("c2", "read", {})]);
	assert.deepEqual(messages[5].content, [think("step 3"), text("done")]);
	assert.equal(stats.thinkingDropped, 2);
});

test("an assistant message that becomes empty keeps a placeholder text so the turn stays valid", () => {
	const msgs = [user("a"), assistant([think("only thinking")]), user("b"), assistant([text("hi")])];
	const { messages } = dietMessages(msgs, OPTS);
	assert.deepEqual(messages[1].content, [text("(reasoning elided)")]);
});

test("a large tool result older than ageAfterTurns is replaced by a stub that keeps its identity", () => {
	const msgs = [
		user("go"),
		assistant([call("c1", "read", { path: "src/a.mjs" })]),
		result("c1", "read", big(500), { details: { lines: 40 } }),
		assistant([text("turn 2"), call("c2", "bash", { command: "ls" })]),
		result("c2", "bash", big(500)),
		assistant([text("turn 3"), call("c3", "read", { path: "src/b.mjs" })]),
		result("c3", "read", big(500)),
		assistant([text("turn 4 (current)")]),
	];
	const { messages, stats } = dietMessages(msgs, OPTS);
	const r1 = messages[2];
	assert.equal(r1.role, "toolResult");
	assert.equal(r1.toolCallId, "c1");
	assert.equal(r1.toolName, "read");
	assert.equal(r1.isError, false);
	assert.deepEqual(r1.details, { lines: 40 });
	assert.equal(r1.content.length, 1);
	assert.match(r1.content[0].text, /^\[read result elided by the supervisor: 500 chars\. Call the tool again if you need it\.\]$/);
	// c2 is 2 turns old → aged; c3 is 1 turn old → kept; the current turn untouched
	assert.match(messages[4].content[0].text, /elided/);
	assert.equal(messages[6].content[0].text, big(500));
	assert.equal(stats.resultsAged, 2);
	assert.equal(stats.charsSaved, 2 * 500 - r1.content[0].text.length - messages[4].content[0].text.length);
});

test("small results, error results, and tools outside ageTools are never aged", () => {
	const msgs = [
		user("go"),
		assistant([call("c1", "read", {}), call("c2", "send_mail", {}), call("c3", "read", {})]),
		result("c1", "read", "tiny"),
		result("c2", "send_mail", big(500)),
		result("c3", "read", big(500), { isError: true }),
		assistant([text("2")]),
		assistant([text("3")]),
		assistant([text("4")]),
	];
	const { messages, stats } = dietMessages(msgs, OPTS);
	assert.equal(messages[2].content[0].text, "tiny");
	assert.equal(messages[3].content[0].text, big(500));
	assert.equal(messages[4].content[0].text, big(500));
	assert.equal(stats.resultsAged, 0);
});

test("the diet is idempotent and never changes the number or order of messages", () => {
	const msgs = [
		user("go"),
		assistant([think("t"), call("c1", "read", {})]),
		result("c1", "read", big(500)),
		assistant([text("2")]),
		assistant([text("3")]),
		user("again"),
		assistant([think("now")]),
	];
	const once = dietMessages(msgs, OPTS);
	const twice = dietMessages(once.messages, OPTS);
	assert.deepEqual(twice.messages, once.messages);
	assert.equal(twice.stats.thinkingDropped + twice.stats.resultsAged, 0);
	assert.equal(once.messages.length, msgs.length);
	assert.deepEqual(once.messages.map((m) => m.role), msgs.map((m) => m.role));
});

test("input messages are not mutated", () => {
	const msgs = [user("go"), assistant([think("t"), text("a")]), user("b"), assistant([text("c")])];
	const snapshot = JSON.stringify(msgs);
	dietMessages(msgs, OPTS);
	assert.equal(JSON.stringify(msgs), snapshot);
});

test("unknown roles and image content pass through untouched", () => {
	const custom = { role: "custom", content: "x" };
	const img = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", data: "…", mimeType: "image/png" }], isError: false };
	const msgs = [user("go"), assistant([call("c1", "read", {})]), img, custom, assistant([text("2")]), assistant([text("3")]), assistant([text("4")])];
	const { messages } = dietMessages(msgs, OPTS);
	assert.deepEqual(messages[2], img);
	assert.deepEqual(messages[3], custom);
});
