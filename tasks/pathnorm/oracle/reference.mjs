// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function checkString(v, label) {
	if (typeof v !== "string") throw new TypeError(`path must be a string (${label})`);
}

export function normalize(p) {
	checkString(p, "normalize");
	const absolute = p.startsWith("/");
	const raw = p.split("/");
	const stack = [];
	for (const seg of raw) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (stack.length > 0 && stack[stack.length - 1] !== "..") {
				stack.pop();
			} else if (!absolute) {
				stack.push("..");
			}
			// absolute + empty/`..`-only stack: drop, `..` at root is a no-op
			continue;
		}
		stack.push(seg);
	}
	if (absolute) return stack.length === 0 ? "/" : "/" + stack.join("/");
	return stack.length === 0 ? "." : stack.join("/");
}

export function join(...parts) {
	for (const part of parts) checkString(part, "join");
	return normalize(parts.filter((s) => s !== "").join("/"));
}

export function isAbsolute(p) {
	checkString(p, "isAbsolute");
	return p.startsWith("/");
}

function segsOf(normalized) {
	if (normalized === "/" || normalized === ".") return [];
	return (normalized.startsWith("/") ? normalized.slice(1) : normalized).split("/");
}

export function relative(from, to) {
	checkString(from, "relative");
	checkString(to, "relative");
	const nFrom = normalize(from);
	const nTo = normalize(to);
	const fromAbs = isAbsolute(nFrom);
	const toAbs = isAbsolute(nTo);
	if (fromAbs !== toAbs) {
		throw new TypeError(`mixed absolute and relative paths: ${JSON.stringify(from)}, ${JSON.stringify(to)}`);
	}
	if (nFrom === nTo) return ".";
	const fromSegs = segsOf(nFrom);
	const toSegs = segsOf(nTo);
	let common = 0;
	while (common < fromSegs.length && common < toSegs.length && fromSegs[common] === toSegs[common]) common++;
	const ups = fromSegs.length - common;
	const downs = toSegs.slice(common);
	const parts = [];
	for (let i = 0; i < ups; i++) parts.push("..");
	parts.push(...downs);
	return parts.length === 0 ? "." : parts.join("/");
}

export function dirname(p) {
	checkString(p, "dirname");
	const n = normalize(p);
	if (n === "/") return "/";
	const idx = n.lastIndexOf("/");
	if (idx === -1) return ".";
	if (idx === 0) return "/";
	return n.slice(0, idx);
}

export function basename(p, ext) {
	checkString(p, "basename");
	if (ext !== undefined) checkString(ext, "basename");
	const n = normalize(p);
	if (n === "/") return "";
	const idx = n.lastIndexOf("/");
	const base = idx === -1 ? n : n.slice(idx + 1);
	if (ext && ext.length > 0 && base !== ext && base.endsWith(ext)) {
		return base.slice(0, base.length - ext.length);
	}
	return base;
}
