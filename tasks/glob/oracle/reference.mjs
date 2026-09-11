// Reference implementation — proves the oracle is self-consistent. Never shown to agents.
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function globMatch(pattern, path) {
	if (typeof pattern !== "string") throw new SyntaxError("invalid glob: pattern must be a string");
	if (typeof path !== "string") return false;
	for (const p of expandBraces(pattern)) if (compile(p).test(path)) return true;
	return false;
}

function expandBraces(p) {
	let depth = 0;
	let start = -1;
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (c === "}") {
			if (depth === 0) continue;
			depth--;
			if (depth === 0) {
				const prefix = p.slice(0, start);
				const suffix = p.slice(i + 1);
				const out = [];
				for (const alt of splitTopLevel(p.slice(start + 1, i))) out.push(...expandBraces(prefix + alt + suffix));
				return out;
			}
		}
	}
	if (depth !== 0) throw new SyntaxError("invalid glob: unclosed {");
	return [p];
}

function splitTopLevel(s) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") {
			cur += c + (s[i + 1] ?? "");
			i++;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") depth--;
		if (c === "," && depth === 0) {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	parts.push(cur);
	return parts;
}

// Split on "/" only outside classes and escapes, so `a[/]b` stays one segment.
function splitSegments(p) {
	const segs = [];
	let cur = "";
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "\\") {
			cur += c + (p[i + 1] ?? "");
			i++;
			continue;
		}
		if (c === "[") {
			let j = i + 1;
			if (p[j] === "!") j++;
			if (p[j] === "]") j++;
			while (j < p.length && p[j] !== "]") {
				if (p[j] === "\\") j++;
				j++;
			}
			if (j < p.length) {
				cur += p.slice(i, j + 1);
				i = j;
				continue;
			}
		}
		if (c === "/") {
			segs.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	segs.push(cur);
	return segs;
}

function compile(p) {
	const segs = splitSegments(p);
	let re = "";
	let noSlash = false;
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		const last = i === segs.length - 1;
		if (seg === "**") {
			if (last) re += i > 0 ? "(?:/(?!\\.)[^/]+)*" : "(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*)?";
			else {
				if (i > 0 && !noSlash) re += "/";
				re += "(?:(?!\\.)[^/]+/)*";
				noSlash = true;
			}
			continue;
		}
		if (i > 0 && !noSlash) re += "/";
		noSlash = false;
		re += segToRe(seg);
	}
	return new RegExp(`^${re}$`);
}

function segToRe(seg) {
	let re = seg.startsWith(".") || seg.startsWith("\\.") ? "" : "(?!\\.)";
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i];
		if (c === "*") {
			while (seg[i + 1] === "*") i++;
			re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else if (c === "\\") {
			if (i + 1 >= seg.length) throw new SyntaxError("invalid glob: trailing backslash");
			re += esc(seg[++i]);
		} else if (c === "[") {
			let j = i + 1;
			let negate = false;
			let body = "";
			if (seg[j] === "!") {
				negate = true;
				j++;
			}
			if (seg[j] === "]") {
				body += "\\]";
				j++;
			}
			while (j < seg.length && seg[j] !== "]") {
				const ch = seg[j];
				if (ch === "\\") {
					body += esc(seg[j + 1] ?? "");
					j += 2;
					continue;
				}
				body += ch === "-" ? "-" : esc(ch);
				j++;
			}
			if (j >= seg.length) throw new SyntaxError("invalid glob: unclosed [");
			re += negate ? `[^/${body}]` : `(?!/)[${body}]`;
			i = j;
		} else re += esc(c);
	}
	return re;
}
