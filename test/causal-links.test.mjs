import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceRun } from "../lib/context-trace.mjs";
import { causalLinks } from "../lib/causal-links.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "run-trace");

// context-trace attaches a marker to the call that FOLLOWS the event, so the spawn
// marker on orchestrator call n was issued by call n-1, and the return marker on call m
// means the worker's result is in call m's input.
test("spawn and return markers become issuer→worker and worker→receiver links, shifted by one call", () => {
	const t = traceRun(FIXTURE);
	const oi = t.agents.findIndex((a) => a.role !== "worker"), wi = t.agents.findIndex((a) => a.role === "worker");
	const links = causalLinks(t);
	const spawnCall = t.agents[oi].calls.findIndex((c) => c.markers.some((m) => m.kind === "spawn"));
	const returnCall = t.agents[oi].calls.findIndex((c) => c.markers.some((m) => m.kind === "return"));
	assert.ok(spawnCall > 0 && returnCall > spawnCall);
	assert.deepEqual(links[oi][spawnCall - 1].filter((l) => l.k === "spawned").map((l) => [l.a, l.i]), [[wi, 0]]);
	assert.deepEqual(links[wi][0].map((l) => [l.k, l.a, l.i]), [["spawnedby", oi, spawnCall - 1]]);
	assert.deepEqual(links[oi][spawnCall].filter((l) => l.k === "spawned"), [], "the call carrying the marker did not issue the spawn");
	const received = links[oi][returnCall].find((l) => l.k === "received");
	assert.ok(received && received.a === wi);
	const last = t.agents[wi].calls.length - 1;
	assert.equal(received.i, last, "the worker's last call is the one whose result was delivered");
	assert.deepEqual(links[wi][last].filter((l) => l.k === "delivered").map((l) => [l.a, l.i]), [[oi, returnCall]]);
});

test("a send_mail's reply links to the first call that starts after the matching delivery, chosen by mail kind", () => {
	const mk = (startMs, endMs, tools = [], markers = []) => ({ startMs, endMs, tools, markers });
	const trace = { t0: 0, agents: [{ id: "orchestrator", role: "orchestrator", calls: [mk(0, 1000, ["send_mail"]), mk(2000, 3000), mk(9000, 9500, ["send_mail"]), mk(12000, 12500), mk(20000, 20500)] }] };
	const audit = [
		{ t: "4.0", type: "deliver", msg: "<- memory candidate recorded" },
		{ t: "5.0", type: "deliver", msg: "<- probe results" },
		{ t: "15.0", type: "oracle", msg: "Oracle run #1: 9/10 passed." },
	];
	const kinds = { 0: "probe", 2: "done" };
	const links = causalLinks(trace, { audit, mailKind: (ai, ci) => kinds[ci] ?? null });
	assert.deepEqual(links[0][0], [{ a: 0, i: 2, k: "replied", d: "probe results" }], "a probe waits for the probe delivery, skipping an unrelated one");
	assert.deepEqual(links[0][2], [{ a: 0, i: 4, k: "replied", d: "Oracle run #1: 9/10 passed." }], "a done waits for the oracle verdict");
});

test("a guard denial marker on call n links call n-1 to call n as a retry", () => {
	const mk = (startMs, endMs, markers = []) => ({ startMs, endMs, tools: [], markers });
	const denial = { tMs: 1500, kind: "guard", ev: "guard:topology_denied", agent: "orchestrator", detail: "specialist=implementer" };
	const trace = { t0: 0, agents: [{ id: "orchestrator", role: "orchestrator", calls: [mk(0, 1000), mk(2000, 3000, [denial])] }] };
	const links = causalLinks(trace);
	assert.deepEqual(links[0][0], [{ a: 0, i: 1, k: "retry", d: "specialist=implementer" }]);
	assert.deepEqual(links[0][1], []);
});
