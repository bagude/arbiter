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
// A literal is also judged whatever is or is not on disk when it names the hidden
// directory by the fixed name the harness gives it: anything containing "oracle", or a
// "tasks/" segment. Blanking the whole body used to be covered by accident — a bare ".."
// literal was denied, which also blocked `".." + "/tasks/pathnorm/oracle"` — and the
// existence rule alone does not restore that, because a POSIX-absolute fragment that does
// not exist is deliberately read as path-like data (`/a/c` in a JSON pointer). No pathnorm,
// orbit or raid test needs either name as data.
//
// WHAT THIS GUARANTEES: a literal that spells an existing place outside the workspace, or
// anything under the supervisor-owned .pi, or the hidden directory by name, is refused.
// `readFileSync('../../tasks/x/oracle/run.mjs')` and `".." + "/tasks/pathnorm/oracle"` are
// both denied; so is a literal carrying shell env indirection or a UNC prefix, which is
// put back into the segment for the checks that own it.
//
// WHAT IT DOES NOT: full runtime assembly still passes. `["..","tasks","pathnorm",
// "oracle"].join("/")` is four harmless literals — "tasks" and "oracle" each resolve
// inside the workspace on their own — and so are base64, an env lookup, or a name built a
// character at a time. Only a sandbox closes that; a syntactic argument scanner cannot, and
// never could (see the Scope note at the top of this file). Nor can it follow the spawned
// process once it runs. Existence is checked at decision time against the real disk, so
// "../x" is data until something is at "../x" and denied from then on.
// Only a `node` in COMMAND position opens a body. Matching the tokens anywhere let another
// command's argument open one: `cat node -e "../../oracle/run.mjs"` blanked the path (`-e`
// is a real cat flag), and `echo "node -e '" ; cat ../../oracle/run.mjs ; echo "'"` opened a
// fake body that ran to the quote in the last echo and swallowed the real cat in between —
// the masker and the segment splitter disagreeing about where a string ends. Both read the
// oracle, and both were denied before this guard grew a mask.
//
// The exec-wrapper allowance is load-bearing, not convenience: roster/implementer.md tells a
// worker to test "always with an explicit timeout", so `timeout 30 node -e …` is a command
// the roster itself invites, and a bare command-position anchor would put that body's ".."
// and "/" back in front of the fragment scanner — reintroducing the exact false positive
// case 5 exists to remove. Whatever precedes the opening quote stays in the text and is
// judged normally, so a wrapper cannot smuggle a path of its own:
// `timeout ../../oracle/run.mjs node -e "…"` is still denied on the argument.
//
// A wrapper's arguments are flags, durations or assignments — never a bare word. A bare word
// is a command NAME, and accepting one let the wrapper hand the body straight back to it:
// `time cat node -e "../../oracle/run.mjs"` reached cat, whose `-e` is also a real flag, and
// so did the timeout, env and nice spellings. That reopened the very family the anchor closes.
//
// Not reached, deliberately, and fail-closed in every case (the body is left unmasked and its
// degenerate literals are judged as raw fragments, so these are denials, never escapes):
// ANSI-C quoting, `node -e $'…'`, because its shell-level escapes are a second decoding layer
// this function does not model.
const NODE_EVAL = /(?:^|[;&|(\n`]|&&|\|\|)\s*(?:(?:timeout|env|nice|stdbuf|command|time)\s+(?:(?:-{1,2}[\w-]+|\d+(?:[.,]\d+)?[smhd]?|[A-Za-z_]\w*=\S*)\s+)*)*(?:[A-Za-z_]\w*=\S*\s+)*node(?:\.exe)?(?:\s+--[\w-]+(?:=[^\s'"]+)?)*\s+(?:-e|--eval|-p|--print)(?:\s*=\s*|\s+)(['"])/g;
// String literals within a script body: single-quoted, shell-escaped double-quoted, plain
// double-quoted, or backtick, honouring backslash escapes.
//
// The `\"…\"` alternative is second so it wins over the plain `"…"` form, which would
// otherwise begin matching at the quote and take the backslash for content. It is not an
// exotic shape: `node -e "…readFileSync(\"../x\")…"` is how a double-quoted body carries a
// literal at all. Without it such a literal fell into the "code between literals" branch
// below and was blanked unconditionally, never reaching judgeLiteral — so exists,
// HIDDEN_NAME and isProtected were all bypassed. Its content is any run of non-quote
// non-backslash characters plus any backslash followed by a NON-quote, which carries an
// inner escape while leaving the closing `\"` to end the literal.
const BODY_STRING = /'([^'\\]*(?:\\.[^'\\]*)*)'|\\"((?:[^"\\]|\\[^"])*)\\"|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const SEPARATOR_ONLY = new Set(["/", "\\", ".", "..", "./", "../", ".\\", "..\\"]);
// A run of separators is the same degenerate input as a lone one: `//` resolves to the
// drive root, which exists and is outside the workspace, exactly as `/` does — which is
// why `/` was already exempt. It also spells a line comment, which is how it turns up.
const SEPARATOR_RUN = /^[\\/]+$/;
const HIDDEN_NAME = /oracle|(?:^|[\\/])tasks(?:[\\/]|$)/i;

function resolveLiteral(root, text) {
	const windowsAbs = /^[A-Za-z]:[\\/]/.test(text);
	const msysMatch = /^\/([a-zA-Z])\//.exec(text);
	if (windowsAbs || (msysMatch && driveExists(msysMatch[1]))) return normalize(text);
	return path.isAbsolute(text) ? path.resolve(text) : path.resolve(root, text);
}

// What node opens is the literal's VALUE, not the source text the guard reads. Every escape
// that changes a character defeats the name check and the existence check at once:
// 'oracle', '\x6fracle', '\u{6f}racle', '\157racle' (legacy octal, live in the sloppy
// mode `node -e` runs in) and plain 'ora\cle' all spell "oracle" — the last needs no unicode
// at all, since an unrecognised escape simply drops its backslash. Bash passes \u, \x and \c
// through a double-quoted word untouched, so the body reaches node exactly as written.
//
// This is NOT the documented runtime-assembly residual: one literal spells the whole path
// and the guard sees all of it, it just reads the wrong spelling of it.
const JS_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g;
const JS_SIMPLE = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

function decodeJs(s) {
	return s.replace(JS_ESCAPE, (all, codePoint, unit, hex, octal, continuation, other) => {
		try {
			if (codePoint !== undefined) return String.fromCodePoint(Number.parseInt(codePoint, 16));
			if (unit !== undefined) return String.fromCharCode(Number.parseInt(unit, 16));
			if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
			if (octal !== undefined) {
				const n = Number.parseInt(octal, 8);
				return n <= 0xff ? String.fromCharCode(n) : all;
			}
		} catch {
			return all; // an out-of-range code point is not a spelling of anything
		}
		if (continuation !== undefined) return ""; // a line continuation contributes nothing
		return JS_SIMPLE[other] ?? other; // \n \t …, else the backslash is simply dropped
	});
}

// Both spellings are judged and the stricter verdict wins. The collapsed source has to stay
// in: the `"\\"` degenerate input resolves, as raw source, to the drive root, which exists
// and is outside the workspace, so judging the decoded value alone would deny a legitimate
// pathnorm case. Widening to "expose" is a no-op for safety — exposing re-inserts the
// literal's SOURCE text, so the segment-level ENV/UNC patterns still see what they saw.
function judgeLiteral(root, value, exists) {
	if (!value) return "data";
	// A ${…} substitution makes the literal CODE, not one path string. The braces glue onto the
	// following ".." so the span resolves back INSIDE the workspace, and a substitution placed
	// inside the name splits it — while the value node opens is the path either way. So it is
	// routed to the same code-span judging every other unrecognised span gets, and judged once
	// more with the substitutions elided, which is what closes a split name. The invariant one
	// level further in, not a new rule.
	//
	// The elided spelling is judged in BOTH spellings, like every other literal: a substitution
	// that splits the name AND an escape that spells one of its characters is one shape, not two.
	if (value.includes("${")) {
		const spanDeny = scanCodeSpan(root, value, exists);
		const joined = value.replace(/\$\{[^{}]*\}/g, "");
		if (joined !== value) {
			for (const text of new Set([joined.replace(/\\\\/g, "\\"), decodeJs(joined)])) {
				const one = judgeOneSpelling(root, text, exists);
				if (typeof one !== "string") return one;
			}
		}
		if (spanDeny) return spanDeny;
	}
	// A JS source escape is not a shell escape: "\\" in the body is one backslash.
	const collapsed = value.replace(/\\\\/g, "\\");
	if (SEPARATOR_ONLY.has(value) || SEPARATOR_ONLY.has(collapsed)) return "data";
	let verdict = "data";
	for (const text of new Set([collapsed, decodeJs(value)])) {
		const one = judgeOneSpelling(root, text, exists);
		if (typeof one !== "string") return one; // a deny on either spelling wins outright
		if (one === "expose") verdict = "expose";
	}
	return verdict;
}

// "data" — blank it; "expose" — put it back for the segment-level checks that own it;
// otherwise a deny verdict for a literal that names somewhere it may not name.
function judgeOneSpelling(root, text, exists) {
	if (!text || SEPARATOR_ONLY.has(text) || SEPARATOR_RUN.test(text)) return "data";
	// Env indirection and UNC are judged on the whole segment, not per fragment, so the
	// literal goes back into the text rather than being decided here.
	if (ENV_BARE.test(text) || ENV_INDIRECTION.test(text) || UNC.test(text)) return "expose";
	let resolved;
	try {
		resolved = resolveLiteral(root, text);
	} catch {
		return "data";
	}
	if (!HIDDEN_NAME.test(text) && !exists(resolved)) return "data";
	// Inside the workspace and not supervisor-owned: the agent may have it anyway.
	if (isInside(root, resolved) && !isProtected(root, resolved)) return "data";
	if (isProtected(root, resolved)) return deny(text, `"${text}" reaches the supervisor-owned .pi directory.`);
	return deny(text, HAS_DOTDOT_SEGMENT.test(text) ? `"${text}" climbs out of the workspace.` : `"${text}" is outside the workspace.`);
}

// THE INVARIANT, and the reason this function has its present shape: a span the matcher does
// not recognise is JUDGED, never erased. Blanking an unrecognised span is fail-OPEN, and three
// review rounds found three faces of that one mistake — a shell-escaped \"…\" literal, an
// escaped spelling like '\\u006fracle', and a backslash before a line terminator, which makes
// BODY_STRING miss the literal entirely. Each read the hidden oracle. So a code span is still
// blanked for the splitter's benefit, but every path-ish fragment in it is judged first, over
// both its raw and its decoded spelling.
//
// What still passes, and is meant to: a path assembled at runtime across several expressions
// — including inside a template, `${dir}/oracle/run.mjs` with dir computed at runtime, which
// is the same residual wearing a template's clothes —
// (base64, an env lookup, a joined array), because no fragment of
// it names anything out of bounds on its own; and ANSI-C quoting, node -e with a $-prefixed
// body, which is left unmasked and therefore fails closed. Only a sandbox closes the first.
const CODE_FRAGMENT = /[^\s"'`;&|<>(),=${}]+/g;

function scanCodeSpan(root, text, exists) {
	for (const spelling of new Set([text, decodeJs(text)])) {
		for (const fragment of spelling.match(CODE_FRAGMENT) ?? []) {
			const verdict = judgeOneSpelling(root, fragment, exists);
			if (typeof verdict !== "string") return verdict;
		}
	}
	return null;
}

function maskBody(root, body, exists) {
	let out = "";
	let last = 0;
	BODY_STRING.lastIndex = 0;
	for (let m = BODY_STRING.exec(body); m; m = BODY_STRING.exec(body)) {
		// The code between literals is not a path, but it is not nothing either: an
		// unrecognised literal lands here, so it is judged before it is blanked.
		const spanDeny = scanCodeSpan(root, body.slice(last, m.index), exists);
		if (spanDeny) return { deny: spanDeny };
		out += "x".repeat(m.index - last);
		const verdict = judgeLiteral(root, m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", exists);
		if (typeof verdict !== "string") return { deny: verdict };
		out += verdict === "expose" ? m[0] : "x".repeat(m[0].length);
		last = m.index + m[0].length;
	}
	const tailDeny = scanCodeSpan(root, body.slice(last), exists);
	if (tailDeny) return { deny: tailDeny };
	return { text: out + "x".repeat(body.length - last) };
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
		const masked = maskBody(root, out.slice(start, end), exists);
		if (masked.deny) return masked;
		out = `${out.slice(0, start)}${masked.text}${out.slice(end)}`;
		NODE_EVAL.lastIndex = end;
	}
	return { command: out };
}

function decideBash(root, rawCommand, exists) {
	let cwd = root;
	const masked = maskEvalBodies(root, rawCommand, exists);
	if (masked.deny) return masked.deny;
	const command = masked.command;
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
