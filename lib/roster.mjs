// Roster: specialists defined once in roster/<name>.md and selected per run by name.
// Files are pi-subagents agent definitions minus the model line: model/provider come
// from the run config (lib/config.mjs `workers`), so one roster serves local and cloud.
import fs from "node:fs";
import path from "node:path";
import { WORKER_THINKING_LEVELS } from "./thinking-levels.mjs";

export const ROSTER_TOOLS = ["read", "bash", "edit", "write", "ls", "grep", "find", "memory_search", "memory_get", "recall_result", "remember", "report", "context_usage"];

// Artifacts a specialist may need (from the brief or the workspace) or produce.
// `api` lives in the orchestrator's brief; the rest are files in the workspace.
// Only `tests` has a guard-side check in this slice (lib/policies/topology-policy.mjs).
export const ARTIFACTS = ["api", "tests", "code", "map", "review"];

function parseArtifacts(fields, key, file) {
	const list = (fields[key] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
	for (const a of list) if (!ARTIFACTS.includes(a)) throw new Error(`${file}: unknown artifact "${a}" in ${key} (known: ${ARTIFACTS.join(", ")})`);
	return list;
}

const NAME_RE = /^[\w.-]+$/;

function parseFrontmatter(text, file) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) throw new Error(`${file}: roster file must start with a --- frontmatter block`);
	const fields = {};
	for (const raw of m[1].split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const i = line.indexOf(":");
		if (i < 0) throw new Error(`${file}: bad frontmatter line ${JSON.stringify(raw)}`);
		fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fields, body: m[2].trim() };
}

export function parseRosterFile(file) {
	const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"), file);
	const stem = path.basename(file, ".md");
	if ("model" in fields) throw new Error(`${file}: model: is not allowed in a roster file (the run config supplies provider/model)`);
	const name = fields.name ?? "";
	if (!NAME_RE.test(name)) throw new Error(`${file}: name must match ${NAME_RE}, got ${JSON.stringify(name)}`);
	if (name !== stem) throw new Error(`${file}: name "${name}" does not match file "${stem}"`);
	const description = (fields.description ?? "").trim();
	if (!description) throw new Error(`${file}: description is required`);
	const tools = (fields.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
	if (!tools.length) throw new Error(`${file}: tools is required`);
	for (const t of tools) if (!ROSTER_TOOLS.includes(t)) throw new Error(`${file}: unknown tool "${t}" (known: ${ROSTER_TOOLS.join(", ")})`);
	const thinking = fields.thinking ? fields.thinking : null;
	if (thinking && !WORKER_THINKING_LEVELS.includes(thinking)) throw new Error(`${file}: thinking must be one of ${WORKER_THINKING_LEVELS.join(", ")}, got ${JSON.stringify(thinking)}`);
	let background = false;
	if (fields.background !== undefined) {
		if (fields.background !== "true" && fields.background !== "false") throw new Error(`${file}: background must be true or false`);
		background = fields.background === "true";
	}
	const maxTurns = fields.maxTurns === undefined ? 60 : Number(fields.maxTurns);
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`${file}: maxTurns must be a positive integer`);
	const memory = fields.memory ? fields.memory : name;
	if (!NAME_RE.test(memory)) throw new Error(`${file}: memory must match ${NAME_RE}`);
	const needs = parseArtifacts(fields, "needs", file);
	const produces = parseArtifacts(fields, "produces", file);
	if (!body) throw new Error(`${file}: prompt body is empty`);
	return { name, description, tools, thinking, background, maxTurns, memory, needs, produces, body, file };
}

export function loadRoster(dir) {
	const out = new Map();
	if (!fs.existsSync(dir)) throw new Error(`roster directory not found: ${dir}`);
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
		const spec = parseRosterFile(path.join(dir, f));
		out.set(spec.name, spec);
	}
	return out;
}

export function selectSpecialists(roster, names) {
	const specs = names.map((n) => {
		const spec = roster.get(n);
		if (!spec) throw new Error(`unknown specialist "${n}" (roster has: ${[...roster.keys()].sort().join(", ")})`);
		return spec;
	});
	const cycle = findTopologyCycle(specs);
	if (cycle) throw new Error(`topology cycle among selected specialists: ${cycle.join(" -> ")}`);
	return specs;
}

// Edges: producer -> consumer for every artifact one selected specialist produces
// and another needs. Returns the first cycle as [a, b, ..., a], or null.
function findTopologyCycle(specs) {
	const producers = new Map(); // artifact -> [names]
	for (const s of specs) for (const a of s.produces) (producers.get(a) ?? producers.set(a, []).get(a)).push(s.name);
	const next = new Map(specs.map((s) => [s.name, []])); // name -> names it depends on
	for (const s of specs) for (const a of s.needs) for (const p of producers.get(a) ?? []) if (p !== s.name) next.get(s.name).push(p);
	const state = new Map(); // name -> "open" | "done"
	const stack = [];
	const visit = (n) => {
		if (state.get(n) === "done") return null;
		if (state.get(n) === "open") return [...stack.slice(stack.indexOf(n)), n];
		state.set(n, "open");
		stack.push(n);
		for (const m of next.get(n)) {
			const c = visit(m);
			if (c) return c;
		}
		stack.pop();
		state.set(n, "done");
		return null;
	};
	for (const s of specs) {
		const c = visit(s.name);
		if (c) return c;
	}
	return null;
}

export function renderDefinition(spec, { provider, model, thinking, background, extraTools = [], promptSuffix = "" }) {
	const level = thinking ?? spec.thinking;
	const bg = background ?? spec.background;
	const tools = [...spec.tools, ...extraTools.filter((t) => !spec.tools.includes(t))];
	return [
		"---",
		`name: ${spec.name}`,
		`description: ${JSON.stringify(spec.description)}`,
		`tools: ${tools.join(",")}`,
		`model: ${JSON.stringify(`${provider}/${model}`)}`,
		...(level ? [`thinking: ${level}`] : []),
		`max_turns: ${spec.maxTurns}`,
		`run_in_background: ${bg}`,
		"---",
		spec.body,
		...(promptSuffix ? ["", promptSuffix.trim()] : []),
		"",
	].join("\n");
}

// One phrase per artifact, in the two positions a sentence can use it. The Roster
// section is part of the orchestrator's stable prefix: everything here derives from
// the roster files, never from the run.
const ARTIFACT_PHRASES = {
	api: { needs: "the API from your brief (exports and signatures)", produces: "the API" },
	tests: { needs: "tests under src/__tests__/", produces: "tests under src/__tests__/" },
	code: { needs: "code under src/", produces: "code under src/" },
	map: { needs: "a map of the workspace", produces: "a map of the workspace" },
	review: { needs: "a review", produces: "a review" },
};
const REVIEW_RULE = "read the tests against the specification before you brief it, resume the tester for any obligation they miss, and name the test file in the brief";

// Dependency order: a specialist that needs an artifact comes after every selected
// specialist that produces it. Kahn's algorithm, ties broken by input order.
export function rosterOrder(specs) {
	const producers = new Map();
	for (const s of specs) for (const a of s.produces) (producers.get(a) ?? producers.set(a, []).get(a)).push(s.name);
	const deps = new Map(specs.map((s) => [s.name, new Set()]));
	for (const s of specs) for (const a of s.needs) for (const p of producers.get(a) ?? []) if (p !== s.name) deps.get(s.name).add(p);
	const out = [];
	const done = new Set();
	while (out.length < specs.length) {
		const ready = specs.find((s) => !done.has(s.name) && [...deps.get(s.name)].every((d) => done.has(d)));
		if (!ready) throw new Error("topology cycle among selected specialists"); // selectSpecialists rejects this earlier
		out.push(ready);
		done.add(ready.name);
	}
	return out;
}

function joinPhrases(list) {
	return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function orderParagraph(specs) {
	if (!specs.some((s) => s.needs.length)) return [];
	const order = rosterOrder(specs);
	const lines = [`Order for this roster: ${order.map((s) => s.name).join(" → ")}.`];
	for (const s of order) {
		if (!s.needs.length && !s.produces.length) continue;
		const needs = joinPhrases(s.needs.map((a) => ARTIFACT_PHRASES[a].needs));
		const produces = joinPhrases(s.produces.map((a) => ARTIFACT_PHRASES[a].produces));
		if (s.needs.includes("tests")) {
			lines.push(`- ${s.name} needs ${needs}; ${REVIEW_RULE}.${produces ? ` Produces ${produces}.` : ""}`);
		} else if (s.needs.length) {
			lines.push(`- ${s.name} needs ${needs}${produces ? ` and produces ${produces}` : ""}.`);
		} else {
			lines.push(`- ${s.name} produces ${produces}.`);
		}
	}
	return [...lines, ""];
}

export function rosterSection(specs) {
	const lines = specs.map((s) => `- \`subagent\` (subagent_type "${s.name}"): ${s.description}`);
	return [
		...lines,
		"",
		...orderParagraph(specs),
		"Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
}
