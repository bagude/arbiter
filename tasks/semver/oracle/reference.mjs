// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const RANGE_VERSION_RE = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?)?)?$/;
const IDENT_RE = /^[0-9A-Za-z-]+$/;
const ALL_DIGITS_RE = /^\d+$/;

function isAllDigits(id) {
	return ALL_DIGITS_RE.test(id);
}

function validateIdentifiers(ids, { numericNoLeadingZero }) {
	for (const id of ids) {
		if (id === "" || !IDENT_RE.test(id)) return false;
		if (numericNoLeadingZero && isAllDigits(id) && !/^(0|[1-9]\d*)$/.test(id)) return false;
	}
	return true;
}

export function parse(v) {
	if (typeof v !== "string") throw new SyntaxError(`invalid version: not a string`);
	const s = v.startsWith("v") ? v.slice(1) : v;
	const m = VERSION_RE.exec(s);
	if (!m) throw new SyntaxError(`invalid version: ${JSON.stringify(v)}`);
	const prerelease = m[4] ? m[4].split(".") : [];
	const build = m[5] ? m[5].split(".") : [];
	if (!validateIdentifiers(prerelease, { numericNoLeadingZero: true })) {
		throw new SyntaxError(`invalid version: ${JSON.stringify(v)}`);
	}
	if (!validateIdentifiers(build, { numericNoLeadingZero: false })) {
		throw new SyntaxError(`invalid version: ${JSON.stringify(v)}`);
	}
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease, build };
}

function compareIdentifier(x, y) {
	const xNum = isAllDigits(x);
	const yNum = isAllDigits(y);
	if (xNum && yNum) {
		const nx = Number(x);
		const ny = Number(y);
		return nx === ny ? 0 : nx < ny ? -1 : 1;
	}
	if (xNum !== yNum) return xNum ? -1 : 1;
	return x === y ? 0 : x < y ? -1 : 1;
}

function comparePrerelease(a, b) {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const c = compareIdentifier(a[i], b[i]);
		if (c !== 0) return c;
	}
	if (a.length !== b.length) return a.length < b.length ? -1 : 1;
	return 0;
}

export function compare(a, b) {
	const pa = parse(a);
	const pb = parse(b);
	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
	return comparePrerelease(pa.prerelease, pb.prerelease);
}

// ---- range parsing ----

function parseRangeVersion(str) {
	const m = RANGE_VERSION_RE.exec(str);
	if (!m) throw new SyntaxError(`invalid range: bad version ${JSON.stringify(str)}`);
	const major = Number(m[1]);
	const minor = m[2] !== undefined ? Number(m[2]) : undefined;
	const patch = m[3] !== undefined ? Number(m[3]) : undefined;
	let prerelease = null;
	if (m[4] !== undefined) {
		prerelease = m[4].split(".");
		if (!validateIdentifiers(prerelease, { numericNoLeadingZero: true })) {
			throw new SyntaxError(`invalid range: bad prerelease ${JSON.stringify(str)}`);
		}
	}
	const n = patch !== undefined ? 3 : minor !== undefined ? 2 : 1;
	return { major, minor, patch, prerelease, n };
}

function fullStr(rv) {
	let s = `${rv.major}.${rv.minor}.${rv.patch}`;
	if (rv.prerelease && rv.prerelease.length) s += `-${rv.prerelease.join(".")}`;
	return s;
}

function zeroFillStr(rv) {
	return `${rv.major}.${rv.minor ?? 0}.${rv.patch ?? 0}`;
}

function bumpStr(rv) {
	if (rv.n === 1) return `${rv.major + 1}.0.0`;
	if (rv.n === 2) return `${rv.major}.${rv.minor + 1}.0`;
	return `${rv.major}.${rv.minor}.${rv.patch + 1}`;
}

function parseComparator(tok) {
	if (tok === "*") return { bounds: [], anchors: [] };
	if (tok.startsWith("~")) return parseTildeCaret("~", tok.slice(1));
	if (tok.startsWith("^")) return parseTildeCaret("^", tok.slice(1));

	let op, rest;
	if (tok.startsWith(">=")) {
		op = ">=";
		rest = tok.slice(2);
	} else if (tok.startsWith("<=")) {
		op = "<=";
		rest = tok.slice(2);
	} else if (tok.startsWith(">")) {
		op = ">";
		rest = tok.slice(1);
	} else if (tok.startsWith("<")) {
		op = "<";
		rest = tok.slice(1);
	} else if (tok.startsWith("=")) {
		op = "=";
		rest = tok.slice(1);
	} else {
		op = "=";
		rest = tok;
	}
	if (rest === "") throw new SyntaxError(`invalid range: missing version in ${JSON.stringify(tok)}`);

	const rv = parseRangeVersion(rest);
	if (rv.n === 3) {
		const anchors = rv.prerelease ? [{ major: rv.major, minor: rv.minor, patch: rv.patch }] : [];
		return { bounds: [{ op, version: fullStr(rv) }], anchors };
	}
	if (op === "=" || op === ">" || op === ">=") {
		return { bounds: [{ op, version: zeroFillStr(rv) }], anchors: [] };
	}
	return { bounds: [{ op: "<", version: bumpStr(rv) }], anchors: [] };
}

function parseTildeCaret(sym, rest) {
	if (rest === "") throw new SyntaxError(`invalid range: missing version after ${sym}`);
	const rv = parseRangeVersion(rest);
	if (rv.n !== 3) throw new SyntaxError(`invalid range: ${sym} requires a full version, got ${JSON.stringify(rest)}`);
	const lower = fullStr(rv);
	let upper;
	if (sym === "~") {
		upper = `${rv.major}.${rv.minor + 1}.0`;
	} else if (rv.major > 0) {
		upper = `${rv.major + 1}.0.0`;
	} else if (rv.minor > 0) {
		upper = `0.${rv.minor + 1}.0`;
	} else {
		upper = `0.0.${rv.patch + 1}`;
	}
	const anchors = rv.prerelease ? [{ major: rv.major, minor: rv.minor, patch: rv.patch }] : [];
	return {
		bounds: [
			{ op: ">=", version: lower },
			{ op: "<", version: upper },
		],
		anchors,
	};
}

function parseHyphen(aTok, bTok) {
	const a = parseRangeVersion(aTok);
	const b = parseRangeVersion(bTok);
	const lowerBound = { op: ">=", version: a.n === 3 ? fullStr(a) : zeroFillStr(a) };
	const upperBound = b.n === 3 ? { op: "<=", version: fullStr(b) } : { op: "<", version: bumpStr(b) };
	const anchors = [];
	if (a.n === 3 && a.prerelease) anchors.push({ major: a.major, minor: a.minor, patch: a.patch });
	if (b.n === 3 && b.prerelease) anchors.push({ major: b.major, minor: b.minor, patch: b.patch });
	return { bounds: [lowerBound, upperBound], anchors };
}

function parseSet(raw) {
	const s = raw.trim();
	if (s === "") throw new SyntaxError("invalid range: empty comparator set");
	const tokens = s.split(/\s+/);
	if (tokens.length === 3 && tokens[1] === "-") {
		return [parseHyphen(tokens[0], tokens[2])];
	}
	if (tokens.includes("-")) throw new SyntaxError(`invalid range: unexpected "-" in ${JSON.stringify(raw)}`);
	return tokens.map(parseComparator);
}

function parseRange(range) {
	if (typeof range !== "string") throw new SyntaxError("invalid range: not a string");
	const trimmed = range.trim();
	if (trimmed === "") throw new SyntaxError("invalid range: empty range");
	return trimmed.split(/\|\|/).map(parseSet);
}

function boundHolds(op, v, versionStr) {
	const c = compare(v, versionStr);
	switch (op) {
		case "=":
			return c === 0;
		case ">":
			return c === 1;
		case ">=":
			return c >= 0;
		case "<":
			return c === -1;
		case "<=":
			return c <= 0;
		default:
			return false;
	}
}

export function satisfies(v, range) {
	const parsedV = parse(v);
	const groups = parseRange(range);
	for (const set of groups) {
		const boundsOk = set.every((c) => c.bounds.every((b) => boundHolds(b.op, v, b.version)));
		if (!boundsOk) continue;
		if (parsedV.prerelease.length === 0) return true;
		const anchors = set.flatMap((c) => c.anchors);
		if (anchors.some((a) => a.major === parsedV.major && a.minor === parsedV.minor && a.patch === parsedV.patch)) {
			return true;
		}
	}
	return false;
}
