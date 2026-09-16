import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRosterFile, loadRoster, selectSpecialists, renderDefinition, rosterSection, ROSTER_TOOLS } from "../lib/roster.mjs";

function tmpRoster(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	return dir;
}
const TESTER = `---
name: tester
description: Writes and runs tests against the spec.
tools: read, bash, write, memory_search, remember
thinking: off
background: false
maxTurns: 40
memory: tester
---
You are TESTER.
`;

test("parseRosterFile reads frontmatter and body", () => {
	const dir = tmpRoster({ "tester.md": TESTER });
	const s = parseRosterFile(path.join(dir, "tester.md"));
	assert.equal(s.name, "tester");
	assert.equal(s.description, "Writes and runs tests against the spec.");
	assert.deepEqual(s.tools, ["read", "bash", "write", "memory_search", "remember"]);
	assert.equal(s.thinking, "off");
	assert.equal(s.background, false);
	assert.equal(s.maxTurns, 40);
	assert.equal(s.memory, "tester");
	assert.equal(s.body, "You are TESTER.");
});

test("defaults: memory = name, maxTurns 60, background false, thinking null", () => {
	const dir = tmpRoster({ "scout.md": "---\nname: scout\ndescription: Maps the repo.\ntools: read, ls\n---\nbody\n" });
	const s = parseRosterFile(path.join(dir, "scout.md"));
	assert.equal(s.memory, "scout");
	assert.equal(s.maxTurns, 60);
	assert.equal(s.background, false);
	assert.equal(s.thinking, null);
});

test("rejects model:, name/filename mismatch, unknown tool, missing description, bad thinking", () => {
	const dir = tmpRoster({
		"a.md": "---\nname: a\ndescription: x\ntools: read\nmodel: llama.cpp/qwen3-27b\n---\nb\n",
		"b.md": "---\nname: c\ndescription: x\ntools: read\n---\nb\n",
		"d.md": "---\nname: d\ndescription: x\ntools: read, teleport\n---\nb\n",
		"e.md": "---\nname: e\ntools: read\n---\nb\n",
		"f.md": "---\nname: f\ndescription: x\ntools: read\nthinking: max\n---\nb\n",
	});
	assert.throws(() => parseRosterFile(path.join(dir, "a.md")), /model: is not allowed/);
	assert.throws(() => parseRosterFile(path.join(dir, "b.md")), /name "c" does not match file "b"/);
	assert.throws(() => parseRosterFile(path.join(dir, "d.md")), /unknown tool "teleport"/);
	assert.throws(() => parseRosterFile(path.join(dir, "e.md")), /description is required/);
	assert.throws(() => parseRosterFile(path.join(dir, "f.md")), /thinking must be one of/);
});

test("loadRoster maps every .md in the dir; selectSpecialists keeps the requested order and names unknowns", () => {
	const dir = tmpRoster({ "tester.md": TESTER, "scout.md": "---\nname: scout\ndescription: Maps.\ntools: read\n---\nb\n" });
	const roster = loadRoster(dir);
	assert.deepEqual([...roster.keys()].sort(), ["scout", "tester"]);
	assert.deepEqual(selectSpecialists(roster, ["tester", "scout"]).map((s) => s.name), ["tester", "scout"]);
	assert.throws(() => selectSpecialists(roster, ["ghost"]), /unknown specialist "ghost" \(roster has: scout, tester\)/);
});

test("renderDefinition emits pi-subagents frontmatter with model from config, overrides applied, extra tools and suffix appended", () => {
	const dir = tmpRoster({ "tester.md": TESTER });
	const s = parseRosterFile(path.join(dir, "tester.md"));
	const md = renderDefinition(s, { provider: "llama.cpp", model: "qwen3-27b", thinking: "low", background: true, extraTools: ["report"], promptSuffix: "Call report once." });
	const lines = md.split("\n");
	assert.equal(lines[0], "---");
	assert.ok(lines.includes("name: tester"));
	assert.ok(lines.includes("description: Writes and runs tests against the spec."));
	assert.ok(lines.includes("tools: read,bash,write,memory_search,remember,report"));
	assert.ok(lines.includes("model: llama.cpp/qwen3-27b"));
	assert.ok(lines.includes("thinking: low"));
	assert.ok(lines.includes("max_turns: 40"));
	assert.ok(lines.includes("run_in_background: true"));
	assert.ok(md.endsWith("You are TESTER.\n\nCall report once.\n"));
	const md2 = renderDefinition(s, { provider: "p", model: "m" });
	assert.ok(md2.includes("thinking: off"), "roster thinking used when no override");
	assert.ok(md2.includes("run_in_background: false"));
	assert.ok(!md2.includes("report"));
});

test("rosterSection lists each specialist as `subagent_type` with its description, in order", () => {
	const dir = tmpRoster({ "tester.md": TESTER, "scout.md": "---\nname: scout\ndescription: Maps the repo.\ntools: read\n---\nb\n" });
	const roster = loadRoster(dir);
	const text = rosterSection(selectSpecialists(roster, ["scout", "tester"]));
	assert.match(text, /^- `subagent` \(subagent_type "scout"\): Maps the repo\./m);
	assert.match(text, /^- `subagent` \(subagent_type "tester"\): Writes and runs tests against the spec\./m);
	assert.ok(text.indexOf('"scout"') < text.indexOf('"tester"'));
	assert.match(text, /One worker runs at a time/);
});

test("ROSTER_TOOLS covers every tool the shipped roster files use, and the four shipped files parse", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	assert.deepEqual([...roster.keys()].sort(), ["implementer", "scout", "tester", "worker"]);
	for (const s of roster.values()) for (const t of s.tools) assert.ok(ROSTER_TOOLS.includes(t), `${s.name} uses ${t}`);
	assert.deepEqual(roster.get("scout").tools.filter((t) => ["bash", "edit", "write"].includes(t)), [], "scout is read-only");
});
