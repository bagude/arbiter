import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseRosterFile, loadRoster, selectSpecialists, renderDefinition, rosterSection, rosterOrder, ROSTER_TOOLS, ARTIFACTS } from "../lib/roster.mjs";

// pi-subagents parses agent frontmatter with the real `yaml` package
// (custom-agents.ts loadCustomAgents -> pi-coding-agent's parseFrontmatter), which
// throws on a compact-mapping colon like scout's "before anyone edits: files,
// exports..." when renderDefinition emits description/model as unquoted scalars.
// lib/roster.mjs's own hand-rolled parseFrontmatter (first-colon split) does not
// catch this class of bug, so this test drives pi's real loader instead.
import { PI_ROOT } from "../lib/pi-root.mjs";
const PI = PI_ROOT;

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
	assert.ok(lines.includes('description: "Writes and runs tests against the spec."'));
	assert.ok(lines.includes("tools: read,bash,write,memory_search,remember,report"));
	assert.ok(lines.includes('model: "llama.cpp/qwen3-27b"'));
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

test("needs/produces: parsed as lists over ARTIFACTS, default [], bad names rejected", () => {
	const dir = tmpRoster({
		"tester.md": TESTER.replace("memory: tester\n", "memory: tester\nneeds: api\nproduces: tests\n"),
		"plain.md": "---\nname: plain\ndescription: No topology.\ntools: read\n---\nb\n",
		"bad.md": "---\nname: bad\ndescription: Bad artifact.\ntools: read\nneeds: api, coffee\n---\nb\n",
	});
	assert.deepEqual(ARTIFACTS, ["api", "tests", "code", "map", "review"]);
	const tester = parseRosterFile(path.join(dir, "tester.md"));
	assert.deepEqual(tester.needs, ["api"]);
	assert.deepEqual(tester.produces, ["tests"]);
	const plain = parseRosterFile(path.join(dir, "plain.md"));
	assert.deepEqual(plain.needs, []);
	assert.deepEqual(plain.produces, []);
	assert.throws(() => parseRosterFile(path.join(dir, "bad.md")), /bad\.md: unknown artifact "coffee" in needs \(known: api, tests, code, map, review\)/);
});

test("selectSpecialists rejects a produces->needs cycle among the selected set and names it", () => {
	const dir = tmpRoster({
		"a.md": "---\nname: a\ndescription: A.\ntools: read\nneeds: tests\nproduces: code\n---\nb\n",
		"b.md": "---\nname: b\ndescription: B.\ntools: read\nneeds: code\nproduces: tests\n---\nb\n",
		"c.md": "---\nname: c\ndescription: C.\ntools: read\nproduces: tests\n---\nb\n",
	});
	const roster = loadRoster(dir);
	assert.throws(() => selectSpecialists(roster, ["a", "b"]), /topology cycle among selected specialists: a -> b -> a/);
	// the cycle is only among the selected set: c produces tests without needing code
	assert.equal(selectSpecialists(roster, ["a", "c"]).length, 2);
});

test("the shipped roster declares the intended topology", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	assert.deepEqual(roster.get("tester").needs, ["api"]);
	assert.deepEqual(roster.get("tester").produces, ["tests"]);
	assert.deepEqual(roster.get("implementer").needs, ["api", "tests"]);
	assert.deepEqual(roster.get("implementer").produces, ["code"]);
	assert.deepEqual(roster.get("scout").needs, []);
	assert.deepEqual(roster.get("scout").produces, ["map"]);
	assert.deepEqual(roster.get("worker").needs, []);
	assert.deepEqual(roster.get("worker").produces, []);
});

// Cases 7 and 8 of docs/batch/harness-text-audit-2026-09-17.md. The tester's own prompt
// named the case that beat run 2026-09-17T16-47-16 — relative(".", "a") — and a sibling
// clause let it be dropped without a word; the orchestrator's roster blurb never said
// the tester carried a degenerate-input mandate, so it never looked for that output.
// Neither prompt may pin a test command, since the brief chooses how the suite runs.
test("the shipped tester declares degenerate-input coverage, drops cases out loud, and neither prompt pins a test command", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	const tester = roster.get("tester");
	assert.match(tester.description, /covers each argument's degenerate inputs and names, under findings, every such case the brief did not determine/);
	assert.match(rosterSection(selectSpecialists(roster, ["tester"])), /^- `subagent` \(subagent_type "tester"\): .*degenerate inputs/m);
	assert.match(tester.body, /list it explicitly under findings as an undetermined case/);
	assert.match(tester.body, /never drop it silently/);
	assert.match(tester.body, /Run the suite once, the way the brief specifies/);
	assert.doesNotMatch(tester.body, /node --test src\/__tests__/);
	assert.match(roster.get("implementer").body, /run it first the way the brief specifies/);
	assert.doesNotMatch(roster.get("implementer").body, /node --test src\/__tests__/);
});

test("ROSTER_TOOLS covers every tool the shipped roster files use, and the four shipped files parse", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	assert.deepEqual([...roster.keys()].sort(), ["implementer", "scout", "tester", "worker"]);
	for (const s of roster.values()) for (const t of s.tools) assert.ok(ROSTER_TOOLS.includes(t), `${s.name} uses ${t}`);
	assert.deepEqual(roster.get("scout").tools.filter((t) => ["bash", "edit", "write"].includes(t)), [], "scout is read-only");
});

test("renderDefinition's output is YAML-safe: pi-subagents' own loadCustomAgents finds all four shipped specialists, and the yaml package parses one verbatim", async () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const roster = loadRoster(path.join(here, "..", "roster"));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roster-render-"));
	const agentsDir = path.join(tmp, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	for (const spec of roster.values()) {
		const md = renderDefinition(spec, { provider: "llama.cpp", model: "qwen3-27b" });
		fs.writeFileSync(path.join(agentsDir, `${spec.name}.md`), md);
	}

	const customAgents = path.resolve(here, "..", "node_modules", "@gotgenes", "pi-subagents", "src", "config", "custom-agents.ts");
	const driver = path.join(tmp, "driver.mjs");
	fs.writeFileSync(
		driver,
		`
		import { pathToFileURL } from "node:url";
		const m = await import(pathToFileURL(${JSON.stringify(customAgents)}).href);
		console.log(JSON.stringify([...m.loadCustomAgents(${JSON.stringify(tmp)}).keys()]));
		`,
	);
	const r = spawnSync(process.execPath, [`${PI}/node_modules/tsx/dist/cli.mjs`, driver], {
		encoding: "utf8",
		env: { ...process.env, NODE_PATH: `${PI}/node_modules` },
	});
	assert.equal(r.status, 0, r.stderr);
	const names = JSON.parse(r.stdout.trim());
	for (const n of ["scout", "implementer", "tester", "worker"]) assert.ok(names.includes(n), `${n} missing from loadCustomAgents: ${names.join(", ")}`);

	// Also parse one rendered file with the real yaml package directly, and check the
	// description round-trips verbatim (this is the field whose colon broke compact
	// mapping parsing before renderDefinition JSON.stringify'd it).
	const scoutText = fs.readFileSync(path.join(agentsDir, "scout.md"), "utf8");
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(scoutText)[1];
	const yaml = await import(pathToFileURL(`${PI}/node_modules/yaml/dist/index.js`).href);
	const parsed = yaml.parse(fm);
	assert.equal(parsed.description, roster.get("scout").description);
});

test("rosterOrder puts producers before consumers and keeps the config order for ties", () => {
	const dir = tmpRoster({
		"implementer.md": "---\nname: implementer\ndescription: I.\ntools: read\nneeds: api, tests\nproduces: code\n---\nb\n",
		"tester.md": "---\nname: tester\ndescription: T.\ntools: read\nneeds: api\nproduces: tests\n---\nb\n",
		"scout.md": "---\nname: scout\ndescription: S.\ntools: read\nproduces: map\n---\nb\n",
	});
	const roster = loadRoster(dir);
	const order = rosterOrder(selectSpecialists(roster, ["implementer", "tester", "scout"])).map((s) => s.name);
	assert.deepEqual(order, ["tester", "implementer", "scout"]);
});

test("rosterSection renders the derived order and the review rule when a specialist declares needs", () => {
	const dir = tmpRoster({
		"implementer.md": "---\nname: implementer\ndescription: I.\ntools: read\nneeds: api, tests\nproduces: code\n---\nb\n",
		"tester.md": "---\nname: tester\ndescription: T.\ntools: read\nneeds: api\nproduces: tests\n---\nb\n",
	});
	const roster = loadRoster(dir);
	const text = rosterSection(selectSpecialists(roster, ["implementer", "tester"]));
	const expected = [
		'- `subagent` (subagent_type "implementer"): I.',
		'- `subagent` (subagent_type "tester"): T.',
		"",
		"Order for this roster: tester → implementer.",
		"- tester needs the API from your brief (exports and signatures) and produces tests under src/__tests__/.",
		"- implementer needs the API from your brief (exports and signatures) and tests under src/__tests__/; read the tests against the specification before you brief it, resume the tester for any obligation they miss, and name the test file in the brief. Produces code under src/.",
		"",
		"Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
	assert.equal(text, expected);
});

test("rosterSection with no declared needs renders exactly the pre-topology text", () => {
	const dir = tmpRoster({ "worker.md": "---\nname: worker\ndescription: W.\ntools: read\n---\nb\n" });
	const text = rosterSection(selectSpecialists(loadRoster(dir), ["worker"]));
	assert.equal(text, '- `subagent` (subagent_type "worker"): W.\n\nWorkers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.');
});
