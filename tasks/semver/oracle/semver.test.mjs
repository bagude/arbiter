// Hidden acceptance test. Lives outside every agent workspace; run host-side by the supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, compare, satisfies } from "./src/semver.mjs";

function isSyntaxErrorStarting(prefix) {
	return (err) => err instanceof SyntaxError && err.message.startsWith(prefix);
}

// ---- parse ----

test("parse: basic major.minor.patch", () => {
	assert.deepEqual(parse("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
});

test("parse: strips a leading v", () => {
	assert.deepEqual(parse("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
});

test("parse: prerelease identifiers", () => {
	assert.deepEqual(parse("1.2.3-alpha.1").prerelease, ["alpha", "1"]);
});

test("parse: build identifiers", () => {
	assert.deepEqual(parse("1.2.3+build.5").build, ["build", "5"]);
});

test("parse: prerelease and build together", () => {
	const p = parse("1.2.3-alpha.1+build.5");
	assert.deepEqual(p.prerelease, ["alpha", "1"]);
	assert.deepEqual(p.build, ["build", "5"]);
});

test("parse: all zeros is valid", () => {
	assert.deepEqual(parse("0.0.0"), { major: 0, minor: 0, patch: 0, prerelease: [], build: [] });
});

test("parse: leading zero in major throws", () => {
	assert.throws(() => parse("01.2.3"), isSyntaxErrorStarting("invalid version"));
});

test("parse: leading zero in numeric prerelease id throws", () => {
	assert.throws(() => parse("1.2.3-01"), isSyntaxErrorStarting("invalid version"));
});

test("parse: bare 0 prerelease id is allowed", () => {
	assert.deepEqual(parse("1.2.3-0").prerelease, ["0"]);
});

test("parse: non-string input throws", () => {
	assert.throws(() => parse(42), isSyntaxErrorStarting("invalid version"));
});

test("parse: missing patch component throws", () => {
	assert.throws(() => parse("1.2"), isSyntaxErrorStarting("invalid version"));
});

test("parse: trailing dash or plus with no identifier throws", () => {
	assert.throws(() => parse("1.2.3-"), isSyntaxErrorStarting("invalid version"));
	assert.throws(() => parse("1.2.3+"), isSyntaxErrorStarting("invalid version"));
});

test("parse: empty identifier between dots throws", () => {
	assert.throws(() => parse("1.2.3-alpha..1"), isSyntaxErrorStarting("invalid version"));
});

// ---- compare ----

test("compare: a less than b", () => {
	assert.equal(compare("1.0.0", "2.0.0"), -1);
});

test("compare: a greater than b", () => {
	assert.equal(compare("2.0.0", "1.0.0"), 1);
});

test("compare: equal versions", () => {
	assert.equal(compare("1.0.0", "1.0.0"), 0);
});

test("compare: build metadata is ignored", () => {
	assert.equal(compare("1.0.0+aaa", "1.0.0+zzz"), 0);
});

test("compare: prerelease has lower precedence than release", () => {
	assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
	assert.equal(compare("1.0.0", "1.0.0-alpha"), 1);
});

test("compare: classic precedence chain", () => {
	const chain = [
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
	];
	for (let i = 0; i < chain.length - 1; i++) {
		assert.equal(compare(chain[i], chain[i + 1]), -1, `${chain[i]} < ${chain[i + 1]}`);
		assert.equal(compare(chain[i + 1], chain[i]), 1, `${chain[i + 1]} > ${chain[i]}`);
	}
});

test("compare: numeric prerelease identifiers compare numerically", () => {
	assert.equal(compare("1.0.0-2", "1.0.0-10"), -1);
});

test("compare: numeric identifier always lower than alphanumeric", () => {
	assert.equal(compare("1.0.0-9", "1.0.0-a"), -1);
});

test("compare: leading v is normalized", () => {
	assert.equal(compare("v1.2.3", "1.2.3"), 0);
});

test("compare: throws on invalid version", () => {
	assert.throws(() => compare("1.2.3", "nope"), isSyntaxErrorStarting("invalid version"));
});

// ---- satisfies: bare / exact / partial fill ----

test("satisfies: bare exact match", () => {
	assert.equal(satisfies("1.2.3", "1.2.3"), true);
});

test("satisfies: bare exact mismatch", () => {
	assert.equal(satisfies("1.2.4", "1.2.3"), false);
});

test("satisfies: explicit = operator", () => {
	assert.equal(satisfies("1.2.3", "=1.2.3"), true);
});

test("satisfies: partial bare fills with .0 and matches", () => {
	assert.equal(satisfies("1.2.0", "1.2"), true);
});

test("satisfies: partial bare fills with .0 and rejects other patches", () => {
	assert.equal(satisfies("1.2.3", "1.2"), false);
});

// ---- satisfies: plain comparators + partial fill ----

test("satisfies: >= boundary is inclusive", () => {
	assert.equal(satisfies("1.2.0", ">=1.2.0"), true);
});

test("satisfies: > boundary is exclusive", () => {
	assert.equal(satisfies("1.2.0", ">1.2.0"), false);
});

test("satisfies: < boundary is exclusive", () => {
	assert.equal(satisfies("1.2.0", "<1.2.0"), false);
	assert.equal(satisfies("1.1.9", "<1.2.0"), true);
});

test("satisfies: <= boundary is inclusive", () => {
	assert.equal(satisfies("1.2.0", "<=1.2.0"), true);
});

test("satisfies: partial < uses next boundary", () => {
	assert.equal(satisfies("1.2.5", "<1.2"), true);
	assert.equal(satisfies("1.3.0", "<1.2"), false);
});

test("satisfies: partial <= with major only uses next boundary", () => {
	assert.equal(satisfies("1.9.9", "<=1"), true);
	assert.equal(satisfies("2.0.0", "<=1"), false);
});

test("satisfies: partial >= fills with .0", () => {
	assert.equal(satisfies("1.5.0", ">=1.2"), true);
	assert.equal(satisfies("1.1.0", ">=1.2"), false);
});

test("satisfies: partial > fills with .0", () => {
	assert.equal(satisfies("1.3.0", ">1.2"), true);
	assert.equal(satisfies("1.2.0", ">1.2"), false);
});

// ---- satisfies: AND sets and OR ----

test("satisfies: comparator set is an AND", () => {
	assert.equal(satisfies("1.5.0", ">=1.2.0 <2.0.0"), true);
	assert.equal(satisfies("2.0.0", ">=1.2.0 <2.0.0"), false);
});

test("satisfies: || joins alternative sets", () => {
	assert.equal(satisfies("2.0.0", "1.0.0 || 2.0.0"), true);
});

test("satisfies: || picks whichever set matches", () => {
	assert.equal(satisfies("1.5.0", ">=1.0.0 <1.2.0 || >=1.4.0 <2.0.0"), true);
	assert.equal(satisfies("1.3.0", ">=1.0.0 <1.2.0 || >=1.4.0 <2.0.0"), false);
});

// ---- satisfies: tilde ----

test("satisfies: tilde patch-level range", () => {
	assert.equal(satisfies("1.2.5", "~1.2.3"), true);
	assert.equal(satisfies("1.2.2", "~1.2.3"), false);
	assert.equal(satisfies("1.3.0", "~1.2.3"), false);
});

// ---- satisfies: caret ----

test("satisfies: caret range for major >= 1", () => {
	assert.equal(satisfies("1.9.9", "^1.2.3"), true);
	assert.equal(satisfies("2.0.0", "^1.2.3"), false);
});

test("satisfies: caret range for 0.y.z", () => {
	assert.equal(satisfies("0.2.9", "^0.2.3"), true);
	assert.equal(satisfies("0.3.0", "^0.2.3"), false);
});

test("satisfies: caret range for 0.0.z", () => {
	assert.equal(satisfies("0.0.3", "^0.0.3"), true);
	assert.equal(satisfies("0.0.4", "^0.0.3"), false);
});

// ---- satisfies: hyphen ranges ----

test("satisfies: hyphen range is inclusive on both ends", () => {
	assert.equal(satisfies("1.2.3", "1.2.3 - 2.3.4"), true);
	assert.equal(satisfies("2.3.4", "1.2.3 - 2.3.4"), true);
});

test("satisfies: hyphen range excludes outside the bounds", () => {
	assert.equal(satisfies("2.3.5", "1.2.3 - 2.3.4"), false);
	assert.equal(satisfies("1.2.2", "1.2.3 - 2.3.4"), false);
});

test("satisfies: hyphen range with a partial right side uses next boundary", () => {
	assert.equal(satisfies("2.3.9", "1.2.3 - 2.3"), true);
	assert.equal(satisfies("2.4.0", "1.2.3 - 2.3"), false);
});

// ---- satisfies: star ----

test("satisfies: * matches any released version", () => {
	assert.equal(satisfies("5.6.7", "*"), true);
});

test("satisfies: * does not match a prerelease", () => {
	assert.equal(satisfies("1.0.0-alpha", "*"), false);
});

// ---- satisfies: prerelease rule ----

test("satisfies: prerelease never matches a set with no matching prerelease anchor", () => {
	assert.equal(satisfies("1.2.3-alpha", ">=1.0.0"), false);
});

test("satisfies: prerelease matches when a comparator anchors the same major.minor.patch", () => {
	assert.equal(satisfies("1.2.3-alpha", ">=1.2.3-alpha <1.3.0"), true);
	assert.equal(satisfies("1.2.3-beta", ">=1.2.3-alpha <1.3.0"), true);
});

test("satisfies: prerelease anchor must match major.minor.patch exactly", () => {
	assert.equal(satisfies("1.2.4-alpha", ">=1.2.3-alpha <1.3.0"), false);
});

test("satisfies: caret with an explicit prerelease anchors it", () => {
	assert.equal(satisfies("1.2.3-alpha", "^1.2.3-alpha"), true);
});

test("satisfies: a release version does not match a prerelease-only comparator", () => {
	assert.equal(satisfies("1.2.3", "1.2.3-alpha"), false);
});

test("satisfies: exact prerelease match with matching anchor", () => {
	assert.equal(satisfies("1.2.3-alpha", "1.2.3-alpha"), true);
});

// ---- satisfies: errors ----

test("satisfies: empty range throws", () => {
	assert.throws(() => satisfies("1.0.0", ""), isSyntaxErrorStarting("invalid range"));
});

test("satisfies: tilde without a full version throws", () => {
	assert.throws(() => satisfies("1.0.0", "~1.2"), isSyntaxErrorStarting("invalid range"));
});

test("satisfies: caret without a full version throws", () => {
	assert.throws(() => satisfies("1.0.0", "^1.2"), isSyntaxErrorStarting("invalid range"));
});

test("satisfies: build metadata inside a range throws", () => {
	assert.throws(() => satisfies("1.0.0", ">=1.2.3+build"), isSyntaxErrorStarting("invalid range"));
});

test("satisfies: an invalid v propagates the invalid version error", () => {
	assert.throws(() => satisfies("not-a-version", "1.0.0"), isSyntaxErrorStarting("invalid version"));
});

test("satisfies: a non-string range throws invalid range", () => {
	assert.throws(() => satisfies("1.0.0", 42), isSyntaxErrorStarting("invalid range"));
});
