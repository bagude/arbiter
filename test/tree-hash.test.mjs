import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { treeHash } from "../lib/tree-hash.mjs";

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "treehash-"));

test("two dirs with the same files hash equal", () => {
	const a = mkdir();
	const b = mkdir();
	fs.writeFileSync(path.join(a, "x.txt"), "hello");
	fs.mkdirSync(path.join(a, "sub"));
	fs.writeFileSync(path.join(a, "sub", "y.txt"), "world");
	fs.writeFileSync(path.join(b, "x.txt"), "hello");
	fs.mkdirSync(path.join(b, "sub"));
	fs.writeFileSync(path.join(b, "sub", "y.txt"), "world");
	assert.equal(treeHash(a), treeHash(b));
});

test("changing one byte changes the hash", () => {
	const a = mkdir();
	fs.writeFileSync(path.join(a, "x.txt"), "hello");
	const before = treeHash(a);
	fs.writeFileSync(path.join(a, "x.txt"), "hellp");
	const after = treeHash(a);
	assert.notEqual(before, after);
});

test("an empty dir hashes to the sha1 of the empty string", () => {
	const a = mkdir();
	assert.equal(treeHash(a), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});
