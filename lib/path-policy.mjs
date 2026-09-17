// Path policy for the in-band guard: decides, before a tool runs, whether the
// paths it names stay inside the agent's workspace. No pi; fs only for existence checks — so the
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
import fs from "node:fs";
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

// ---- bash (v2) ----------------------------------------------------------------
// A shell command is text, not a path list, so this is a syntactic rule — measured,
// not trusted. v2 comes from review-guard run 2026-09-12T08-24-41 (R1–R7) and the
// night batch's three false positives: path-like DATA in arguments (a JSON pointer,
// a template tag, a test string) must not count as places, while real escapes must.
//   - `..` is judged by where it RESOLVES, against a cwd tracked through `cd` in the
//     same command line: `cd src && cat ../README.md` stays inside; `cd .. && ls` does not.
//   - a POSIX-absolute fragment is a place only if it is a known system root or it
//     exists on disk (`/a/c` in a JSON pointer is neither; `/etc/passwd` is both).
//   - the protected `.pi` is matched case-insensitively (the file-tool side already
//     lowercases on Windows) and by any dot-glob that could name it (`.pi*`, `.p?`, `.[pi]i`).
//   - UNC paths (`\\server\share`, `//server/share`) and ANY env-var indirection followed
//     by a separator (`%USERNAME%\`, `$HOMEPATH/`, `$env:WINDIR\`) are denied.
// What it still cannot do: know a tool's argument semantics — `grep ".pi" src/` is
// denied although ".pi" is a search pattern (review-guard R6); accepted for now.
const KNOWN_ROOTS = new Set(["bin", "boot", "dev", "etc", "home", "lib", "lib64", "mnt", "opt", "proc", "root", "run", "sbin", "srv", "sys", "tmp", "usr", "var", "windows", "users", "program files"]);
const DEV_STREAMS = /^\/dev\/(null|stdin|stdout|stderr|tty)$/;
const FRAGMENT = /[^\s"'`;&|<>(),=]+/g; // maximal runs of path-ish characters
const HAS_DOTDOT_SEGMENT = /(?:^|[\\/])\.\.(?:$|[\\/])/;
const PROTECTED_IN_BASH = /(?:^|[\s"'`=(\\/])\.pi(?=[\\/\s"'`)]|$)/i;
const DOT_GLOB = /(?:^|[\s"'`=(\\/])\.[^\s"'`;&|<>()\\/]{0,2}[*?[]/;
const UNC = /(?:^|[\s"'`=(])(?:\\\\|\/\/)[A-Za-z0-9_.$-]+[\\/]/;
const ENV_INDIRECTION = /(?:%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$env:[A-Za-z_][A-Za-z0-9_]*)(?=[\\/])/i;
const ENV_BARE = /%(?:TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR)%|\$\{?(?:TMPDIR|TMP|TEMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b\}?|\$env:(?:TMP|TEMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|WINDIR)\b/i;
const BARE_ROOT = /(?:^|\s)\/(?=\s|$)/;
// A bare `/` is a place only as the argument of a filesystem command (`ls /`,
// `find / -name`); between operands it is division (`sum(a) / sum(b)` inside a
// `python -c` one-liner — review R10, seen live in dw-explore). The segment's first
// word decides.
const FS_COMMANDS = new Set(["ls", "dir", "find", "fd", "rm", "du", "tree", "cat", "cp", "mv", "chmod", "chown", "grep", "rg", "stat", "readlink", "realpath", "head", "tail", "touch", "mkdir", "rmdir", "ln", "file", "wc", "sort", "less", "more", "sudo", "pushd"]);
// `$s/…` is env-var indirection unless the command line itself binds `s` (`for s in
// tx nm ok; do … $s/…`, `s=tx; …` — review R9, seen live in every dw-bronze run).
const LOCAL_BINDINGS = /\bfor\s+([A-Za-z_]\w*)\s+in\b|(?:^|[\s;&|(])([A-Za-z_]\w*)=(?!=)/g;

function localBindings(command) {
	const names = new Set();
	for (const m of command.matchAll(LOCAL_BINDINGS)) names.add(m[1] ?? m[2]);
	return names;
}

// The env-indirection match that is NOT bound by the command line itself, or null.
function unboundEnv(text, bound) {
	const m = ENV_INDIRECTION.exec(text);
	if (!m) return null;
	const name = m[0].replace(/^\$env:/i, "").replace(/^[%$]\{?/, "").replace(/\}?%?$/, "");
	return bound.has(name) ? null : m[0];
}

function stripQuotes(s) {
	return s.replace(/^["'`]+|["'`]+$/g, "");
}

// `/a/c` is a JSON pointer or a drive path depending only on whether drive A: exists
// — syntax cannot tell. Treat `/x/…` as an msys drive path only for a drive that is
// actually mounted (cached per letter).
const driveCache = new Map();
function driveExists(letter) {
	const k = letter.toUpperCase();
	if (!driveCache.has(k)) {
		let exists = false;
		try {
			exists = process.platform === "win32" ? fs.existsSync(`${k}:\\`) : false;
		} catch {
			exists = false;
		}
		driveCache.set(k, exists);
	}
	return driveCache.get(k);
}

function posixKnownRootOrExists(frag) {
	const first = frag.split("/").filter(Boolean)[0]?.toLowerCase();
	if (first && KNOWN_ROOTS.has(first)) return true;
	try {
		return fs.existsSync(frag);
	} catch {
		return false;
	}
}

// One shell segment (no `&&`, `;`, `|`), judged relative to `cwd`; `bound` holds the
// variable names the whole command line binds itself.
function judgeSegment(root, cwd, segment, bound = new Set()) {
	if (ENV_BARE.test(segment)) return deny(segment.match(ENV_BARE)[0], `"${segment.match(ENV_BARE)[0]}" points outside the workspace.`);
	const env = unboundEnv(segment, bound);
	if (env) return deny(env, `"${env}" is an environment path outside the workspace.`);
	if (UNC.test(segment)) return deny(segment.match(UNC)[0].trim(), "A network path is never inside the workspace.");
	const firstWord = segment.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (BARE_ROOT.test(segment) && FS_COMMANDS.has(firstWord)) return deny("/", "The filesystem root is outside the workspace.");
	if (PROTECTED_IN_BASH.test(segment)) return deny(".pi", "The .pi directory is supervisor-owned.");
	if (DOT_GLOB.test(segment)) return deny(segment.match(DOT_GLOB)[0].trim(), "A dot-glob can name the supervisor-owned .pi directory.");
	const home = /(?<![\w.])~(?=[\\/\s"'`)]|$)/.exec(segment);
	if (home) return deny("~", "The home directory is outside the workspace.");
	for (const m of segment.matchAll(FRAGMENT)) {
		const frag = stripQuotes(m[0]);
		if (!frag || DEV_STREAMS.test(frag)) continue;
		const windowsAbs = /^[A-Za-z]:[\\/]/.test(frag);
		const msysMatch = /^\/([a-zA-Z])\//.exec(frag);
		const msysAbs = Boolean(msysMatch && driveExists(msysMatch[1]));
		const posixAbs = !msysAbs && /^\/[^/]/.test(frag);
		if (windowsAbs || msysAbs) {
			if (!isInside(root, normalize(frag))) return deny(frag, `"${frag}" is outside the workspace.`);
			continue;
		}
		if (posixAbs) {
			if (HAS_DOTDOT_SEGMENT.test(frag) || posixKnownRootOrExists(frag)) return deny(frag, `"${frag}" is outside the workspace.`);
			continue; // path-like data (a JSON pointer, a template tag): not a place
		}
		if (HAS_DOTDOT_SEGMENT.test(frag)) {
			const resolved = path.resolve(cwd, frag);
			if (!isInside(root, resolved)) return deny(frag, `"${frag}" climbs out of the workspace.`);
			if (isProtected(root, resolved)) return deny(frag, `"${frag}" reaches the supervisor-owned .pi directory.`);
		}
	}
	return { ok: true };
}

// `node -e "<script>"` hands a JavaScript program to node as one shell word. Inside it,
// "..", "/" and "/c/d" are string data — a path-string task writes them constantly — but
// the fragment scanner cannot tell them from filesystem targets, and the remedy it
// offers ("use a workspace-relative path") is meaningless when nothing was opened. In
// run 2026-09-17T16-47-16 this denied the tester's independent re-derivation of
// relative() twice (13 denials across its turns, 4 more for the implementer, which then
// smuggled its probe pairs through base64); the tester gave up and hand-derived only the
// brief's cases, so the one mechanical check that would have found the bug never ran.
//
// The rule, then, is existence: a quoted string literal inside an -e body is DATA unless
// it resolves, against the workspace, to something that is really there and really out of
// bounds — an existing file or directory outside the workspace, or anything under the
// supervisor-owned .pi. Such a literal is left in the text and judged exactly as any other
// fragment; every other literal, and all the surrounding code, is blanked.
//
// Blanking happens before the command is split, not inside judgeSegment, and keeps each
// span's length. Two reasons: decideBash splits on /&&|\|\||;|\|/ without regard to
// quoting, so a body containing `;` would otherwise arrive already shredded, and equal
// lengths keep every fragment outside the body at its own offset. Anything outside the
// body is judged as before — `node -e "…" && cat ../secret` still fails on the cat.
//
// Separator-only literals are always data: "/", "\\", ".", "..", "./", "../". They are
// the degenerate inputs a path task is made of, and each one resolves to somewhere that
// exists (the filesystem root, the workspace's parent) while naming nothing.
//
// WHAT THIS GUARANTEES: a literal that spells an existing place outside the workspace is
// denied exactly as a bare fragment would be, so `node -e "readFileSync('../../tasks/x/
// oracle/run.mjs')"` is refused and the hidden oracle stays hidden from a literal path.
//
// WHAT IT DOES NOT: it cannot see a path the script assembles at runtime — concatenation,
// a variable, base64, an env lookup — and it cannot follow the spawned process once it is
// running. That was always true of a syntactic argument scanner (see the Scope note at the
// top of this file) and is the sandbox's job, not this function's. Nor does it judge a
// literal naming something that does not exist: "../x" passes, and if a later `node -e`
// creates it, the same literal is denied from then on. Existence is checked at decision
// time, against the real disk.
const NODE_EVAL = /(?<![\w.\-/\\])node(?:\.exe)?(?:\s+--[\w-]+(?:=[^\s'"]+)?)*\s+(?:-e|--eval|-p|--print)\s+(['"])/g;
// String literals within a script body: single, double or backtick, honouring backslash
// escapes. The body's own outer quote cannot appear here unescaped — the body span ended
// at its first unescaped occurrence — so only the other two forms can ever match.
const BODY_STRING = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const SEPARATOR_ONLY = new Set(["/", "\\", ".", "..", "./", "../", ".\\", "..\\"]);

// Does this literal have to be judged as a path, rather than blanked as data?
function literalIsPlace(root, value, exists) {
	if (!value) return false;
	// A JS source escape is not a shell escape: "\\" in the body is one backslash.
	const text = value.replace(/\\\\/g, "\\");
	if (SEPARATOR_ONLY.has(value) || SEPARATOR_ONLY.has(text)) return false;
	let resolved;
	try {
		const windowsAbs = /^[A-Za-z]:[\\/]/.test(text);
		const msysMatch = /^\/([a-zA-Z])\//.exec(text);
		resolved = windowsAbs || (msysMatch && driveExists(msysMatch[1])) ? normalize(text) : path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
	} catch {
		return false;
	}
	if (!exists(resolved)) return false;
	// Inside the workspace and not supervisor-owned: the agent may have it anyway.
	return !isInside(root, resolved) || isProtected(root, resolved);
}

function maskBody(root, body, exists) {
	let out = "";
	let last = 0;
	BODY_STRING.lastIndex = 0;
	for (let m = BODY_STRING.exec(body); m; m = BODY_STRING.exec(body)) {
		out += "x".repeat(m.index - last); // code between literals is never a path
		const value = m[1] ?? m[2] ?? m[3] ?? "";
		out += literalIsPlace(root, value, exists) ? m[0] : "x".repeat(m[0].length);
		last = m.index + m[0].length;
	}
	return out + "x".repeat(body.length - last);
}

function maskEvalBodies(root, command, exists) {
	let out = command;
	NODE_EVAL.lastIndex = 0;
	for (let m = NODE_EVAL.exec(out); m; m = NODE_EVAL.exec(out)) {
		const quote = m[1];
		const start = m.index + m[0].length; // first character inside the quote
		let end = -1;
		for (let i = start; i < out.length; i++) {
			if (quote === '"' && out[i] === "\\") {
				i++;
				continue;
			}
			if (out[i] === quote) {
				end = i;
				break;
			}
		}
		if (end === -1) break; // unterminated quote: judge what was written
		out = `${out.slice(0, start)}${maskBody(root, out.slice(start, end), exists)}${out.slice(end)}`;
		NODE_EVAL.lastIndex = end;
	}
	return out;
}

function decideBash(root, rawCommand, exists) {
	let cwd = root;
	const command = maskEvalBodies(root, rawCommand, exists);
	const bound = localBindings(command);
	for (const raw of command.split(/&&|\|\||;|\|/)) {
		const segment = raw.trim();
		if (!segment) continue;
		const cd = /^cd(?:\s+(.*))?$/s.exec(segment);
		if (cd) {
			const target = stripQuotes((cd[1] ?? "").trim().split(/\s+/)[0] ?? "");
			if (!target || target === "~" || target === "-") return deny(target || "cd", `"cd ${target}" leaves the workspace.`);
			if (ENV_BARE.test(target) || unboundEnv(target, bound)) return deny(target, `"${target}" points outside the workspace.`);
			// A bound variable in the target cannot be resolved syntactically: accept the
			// literal prefix (relative to cwd) and let the file-tool/realpath rules judge reads.
			if (ENV_INDIRECTION.test(target)) {
				cwd = path.resolve(cwd, target.split(/[$%]/)[0] || ".");
				continue;
			}
			const cdMsys = /^\/([a-zA-Z])\//.exec(target);
			const next = /^[A-Za-z]:[\\/]/.test(target) || (cdMsys && driveExists(cdMsys[1])) ? normalize(target) : /^\//.test(target) ? deny(target, `"${target}" is outside the workspace.`) : path.resolve(cwd, target);
			if (next && next.ok === false) return next;
			if (!isInside(root, next)) return deny(target, `"${target}" is outside the workspace.`);
			if (isProtected(root, next)) return deny(target, `"${target}" is the supervisor-owned .pi directory.`);
			cwd = next;
			continue;
		}
		const verdict = judgeSegment(root, cwd, segment, bound);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

const existsOnDisk = (p) => {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
};

/**
 * decidePath({ root, tool, input, exists }) → { ok: true } | { ok: false, reason, fragment }
 * `root` is the workspace directory (absolute, native form). `input` is the tool's
 * argument object as pi hands it to a tool_call handler. `exists` answers "is there
 * really something at this absolute path" — fs.existsSync by default, injectable so the
 * `node -e` literal rule above can be tested without a disk.
 */
export function decidePath({ root, tool, input, exists = existsOnDisk }) {
	if (tool === "bash" || tool === "powershell") {
		const command = typeof input?.command === "string" ? input.command : "";
		return decideBash(root, command, exists);
	}
	if (!PATH_TOOLS.has(tool)) return { ok: true };
	const p = input?.path;
	if (typeof p !== "string" || p === "") return { ok: true };
	return decideFilePath(root, p);
}
