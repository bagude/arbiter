// Path policy for the in-band guard: decides, before a tool runs, whether the
// paths it names stay inside the agent's workspace. Pure — no fs, no pi — so the
// rule is unit-testable and the extension (ext/path-guard.ts) is a thin adapter.
//
// Why a policy at all: the hidden oracle was only ever hidden from agents that did
// not look. Observed live (runs/2026-09-11T20-14-14): the orchestrator `ls`/`grep`/
// `read` its own runs/<id>/sessions/... by absolute path, and tasks/<task>/oracle/
// is reachable from every workspace by `../..`. The supervisor sees tool calls only
// after they ran, so this has to sit on the tool_call edge inside pi.
//
// Scope: it constrains tool ARGUMENTS. It cannot see what a bash process does once
// it runs; the bash rule is a syntactic first cut (absolute paths, `..` segments,
// home/temp references), measured rather than trusted. Isolation is the sandbox's
// job (docs/backlog.md, WSL2 phase two).
import path from "node:path";

// Tools whose `path` argument names a filesystem location. ls/grep/find default to
// the cwd when the argument is absent, which is inside by definition.
const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);
// The workspace's own .pi/ holds pi-subagents' agent definitions, settings and task
// records — supervisor-owned files the agents have no business reading (the
// orchestrator read .pi/agents/worker.md live). The package reads them via fs, not
// tool calls, so denying them at the tool edge costs nothing.
const PROTECTED_DIRS = [".pi"];

export const REDIRECT =
	"Only paths inside your workspace are available. The specification is in your system prompt and the deliverable lives under src/ — use a workspace-relative path.";

// Git Bash writes C:\x as /c/x; a model on Windows uses both. Map the msys form to
// the drive form so both compare against the same root.
function normalize(p) {
	const msys = /^\/([a-zA-Z])\/(.*)$/.exec(p);
	if (msys) p = `${msys[1].toUpperCase()}:/${msys[2]}`;
	return path.resolve(p);
}

function key(p) {
	const n = path.normalize(p).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? n.toLowerCase() : n;
}

// Inside means: equal to the root, or the root followed by a separator. A plain
// prefix test would let ws-builder-other pass for root ws-builder.
function isInside(root, abs) {
	const r = key(root);
	const a = key(abs);
	return a === r || a.startsWith(`${r}${path.sep}`);
}

function isProtected(root, abs) {
	return PROTECTED_DIRS.some((d) => isInside(path.join(root, d), abs));
}

function deny(fragment, why) {
	return { ok: false, reason: `${why} ${REDIRECT}`, fragment };
}

function decideFilePath(root, p) {
	const abs = path.isAbsolute(p) || /^\/[a-zA-Z]\//.test(p) ? normalize(p) : path.resolve(root, p);
	if (!isInside(root, abs)) return deny(p, `"${p}" is outside the workspace.`);
	if (isProtected(root, abs)) return deny(p, `"${p}" is a supervisor-owned directory.`);
	return { ok: true };
}

// Candidate path fragments in a shell command. Each pattern names a way a command
// can reach outside the cwd; anything the patterns do not match is treated as
// relative to the workspace, which bash resolves inside it.
const BASH_PATTERNS = [
	// Windows absolute: C:/x or C:\x (quotes optional; stops at whitespace or shell metachars)
	/[A-Za-z]:[\\/][^\s"'`;&|<>)]*/g,
	// msys absolute: /c/x — but not the // of a URL and not a flag like -x/y
	/(?<![\w.:\\/-])\/[a-zA-Z]\/[^\s"'`;&|<>)]*/g,
	// other POSIX absolute: /tmp, /etc, /usr/... (a bare "/" is left alone)
	/(?<![\w.:\\/-])\/[a-zA-Z][\w.-]*(?:\/[^\s"'`;&|<>)]*)?/g,
	// home
	/(?<![\w.])~(?:[\\/][^\s"'`;&|<>)]*)?/g,
	// env-var indirection to somewhere outside: %TEMP%, $TMP, ${HOME}, $env:TEMP
	/%(?:TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT)%/gi,
	/\$(?:\{)?(?:TMPDIR|TMP|TEMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b\}?/g,
	/\$env:(?:TMP|TEMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b/gi,
];
// A `..` path segment: bounded by start/whitespace/quote/separator on the left and a
// separator or end on the right. "1..2" (digits on both sides) is not a segment.
const DOTDOT = /(?:^|[\s"'`=(])(?:[^\s"'`=(]*[\\/])?\.\.(?=[\\/\s"'`)]|$)/;
// The protected directory named in a command: ".pi/", ".pi\", or bare ".pi" at a boundary.
const PROTECTED_IN_BASH = /(?:^|[\s"'`=(\\/])\.pi(?=[\\/\s"'`)]|$)/;

function decideBash(root, command) {
	const dd = DOTDOT.exec(command);
	if (dd) return deny(dd[0].trim(), `"${dd[0].trim()}" climbs out of the workspace.`);
	if (PROTECTED_IN_BASH.test(command)) return deny(".pi", "The .pi directory is supervisor-owned.");
	for (const re of BASH_PATTERNS) {
		re.lastIndex = 0;
		for (const m of command.matchAll(re)) {
			const frag = m[0];
			// Windows and msys absolutes may still be inside the workspace; the rest
			// (POSIX roots, home, temp variables) never are.
			const looksAbsolute = /^[A-Za-z]:[\\/]/.test(frag) || /^\/[a-zA-Z]\//.test(frag);
			if (looksAbsolute && isInside(root, normalize(frag))) continue;
			return deny(frag, `"${frag}" is outside the workspace.`);
		}
	}
	return { ok: true };
}

/**
 * decidePath({ root, tool, input }) → { ok: true } | { ok: false, reason, fragment }
 * `root` is the workspace directory (absolute, native form). `input` is the tool's
 * argument object as pi hands it to a tool_call handler.
 */
export function decidePath({ root, tool, input }) {
	if (tool === "bash" || tool === "powershell") {
		const command = typeof input?.command === "string" ? input.command : "";
		return decideBash(root, command);
	}
	if (!PATH_TOOLS.has(tool)) return { ok: true };
	const p = input?.path;
	if (typeof p !== "string" || p === "") return { ok: true };
	return decideFilePath(root, p);
}
