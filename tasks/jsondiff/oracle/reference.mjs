// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function encodeToken(token) {
	return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function encodePath(tokens) {
	return tokens.map((t) => `/${encodeToken(t)}`).join("");
}

export function pointer(path) {
	if (typeof path !== "string") throw new SyntaxError("invalid pointer: path must be a string");
	if (path === "") return [];
	if (!path.startsWith("/")) throw new SyntaxError(`invalid pointer: ${JSON.stringify(path)} must start with "/"`);
	return path
		.split("/")
		.slice(1)
		.map((tok) => tok.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function assertValidJSON(value) {
	if (typeof value === "number") {
		if (Number.isNaN(value)) throw new TypeError("not JSON: NaN is not a valid JSON value");
		return;
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (Array.isArray(value)) {
		for (const v of value) assertValidJSON(v);
		return;
	}
	if (isPlainObject(value)) {
		for (const k of Object.keys(value)) assertValidJSON(value[k]);
		return;
	}
}

export function diff(a, b) {
	assertValidJSON(a);
	assertValidJSON(b);
	const ops = [];
	diffValue(a, b, [], ops);
	return ops;
}

function diffValue(a, b, tokens, ops) {
	if (a === b) return;
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		const bSet = new Set(bKeys);
		for (const key of aKeys) {
			if (!bSet.has(key)) {
				ops.push({ op: "remove", path: encodePath([...tokens, key]) });
				continue;
			}
			diffChild(a[key], b[key], [...tokens, key], ops);
		}
		const aSet = new Set(aKeys);
		for (const key of bKeys) {
			if (!aSet.has(key)) ops.push({ op: "add", path: encodePath([...tokens, key]), value: b[key] });
		}
		return;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) diffChild(a[i], b[i], [...tokens, String(i)], ops);
		if (b.length > a.length) {
			for (let i = a.length; i < b.length; i++) ops.push({ op: "add", path: encodePath([...tokens, String(i)]), value: b[i] });
		} else if (a.length > b.length) {
			for (let i = a.length - 1; i >= b.length; i--) ops.push({ op: "remove", path: encodePath([...tokens, String(i)]) });
		}
		return;
	}
	ops.push({ op: "replace", path: encodePath(tokens), value: b });
}

function diffChild(av, bv, tokens, ops) {
	if (av === bv) return;
	const bothObjects = isPlainObject(av) && isPlainObject(bv);
	const bothArrays = Array.isArray(av) && Array.isArray(bv);
	if (bothObjects || bothArrays) {
		diffValue(av, bv, tokens, ops);
	} else {
		ops.push({ op: "replace", path: encodePath(tokens), value: bv });
	}
}

const INDEX_RE = /^(0|[1-9]\d*)$/;

function pathString(tokens) {
	return encodePath(tokens);
}

function step(container, token, tokens) {
	if (Array.isArray(container)) {
		if (!INDEX_RE.test(token)) throw new RangeError(`path not found: ${pathString(tokens)}`);
		const idx = Number(token);
		if (idx >= container.length) throw new RangeError(`path not found: ${pathString(tokens)}`);
		return container[idx];
	}
	if (isPlainObject(container)) {
		if (!Object.prototype.hasOwnProperty.call(container, token)) {
			throw new RangeError(`path not found: ${pathString(tokens)}`);
		}
		return container[token];
	}
	throw new RangeError(`path not found: ${pathString(tokens)}`);
}

function getParent(wrapper, tokens) {
	let cur = wrapper.root;
	for (let i = 0; i < tokens.length - 1; i++) {
		cur = step(cur, tokens[i], tokens.slice(0, i + 1));
	}
	return cur;
}

function getValue(wrapper, tokens) {
	if (tokens.length === 0) return wrapper.root;
	const parent = getParent(wrapper, tokens);
	return step(parent, tokens[tokens.length - 1], tokens);
}

function addValue(wrapper, tokens, value) {
	if (tokens.length === 0) {
		wrapper.root = value;
		return;
	}
	const parent = getParent(wrapper, tokens);
	const last = tokens[tokens.length - 1];
	if (Array.isArray(parent)) {
		if (last === "-") {
			parent.push(value);
			return;
		}
		if (!INDEX_RE.test(last)) throw new RangeError(`index out of range: ${pathString(tokens)}`);
		const idx = Number(last);
		if (idx > parent.length) throw new RangeError(`index out of range: ${pathString(tokens)}`);
		parent.splice(idx, 0, value);
		return;
	}
	if (isPlainObject(parent)) {
		parent[last] = value;
		return;
	}
	throw new RangeError(`path not found: ${pathString(tokens)}`);
}

function removeValue(wrapper, tokens) {
	if (tokens.length === 0) throw new RangeError("path not found: (root)");
	const parent = getParent(wrapper, tokens);
	const last = tokens[tokens.length - 1];
	if (Array.isArray(parent)) {
		if (!INDEX_RE.test(last)) throw new RangeError(`path not found: ${pathString(tokens)}`);
		const idx = Number(last);
		if (idx >= parent.length) throw new RangeError(`path not found: ${pathString(tokens)}`);
		const [removed] = parent.splice(idx, 1);
		return removed;
	}
	if (isPlainObject(parent)) {
		if (!Object.prototype.hasOwnProperty.call(parent, last)) throw new RangeError(`path not found: ${pathString(tokens)}`);
		const removed = parent[last];
		delete parent[last];
		return removed;
	}
	throw new RangeError(`path not found: ${pathString(tokens)}`);
}

function replaceValue(wrapper, tokens, value) {
	if (tokens.length === 0) {
		wrapper.root = value;
		return;
	}
	const parent = getParent(wrapper, tokens);
	const last = tokens[tokens.length - 1];
	if (Array.isArray(parent)) {
		if (!INDEX_RE.test(last)) throw new RangeError(`path not found: ${pathString(tokens)}`);
		const idx = Number(last);
		if (idx >= parent.length) throw new RangeError(`path not found: ${pathString(tokens)}`);
		parent[idx] = value;
		return;
	}
	if (isPlainObject(parent)) {
		if (!Object.prototype.hasOwnProperty.call(parent, last)) throw new RangeError(`path not found: ${pathString(tokens)}`);
		parent[last] = value;
		return;
	}
	throw new RangeError(`path not found: ${pathString(tokens)}`);
}

function deepEqual(x, y) {
	if (x === y) return true;
	if (isPlainObject(x) && isPlainObject(y)) {
		const xk = Object.keys(x);
		const yk = Object.keys(y);
		if (xk.length !== yk.length) return false;
		return xk.every((k) => Object.prototype.hasOwnProperty.call(y, k) && deepEqual(x[k], y[k]));
	}
	if (Array.isArray(x) && Array.isArray(y)) {
		if (x.length !== y.length) return false;
		return x.every((v, i) => deepEqual(v, y[i]));
	}
	return false;
}

const VALID_OPS = new Set(["add", "remove", "replace", "move", "copy", "test"]);

export function apply(doc, ops) {
	const wrapper = { root: structuredClone(doc) };
	for (const op of ops) {
		if (!op || !VALID_OPS.has(op.op)) throw new RangeError(`unknown op: ${op && op.op}`);
		const tokens = pointer(op.path);
		switch (op.op) {
			case "add":
				addValue(wrapper, tokens, op.value);
				break;
			case "remove":
				removeValue(wrapper, tokens);
				break;
			case "replace":
				replaceValue(wrapper, tokens, op.value);
				break;
			case "move": {
				const fromTokens = pointer(op.from);
				const value = removeValue(wrapper, fromTokens);
				addValue(wrapper, tokens, value);
				break;
			}
			case "copy": {
				const fromTokens = pointer(op.from);
				const value = getValue(wrapper, fromTokens);
				addValue(wrapper, tokens, structuredClone(value));
				break;
			}
			case "test": {
				const value = getValue(wrapper, tokens);
				if (!deepEqual(value, op.value)) throw new Error(`test failed at ${op.path}`);
				break;
			}
		}
	}
	return wrapper.root;
}
