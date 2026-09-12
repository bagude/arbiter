// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function isFiniteNumber(x) {
	return typeof x === "number" && Number.isFinite(x);
}

function assertSet(set) {
	if (!Array.isArray(set)) throw new TypeError("set must be an array");
}

function assertInterval(iv) {
	if (
		!Array.isArray(iv) ||
		iv.length !== 2 ||
		!isFiniteNumber(iv[0]) ||
		!isFiniteNumber(iv[1]) ||
		iv[0] > iv[1]
	) {
		throw new RangeError(`invalid interval: ${JSON.stringify(iv ?? null)}`);
	}
}

function assertBounds(lo, hi) {
	if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || lo > hi) {
		throw new RangeError(`invalid bounds: [${lo}, ${hi}]`);
	}
}

export function normalize(intervals) {
	assertSet(intervals);
	for (const iv of intervals) assertInterval(iv);
	const copies = intervals.map(([lo, hi]) => [lo, hi]);
	copies.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out = [];
	for (const [lo, hi] of copies) {
		const last = out[out.length - 1];
		if (last && lo <= last[1]) {
			if (hi > last[1]) last[1] = hi;
		} else {
			out.push([lo, hi]);
		}
	}
	return out;
}

export function union(a, b) {
	assertSet(a);
	assertSet(b);
	return normalize([...a, ...b]);
}

export function intersect(a, b) {
	assertSet(a);
	assertSet(b);
	const na = normalize(a);
	const nb = normalize(b);
	const out = [];
	let i = 0;
	let j = 0;
	while (i < na.length && j < nb.length) {
		const [alo, ahi] = na[i];
		const [blo, bhi] = nb[j];
		const lo = Math.max(alo, blo);
		const hi = Math.min(ahi, bhi);
		if (lo <= hi) out.push([lo, hi]);
		if (ahi < bhi) i++;
		else j++;
	}
	return normalize(out);
}

export function subtract(a, b) {
	assertSet(a);
	assertSet(b);
	const na = normalize(a);
	const nb = normalize(b);
	const out = [];
	for (const [alo, ahi] of na) {
		const cuts = new Set();
		for (const [blo, bhi] of nb) {
			if (blo > alo && blo < ahi) cuts.add(blo);
			if (bhi > alo && bhi < ahi) cuts.add(bhi);
		}
		const points = [alo, ...[...cuts].sort((x, y) => x - y), ahi];
		for (let k = 0; k < points.length - 1; k++) {
			const plo = points[k];
			const phi = points[k + 1];
			const covered = nb.some(([blo, bhi]) => plo >= blo && phi <= bhi);
			if (!covered) out.push([plo, phi]);
		}
	}
	// Deliberately not re-merged: a cut through the interior of an a-interval
	// can leave two touching remainder pieces (see spec's point-removal example),
	// and merging them back would erase that the interior point was cut.
	return out;
}

export function contains(set, x) {
	assertSet(set);
	const n = normalize(set);
	return n.some(([lo, hi]) => x >= lo && x <= hi);
}

export function insert(set, interval) {
	assertSet(set);
	assertInterval(interval);
	return normalize([...set, [interval[0], interval[1]]]);
}

export function gaps(set, lo, hi) {
	assertSet(set);
	assertBounds(lo, hi);
	return subtract([[lo, hi]], set);
}

export function measure(set) {
	assertSet(set);
	const n = normalize(set);
	return n.reduce((sum, [lo, hi]) => sum + (hi - lo), 0);
}
