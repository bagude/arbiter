// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stringify(v) {
	if (v === null || v === undefined) return "";
	return String(v);
}

function isFalsy(v) {
	if (Array.isArray(v)) return v.length === 0;
	return !v;
}

function parse(template) {
	const root = { name: null, invert: false, children: [] };
	const stack = [root];
	let i = 0;
	while (i < template.length) {
		const start = template.indexOf("{{", i);
		if (start === -1) {
			stack[stack.length - 1].children.push({ type: "text", value: template.slice(i) });
			break;
		}
		if (start > i) stack[stack.length - 1].children.push({ type: "text", value: template.slice(i, start) });

		if (template[start + 2] === "{") {
			const close = template.indexOf("}}}", start + 3);
			if (close === -1) throw new SyntaxError(`unterminated tag: {{{ opened at offset ${start} has no matching }}}`);
			const name = template.slice(start + 3, close).trim();
			stack[stack.length - 1].children.push({ type: "var", name, escape: false });
			i = close + 3;
			continue;
		}

		const close = template.indexOf("}}", start + 2);
		if (close === -1) throw new SyntaxError(`unterminated tag: {{ opened at offset ${start} has no matching }}`);
		const content = template.slice(start + 2, close).trim();
		i = close + 2;

		const sigil = content[0];
		if (sigil === "!") {
			continue; // comment: dropped entirely
		}
		if (sigil === "#" || sigil === "^") {
			const name = content.slice(1).trim();
			const node = { type: "section", name, invert: sigil === "^", children: [] };
			stack[stack.length - 1].children.push(node);
			stack.push(node);
			continue;
		}
		if (sigil === "/") {
			const name = content.slice(1).trim();
			if (stack.length === 1) throw new SyntaxError(`unexpected close: {{/${name}}} has no open section`);
			const top = stack[stack.length - 1];
			if (top.name !== name) throw new SyntaxError(`mismatched close: {{/${name}}} does not match open {{#${top.name}}}`);
			stack.pop();
			continue;
		}
		const name = content;
		stack[stack.length - 1].children.push({ type: "var", name, escape: true });
	}
	if (stack.length !== 1) {
		const open = stack[stack.length - 1];
		throw new SyntaxError(`unclosed section: {{${open.invert ? "^" : "#"}${open.name}}} is never closed`);
	}
	return root;
}

function evalName(name, stack) {
	if (name === ".") return stack[stack.length - 1];
	const parts = name.split(".");
	let value;
	let found = false;
	for (let idx = stack.length - 1; idx >= 0; idx--) {
		const frame = stack[idx];
		if (frame !== null && typeof frame === "object" && Object.prototype.hasOwnProperty.call(frame, parts[0])) {
			value = frame[parts[0]];
			found = true;
			break;
		}
	}
	if (!found) return undefined;
	for (let k = 1; k < parts.length; k++) {
		if (value === null || value === undefined) return undefined;
		value = value[parts[k]];
	}
	return value;
}

function renderNodes(nodes, stack, out) {
	for (const node of nodes) {
		if (node.type === "text") {
			out.push(node.value);
		} else if (node.type === "var") {
			const str = stringify(evalName(node.name, stack));
			out.push(node.escape ? escapeHtml(str) : str);
		} else if (node.type === "section") {
			const value = evalName(node.name, stack);
			if (node.invert) {
				if (isFalsy(value)) renderNodes(node.children, stack, out);
				continue;
			}
			if (isFalsy(value)) continue;
			if (Array.isArray(value)) {
				for (const el of value) {
					stack.push(el);
					renderNodes(node.children, stack, out);
					stack.pop();
				}
			} else if (typeof value === "object") {
				stack.push(value);
				renderNodes(node.children, stack, out);
				stack.pop();
			} else {
				renderNodes(node.children, stack, out);
			}
		}
	}
}

export function render(template, data) {
	if (typeof template !== "string") throw new TypeError(`template must be a string: got ${typeof template}`);
	const root = parse(template);
	const stack = [data === undefined ? {} : data];
	const out = [];
	renderNodes(root.children, stack, out);
	return out.join("");
}
