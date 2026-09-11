import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PI = "C:/Users/user/open_harnessess/pi/pi";
const TSX = `${PI}/node_modules/tsx/dist/cli.mjs`;
const CLI = `${PI}/packages/coding-agent/src/cli.ts`;
const FIXTURE = path.join(ROOT, "test", "fixtures", "smoke-agent.md");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-smoke-"));
fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
fs.copyFileSync(FIXTURE, path.join(ws, ".pi", "agents", "echoer.md"));
fs.writeFileSync(path.join(ws, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
const sessionDir = path.join(ws, "sessions");
const lifecycle = path.join(ws, "lifecycle.jsonl");

const child = spawn(process.execPath, [
	TSX, CLI, "--mode", "rpc", "--provider", "llama.cpp", "--model", "qwen3-27b",
	"--session-dir", sessionDir, "--name", "orchestrator",
	"-ne", "-e", path.join(ROOT, "node_modules/@gotgenes/pi-subagents/src/index.ts"), "-e", path.join(ROOT, "ext/subagents-bridge.ts"),
	"-na", "-ns", "-np", "-nc", "-t", "subagent",
	"--system-prompt", "You delegate. Use the subagent tool with subagent_type \"echoer\" and prompt \"Run the shell command: echo child-ran\". Then stop.",
], { cwd: ws, env: { ...process.env, ARBITER_LIFECYCLE_FILE: lifecycle }, stdio: ["pipe", "pipe", "inherit"] });

let done = false;
let buf = "";
child.stdout.on("data", (c) => {
	buf += c.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (ev.type === "response" && ev.id === "hello") child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Go." })}\n`);
		if (ev.type === "agent_settled") done = true;
	}
});
child.stdin.write(`${JSON.stringify({ id: "hello", type: "get_state" })}\n`);

const deadline = Date.now() + 120_000;
const timer = setInterval(() => {
	if (!done && Date.now() < deadline) return;
	clearInterval(timer);
	child.kill();
	const events = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const completed = events.find((e) => e.ev === "subagents:completed");
	const transcripts = fs.readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).replace(/\\/g, "/").includes("/tasks/") && String(f).endsWith(".jsonl"));
	const ok = done && completed && JSON.stringify(completed.data).includes("child-ran") && transcripts.length === 1;
	console.log(JSON.stringify({ ok, done, events: events.map((e) => e.ev), transcripts }, null, 2));
	process.exit(ok ? 0 : 1);
}, 500);
