// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function buildGraph(nodes, edges) {
	const known = new Set();
	for (const n of nodes) {
		if (typeof n !== "string") throw new TypeError(`node must be a string, got ${typeof n}`);
		if (known.has(n)) throw new RangeError(`duplicate node: ${n}`);
		known.add(n);
	}
	const adjSets = new Map();
	const indegree = new Map();
	for (const n of nodes) {
		adjSets.set(n, new Set());
		indegree.set(n, 0);
	}
	for (const [from, to] of edges) {
		if (!known.has(from)) throw new RangeError(`unknown node: ${from}`);
		if (!known.has(to)) throw new RangeError(`unknown node: ${to}`);
		if (!adjSets.get(from).has(to)) {
			adjSets.get(from).add(to);
			indegree.set(to, indegree.get(to) + 1);
		}
	}
	const adj = new Map();
	for (const n of nodes) adj.set(n, [...adjSets.get(n)].sort());
	return { known, adj, indegree };
}

export function topoSort(nodes, edges) {
	const { adj, indegree } = buildGraph(nodes, edges);
	const indeg = new Map(indegree);
	const available = nodes.filter((n) => indeg.get(n) === 0).sort();
	const order = [];
	while (available.length) {
		const n = available.shift();
		order.push(n);
		for (const m of adj.get(n)) {
			indeg.set(m, indeg.get(m) - 1);
			if (indeg.get(m) === 0) {
				available.push(m);
				available.sort();
			}
		}
	}
	if (order.length !== nodes.length) {
		throw new Error(`cycle: ${findCycle(nodes, edges).join(" -> ")}`);
	}
	return order;
}

export function layers(nodes, edges) {
	const { adj, indegree } = buildGraph(nodes, edges);
	const indeg = new Map(indegree);
	const remaining = new Set(nodes);
	const result = [];
	while (remaining.size) {
		const layer = [...remaining].filter((n) => indeg.get(n) === 0).sort();
		if (layer.length === 0) break;
		result.push(layer);
		for (const n of layer) {
			remaining.delete(n);
			for (const m of adj.get(n)) indeg.set(m, indeg.get(m) - 1);
		}
	}
	if (remaining.size) {
		throw new Error(`cycle: ${findCycle(nodes, edges).join(" -> ")}`);
	}
	return result;
}

export function findCycle(nodes, edges) {
	const { adj } = buildGraph(nodes, edges);
	const sortedNodes = [...nodes].sort();
	const state = new Map(nodes.map((n) => [n, 0])); // 0 white, 1 gray, 2 black
	const stack = [];
	let found = null;

	function visit(u) {
		state.set(u, 1);
		stack.push(u);
		for (const v of adj.get(u)) {
			if (found) return;
			const s = state.get(v);
			if (s === 1) {
				const idx = stack.indexOf(v);
				found = stack.slice(idx).concat(v);
				return;
			}
			if (s === 0) {
				visit(v);
				if (found) return;
			}
		}
		if (!found) {
			stack.pop();
			state.set(u, 2);
		}
	}

	for (const n of sortedNodes) {
		if (state.get(n) === 0) {
			visit(n);
			if (found) break;
		}
	}

	if (!found) return null;
	const cycleNodes = found.slice(0, -1);
	let minIdx = 0;
	for (let i = 1; i < cycleNodes.length; i++) {
		if (cycleNodes[i] < cycleNodes[minIdx]) minIdx = i;
	}
	const rotated = cycleNodes.slice(minIdx).concat(cycleNodes.slice(0, minIdx));
	rotated.push(rotated[0]);
	return rotated;
}
