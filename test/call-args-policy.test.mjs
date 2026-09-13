import { test } from "node:test";
import assert from "node:assert/strict";
import { elideCallArgs } from "../lib/policies/call-args.mjs";

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: {}, stopReason: "toolUse" });
const text = (s) => ({ type: "text", text: s });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, body) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], isError: false });
const big = "x".repeat(4000);

test("old write and edit contents become stubs that keep the path; recent and small ones stay", () => {
	const msgs = [
		user("go"),
		assistant([think(), call("w1", "write", { path: "src/a.py", content: big })]),
		result("w1", "write", "ok"),
		assistant([call("e1", "edit", { path: "src/a.py", oldText: big, newText: "small" })]),
		result("e1", "edit", "ok"),
		assistant([call("w2", "write", { path: "src/b.py", content: big })]),
		result("w2", "write", "ok"),
		assistant([text("done")]),
	];
	const { messages, stats } = elideCallArgs(msgs, { afterTurns: 2, minChars: 1500 });
	const w1 = messages[1].content[1].arguments;
	assert.equal(w1.path, "src/a.py");
	assert.match(w1.content, /^\[elided by the supervisor: 4000 chars of content for src\/a\.py; the file is on disk/);
	const e1 = messages[3].content[0].arguments;
	assert.match(e1.oldText, /elided by the supervisor: 4000 chars of oldText/);
	assert.equal(e1.newText, "small", "short fields are kept");
	assert.equal(messages[5].content[0].arguments.content, big, "only one assistant turn after it: kept");
	assert.equal(messages[1].content[0].type, "thinking", "other blocks untouched");
	assert.equal(stats.callsElided, 2);
	assert.ok(stats.charsSaved > 7000);
	assert.equal(messages[0], msgs[0]);
	assert.equal(messages[5], msgs[5], "unchanged messages are returned by reference");
});

test("applying the policy to its own output changes nothing", () => {
	const msgs = [user("go"), assistant([call("w1", "write", { path: "a", content: big })]), result("w1", "write", "ok"), assistant([]), assistant([])];
	const once = elideCallArgs(msgs);
	const twice = elideCallArgs(once.messages);
	assert.deepEqual(twice.messages, once.messages);
	assert.equal(twice.stats.callsElided, 0);
});

test("tools other than write and edit are never touched", () => {
	const msgs = [user("go"), assistant([call("b1", "bash", { command: big })]), result("b1", "bash", "ok"), assistant([]), assistant([])];
	assert.equal(elideCallArgs(msgs).stats.callsElided, 0);
});

function think() {
	return { type: "thinking", thinking: "hmm", thinkingSignature: "sig" };
}
