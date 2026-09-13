import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotId } from "../lib/snapshot.mjs";

test("snapshotId hashes relative paths, sizes and mtimes; unchanged data gives the same id", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-snap-"));
	fs.mkdirSync(path.join(dir, "gold"));
	fs.writeFileSync(path.join(dir, "gold", "warehouse.duckdb"), "abc");
	fs.writeFileSync(path.join(dir, "README.md"), "hi");
	const a = snapshotId({ name: "data-warehousers", dir });
	assert.match(a, /^data-warehousers@[0-9a-f]{12}$/);
	assert.equal(snapshotId({ name: "data-warehousers", dir }), a);
	fs.writeFileSync(path.join(dir, "gold", "warehouse.duckdb"), "abcd");
	assert.notEqual(snapshotId({ name: "data-warehousers", dir }), a);
	assert.equal(snapshotId({ name: "seed:x", dir: path.join(dir, "missing") }), "seed:x@none");
});
