// How the supervisor judges a probe case and recognises a repeat of one.
//
// Found live (raid, run 2026-09-15T03-11-27): the supervisor compared a probe result
// to the orchestrator's expectation with `JSON.stringify(actual) === JSON.stringify(expect)`.
// That is key-order sensitive, has no tolerance, and reads a partial expectation
// (a few keys of a champion) as a MISMATCH — while ignoring the `match`/`diff`
// fields the task's own probe.mjs had already computed with the task's comparator.
// Every object-shaped result then "mismatched", and the orchestrator spent ~10 min
// re-sending the same probes with the keys reordered — which also slipped past the
// repeat guard, because the repeat key was the same order-sensitive string.
//
// Rules here:
//  - a case's identity is its args with object keys sorted at every level;
//  - when probe.mjs says `match: true|false`, that verdict stands (it knows the task's
//    tolerances and shapes); its `diff` is the explanation;
//  - otherwise (an older probe runner with no verdict) fall back to a key-order-
//    insensitive deep comparison, exact on numbers, over the keys the expectation
//    names — a partial expectation is a claim about those keys only.

export function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** The repeat-guard key for a probe case, or null when it has no args to key on. */
export function argsKey(args) {
	return args === undefined ? null : canonicalJson(args);
}

/** Order-insensitive deep comparison over the keys `expected` names. Returns null on a match, else a path + reason. */
export function deepDiff(actual, expected, at = "$") {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return `${at}: expected array`;
		if (actual.length !== expected.length) return `${at}: length ${actual.length} != ${expected.length}`;
		for (let i = 0; i < expected.length; i++) {
			const r = deepDiff(actual[i], expected[i], `${at}[${i}]`);
			if (r) return r;
		}
		return null;
	}
	if (expected !== null && typeof expected === "object") {
		if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return `${at}: expected object`;
		for (const k of Object.keys(expected)) {
			if (!(k in actual)) return `${at}.${k}: missing`;
			const r = deepDiff(actual[k], expected[k], `${at}.${k}`);
			if (r) return r;
		}
		return null;
	}
	return Object.is(actual, expected) || actual === expected ? null : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

/**
 * Judge one probe result against the case's expectation.
 * `res` is probe.mjs's result row ({ id, ok, value, match?, diff? } or { id, ok: false, error });
 * `expect` is what the orchestrator wrote. `{ throws: "..." }` expects an error containing that text.
 */
export function matchCase(res, expect) {
	if (expect && typeof expect === "object" && !Array.isArray(expect) && "throws" in expect) {
		const matched = !res.ok && String(res.error).includes(String(expect.throws));
		return { matched, detail: matched ? null : res.ok ? "expected a throw, got a value" : `error text does not contain ${JSON.stringify(expect.throws)}` };
	}
	if (!res.ok) return { matched: false, detail: "threw instead of returning" };
	if (typeof res.match === "boolean") return { matched: res.match, detail: res.match ? null : String(res.diff ?? "probe runner reported a mismatch") };
	const diff = deepDiff(res.value, expect);
	return { matched: diff === null, detail: diff };
}
