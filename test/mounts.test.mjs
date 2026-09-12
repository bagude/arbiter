import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMounts, installMounts, archiveFilter, uninstallMounts } from "../lib/mounts.mjs";

function scratch() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-mounts-"));
}

test("readMounts resolves targets against home and rejects escaping paths", () => {
	const home = scratch();
	const task = path.join(home, "tasks", "t");
	fs.mkdirSync(task, { recursive: true });
	fs.writeFileSync(path.join(task, "mounts.json"), JSON.stringify({ mounts: [{ path: "data/real", target: "runs/.mounts/x" }] }));
	assert.deepEqual(readMounts(task, home), [{ path: "data/real", target: path.resolve(home, "runs/.mounts/x") }]);
	fs.writeFileSync(path.join(task, "mounts.json"), JSON.stringify([{ path: "../out", target: "x" }]));
	assert.throws(() => readMounts(task, home), /workspace-relative/);
	assert.deepEqual(readMounts(path.join(home, "nope"), home), []);
});

test("installMounts links, the archive filter skips the link, and removing the workspace never touches the target", () => {
	const home = scratch();
	const target = path.join(home, "snapshot");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "big.db"), "precious");
	const ws = path.join(home, "ws");
	fs.mkdirSync(path.join(ws, "src"), { recursive: true });
	fs.writeFileSync(path.join(ws, "src", "a.py"), "x");
	const installed = installMounts(ws, [{ path: "data/real", target }]);
	assert.equal(fs.readFileSync(path.join(ws, "data", "real", "big.db"), "utf8"), "precious", "readable through the link");
	// archive: the link is skipped, the rest copied
	const archive = path.join(home, "archive");
	fs.cpSync(ws, archive, { recursive: true, filter: archiveFilter(installed) });
	assert.ok(fs.existsSync(path.join(archive, "src", "a.py")));
	assert.ok(!fs.existsSync(path.join(archive, "data", "real")), "the mount is not archived");
	// teardown: unlink first, then rm the workspace — the target survives either way
	uninstallMounts(installed);
	fs.rmSync(ws, { recursive: true, force: true });
	assert.equal(fs.readFileSync(path.join(target, "big.db"), "utf8"), "precious");
	// and even a rm without uninstall leaves the target alone (junctions are not followed)
	const ws2 = path.join(home, "ws2");
	fs.mkdirSync(ws2);
	installMounts(ws2, [{ path: "data/real", target }]);
	fs.rmSync(ws2, { recursive: true, force: true });
	assert.equal(fs.readFileSync(path.join(target, "big.db"), "utf8"), "precious");
});
