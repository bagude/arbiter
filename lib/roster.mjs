// Roster: specialists defined once in roster/<name>.md and selected per run by name.
// Files are pi-subagents agent definitions minus the model line: model/provider come
// from the run config (lib/config.mjs `workers`), so one roster serves local and cloud.
import fs from "node:fs";
import path from "node:path";
import { WORKER_THINKING_LEVELS } from "./thinking-levels.mjs";

export const ROSTER_TOOLS = ["read", "bash", "edit", "write", "ls", "grep", "find", "memory_search", "memory_get", "recall_result", "remember", "report", "context_usage"];
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
	if (!body) throw new Error(`${file}: prompt body is empty`);
	return { name, description, tools, thinking, background, maxTurns, memory, body, file };
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
	return names.map((n) => {
		const spec = roster.get(n);
		if (!spec) throw new Error(`unknown specialist "${n}" (roster has: ${[...roster.keys()].sort().join(", ")})`);
		return spec;
	});
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

export function rosterSection(specs) {
	const lines = specs.map((s) => `- \`subagent\` (subagent_type "${s.name}"): ${s.description}`);
	return [
		...lines,
		"",
		"Workers do not have the specification — everything they know about the task comes from your brief. One worker runs at a time; a second one waits for the first to finish.",
	].join("\n");
}
