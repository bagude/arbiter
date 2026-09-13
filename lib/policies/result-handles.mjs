// Result-handles policy: large tool results leave the projected context after a
// couple of turns and become handles — an id, size, head and tail excerpts, and the
// recall hint — while the original is archived by the adapter. Pure: the session
// log is never edited, only the message list pi sends to the model. Worker reports
// need no special case: they arrive as the `subagent` tool's result.
//
// Evidence (docs/superpowers/specs/2026-09-13-working-context-design.md): on the
// explorer the orchestrator went 32k→64k tokens when a worker report returned, and
// the worker 47k→66k on its own file writes.
import fs from "node:fs";
import { createHash } from "node:crypto";

export const DEFAULTS = { minBytes: 8192, fullTurns: 2, headBytes: 1024, tailBytes: 512 };
const HANDLE_RE = /^h_[0-9a-f]{12}$/;

const sha = (s) => createHash("sha256").update(s).digest("hex");

function textOf(m) {
	if (m?.role !== "toolResult" || m.isError || !Array.isArray(m.content) || !m.content.length) return null;
	if (!m.content.every((c) => c?.type === "text")) return null;
	return m.content.map((c) => c.text ?? "").join("\n");
}

export function isHandleId(id) {
	return HANDLE_RE.test(String(id ?? ""));
}

/** Stable id for a result: the same tool call with the same content maps to the same file. */
export function handleIdFor(message) {
	const text = textOf(message) ?? "";
	return `h_${sha(`${message.toolName}\0${message.toolCallId}\0${sha(text)}`).slice(0, 12)}`;
}

function headLines(text, maxBytes) {
	let out = "";
	for (const line of text.split("\n")) {
		const next = out ? `${out}\n${line}` : line;
		if (Buffer.byteLength(next) > maxBytes) break;
		out = next;
	}
	return out;
}

function tailLines(text, maxBytes) {
	const parts = text.split("\n");
	let out = "";
	for (let i = parts.length - 1; i >= 0; i--) {
		const next = out ? `${parts[i]}\n${out}` : parts[i];
		if (Buffer.byteLength(next) > maxBytes) break;
		out = next;
	}
	return out;
}

export function placeholderFor({ id, tool, bytes, lines, head, tail, omitted }) {
	return [
		`[result handle ${id} · tool ${tool} · ${bytes} bytes, ${lines} lines · archived by the supervisor]`,
		head,
		`… (${omitted} bytes omitted) …`,
		tail,
		`[recall_result(id="${id}", offset=0) pages the original back, 16 KB at a time]`,
	].join("\n");
}

function countLines(text) {
	if (!text.length) return 0;
	let n = text.endsWith("\n") ? 0 : 1;
	for (const ch of text) if (ch === "\n") n++;
	return n;
}

/**
 * handleMessages(messages, opts) → { messages, archived }
 * Never mutates the input; unchanged messages are returned by reference. `archive(id,
 * text)` is called for every handle the policy produces (the adapter dedupes writes).
 */
export function handleMessages(messages, opts = {}) {
	const { minBytes, fullTurns, headBytes, tailBytes } = { ...DEFAULTS, ...opts };
	const archive = typeof opts.archive === "function" ? opts.archive : () => {};
	const archived = [];
	const assistantsAfter = new Array(messages.length).fill(0);
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		assistantsAfter[i] = count;
		if (messages[i]?.role === "assistant") count++;
	}
	const out = messages.map((m, i) => {
		const text = textOf(m);
		if (text === null || assistantsAfter[i] < fullTurns) return m;
		if (text.startsWith("[result handle h_")) return m; // already projected
		// A page of an archived result is already a bounded slice of an archive; archiving
		// it again would let a model chase its own recalls (seen live: 2026-09-13T13-55-16).
		if (m.toolName === "recall_result") return m;
		const bytes = Buffer.byteLength(text);
		if (bytes <= minBytes) return m;
		const id = handleIdFor(m);
		const head = headLines(text, headBytes);
		const tail = tailLines(text, tailBytes);
		const omitted = Math.max(0, bytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
		const lines = countLines(text);
		archive(id, text);
		archived.push({ id, tool: m.toolName, bytes, lines });
		return { ...m, content: [{ type: "text", text: placeholderFor({ id, tool: m.toolName, bytes, lines, head, tail, omitted }) }] };
	});
	return { messages: out, archived };
}

/** One page of an archived result, cut on whole lines, at most maxBytes/maxLines. */
export function readSlice(file, offset = 0, { maxBytes = 16384, maxLines = 400 } = {}) {
	const size = fs.statSync(file).size;
	const start = Math.max(0, Math.min(Number(offset) || 0, size));
	if (start >= size) return { text: "", bytes: 0, lines: 0, nextOffset: size, eof: true };
	const fd = fs.openSync(file, "r");
	let buf;
	try {
		buf = Buffer.alloc(Math.min(maxBytes, size - start));
		fs.readSync(fd, buf, 0, buf.length, start);
	} finally {
		fs.closeSync(fd);
	}
	let end = buf.length;
	const reachesEof = start + end >= size;
	if (!reachesEof) {
		const lastNl = buf.lastIndexOf(0x0a);
		if (lastNl > 0) end = lastNl + 1;
	}
	let text = buf.subarray(0, end).toString("utf8");
	let lines = countLines(text);
	if (lines > maxLines) {
		const parts = text.split("\n").slice(0, maxLines);
		text = `${parts.join("\n")}\n`;
		end = Buffer.byteLength(text);
		lines = maxLines;
	}
	const nextOffset = start + end;
	return { text, bytes: end, lines, nextOffset, eof: nextOffset >= size };
}
