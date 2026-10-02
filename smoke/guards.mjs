// Live smoke for the in-band guards: one parent pi (guards loaded via -e, like every
// supervisor-launched role) and one pi-subagents worker (guards loaded from the
// workspace's .pi/extensions, like every worker).
//   path guard    — parent and worker each try to read a file outside the workspace.
//   bash-timeout  — the parent runs a bash command without a timeout.
// Passes when the lifecycle file records a path deny for both roles and a bash
// timeout rewrite for the parent, the parent's answer shows the redirect rather than
// the file, and the inside read worked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installWorkspaceExtension } from "../lib/worker-def.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
import { PI_ROOT } from "../lib/pi-root.mjs";
const PI = PI_ROOT;
const TSX = `${PI}/node_modules/tsx/dist/cli.mjs`;
const CLI = `${PI}/packages/coding-agent/src/cli.ts`;
const GUARDS = [path.join(ROOT, "ext", "path-guard.ts"), path.join(ROOT, "ext", "guards", "bash-timeout.ts")];
const outer = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-guard-"));
const ws = path.join(outer, "ws");
fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "test", "fixtures", "smoke-reader.md"), path.join(ws, ".pi", "agents", "reader.md"));
fs.writeFileSync(path.join(ws, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
fs.writeFileSync(path.join(ws, "inside.txt"), "inside-ok\n");
fs.writeFileSync(path.join(outer, "secret.txt"), "SECRET-OUTSIDE\n");
for (const g of GUARDS) installWorkspaceExtension(ws, g);
const sessionDir = path.join(outer, "sessions");
const lifecycle = path.join(outer, "lifecycle.jsonl");

const prompt =
	"Do these steps in order and report each tool's result text verbatim. " +
	"1) Use the read tool on ../secret.txt. 2) Use the read tool on inside.txt. " +
	"3) Use the bash tool to run exactly: echo bash-ok — do not pass a timeout argument. " +
	'4) Delegate to the subagent tool with subagent_type "reader" and prompt "Use the read tool on ../secret.txt and reply with the exact tool result text." ' +
	"5) Reply with the four results, labelled. Then stop.";

const child = spawn(
	process.execPath,
	[
		TSX, CLI, "--mode", "rpc", "--provider", "llama.cpp", "--model", "qwen3-27b",
		"--session-dir", sessionDir, "--name", "orchestrator",
		"-ne",
		"-e", path.join(ROOT, "node_modules/@gotgenes/pi-subagents/src/index.ts"),
		"-e", path.join(ROOT, "ext/subagents-bridge.ts"),
		...GUARDS.flatMap((g) => ["-e", g]),
		"-na", "-ns", "-np", "-nc", "-t", "read,bash,subagent",
		"--system-prompt", "You follow the user's numbered steps exactly, calling the named tools, and report results verbatim.",
	],
	{
		cwd: ws,
		env: { ...process.env, AGENT_NAME: "orchestrator", ARBITER_LIFECYCLE_FILE: lifecycle, ARBITER_HOME: ROOT, ARBITER_BASH_TIMEOUT_SEC: "45" },
		stdio: ["pipe", "pipe", "inherit"],
	},
);

let done = false;
let buf = "";
let finalText = "";
child.stdout.on("data", (c) => {
	buf += c.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "response" && ev.id === "hello") child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			finalText = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		}
		if (ev.type === "agent_settled") done = true;
	}
});
child.stdin.write(`${JSON.stringify({ id: "hello", type: "get_state" })}\n`);

const deadline = Date.now() + 240_000;
const timer = setInterval(() => {
	if (!done && Date.now() < deadline) return;
	clearInterval(timer);
	child.kill();
	const events = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const guards = events.filter((e) => e.ev.startsWith("guard:")).map((e) => ({ ev: e.ev, ...e.data }));
	const parentDenied = guards.some((g) => g.ev === "guard:path_denied" && g.role === "orchestrator" && g.tool === "read");
	const workerDenied = guards.some((g) => g.ev === "guard:path_denied" && g.role.startsWith("worker:") && g.tool === "read");
	const bashRewritten = guards.some((g) => g.ev === "guard:bash_timeout_rewritten" && g.role === "orchestrator" && g.to === 45);
	const leaked = /SECRET-OUTSIDE/.test(finalText);
	const insideOk = /inside-ok/.test(finalText);
	const bashOk = /bash-ok/.test(finalText);
	const ok = done && parentDenied && workerDenied && bashRewritten && !leaked && insideOk && bashOk;
	console.log(JSON.stringify({ ok, done, parentDenied, workerDenied, bashRewritten, leaked, insideOk, bashOk, guards, finalText: finalText.slice(0, 700), outer }, null, 2));
	process.exit(ok ? 0 : 1);
}, 500);
