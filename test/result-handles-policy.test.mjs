import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMessages, handleIdFor, readSlice } from "../lib/policies/result-handles.mjs";

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, api: "x", provider: "p", model: "m", usage: {}, stopReason: "toolUse" });
const text = (s) => ({ type: "text", text: s });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, body, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: body }], isError: false, details: { path: "a" }, ...extra });
const lines = (n, width = 60) => Array.from({ length: n }, (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(width)}`).join("\n");

function archiveSpy() {
	const calls = [];
	return { calls, archive: (id, body) => calls.push({ id, bytes: Buffer.byteLength(body) }) };
}

test("a large old result becomes a placeholder that keeps identity and carries head, tail and the recall hint", () => {
	const body = lines(200); // ~13 KB
	const msgs = [user("go"), assistant([call("c1", "read", { path: "a" })]), result("c1", "read", body), assistant([text("ok")]), assistant([text("more")])];
	const spy = archiveSpy();
	const { messages, archived } = handleMessages(msgs, { minBytes: 8192, fullTurns: 2, archive: spy.archive });
	const r = messages[2];
	assert.equal(r.toolCallId, "c1");
	assert.equal(r.toolName, "read");
	assert.deepEqual(r.details, { path: "a" });
	assert.equal(r.isError, false);
	const t = r.content[0].text;
	assert.match(t, /^\[result handle h_[0-9a-f]{12} · tool read · \d+ bytes, 200 lines · archived by the supervisor\]/);
	assert.match(t, /line 00000 /);
	assert.match(t, /line 00199 /);
	assert.match(t, /\(\d+ bytes omitted\)/);
	assert.match(t, /recall_result\(id="h_[0-9a-f]{12}", offset=0\)/);
	assert.ok(t.length < 2500, `placeholder is ${t.length} chars`);
	assert.equal(archived.length, 1);
	assert.equal(archived[0].tool, "read");
	assert.equal(spy.calls.length, 1);
	assert.equal(spy.calls[0].id, archived[0].id);
	assert.equal(archived[0].id, handleIdFor(msgs[2]));
});

test("results that are recent, small, or errors are left alone; worker reports are covered", () => {
	const body = lines(200);
	const recent = [user("go"), assistant([call("c1", "read", {})]), result("c1", "read", body), assistant([text("ok")])];
	assert.equal(handleMessages(recent, { fullTurns: 2, archive: () => {} }).archived.length, 0);
	const small = [user("go"), assistant([call("c1", "read", {})]), result("c1", "read", lines(20)), assistant([]), assistant([])];
	assert.equal(handleMessages(small, { archive: () => {} }).archived.length, 0);
	const err = [user("go"), assistant([call("c1", "bash", {})]), result("c1", "bash", body, { isError: true }), assistant([]), assistant([])];
	assert.equal(handleMessages(err, { archive: () => {} }).archived.length, 0);
	const report = [user("go"), assistant([call("s1", "subagent", {})]), result("s1", "subagent", body), assistant([]), assistant([])];
	const out = handleMessages(report, { archive: () => {} });
	assert.equal(out.archived.length, 1);
	assert.equal(out.archived[0].tool, "subagent");
});

test("applying the policy to its own output changes nothing and archives nothing new", () => {
	const msgs = [user("go"), assistant([call("c1", "read", {})]), result("c1", "read", lines(200)), assistant([]), assistant([])];
	const spy = archiveSpy();
	const first = handleMessages(msgs, { archive: spy.archive });
	const second = handleMessages(first.messages, { archive: spy.archive });
	assert.deepEqual(second.messages, first.messages);
	assert.equal(second.archived.length, 0);
	assert.equal(spy.calls.length, 1);
	// A second application on the ORIGINAL messages (the projection is recomputed every
	// request) archives only through the callback's own dedupe: the policy reports it.
	const third = handleMessages(msgs, { archive: spy.archive });
	assert.equal(third.archived.length, 1, "the policy reports the handle each time; the adapter dedupes writes by id");
});

test("readSlice pages a file in bounded steps", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-handles-"));
	const f = path.join(dir, "h.txt");
	fs.writeFileSync(f, lines(700)); // ~45 KB
	const a = readSlice(f, 0, { maxBytes: 16384, maxLines: 400 });
	assert.ok(a.bytes <= 16384 && a.lines <= 400, `${a.bytes} bytes ${a.lines} lines`);
	assert.equal(a.eof, false);
	assert.ok(a.text.endsWith("\n") || a.lines === 400, "cuts on whole lines");
	let total = a.bytes;
	let page = a;
	let pages = 1;
	while (!page.eof) {
		page = readSlice(f, page.nextOffset, { maxBytes: 16384, maxLines: 400 });
		total += page.bytes;
		pages++;
	}
	assert.equal(pages, 4, "a 50 KB file takes four 16 KB pages");
	assert.equal(total, fs.statSync(f).size);
	assert.equal(readSlice(f, 10 ** 9).eof, true);
});
