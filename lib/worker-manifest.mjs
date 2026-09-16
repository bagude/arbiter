// The wid-to-transcript join, on disk. lib/workers.mjs keeps this only in memory
// (tracker.bound, tracker.unbound); nothing about it survives the process. This
// module gives the supervisor an append-only sibling of lifecycle.jsonl —
// workers.jsonl in the run directory — recording the same events a reader can later
// fold into one row per worker without replaying the lifecycle reducer.
import fs from "node:fs";
import path from "node:path";

export function appendManifest(runDir, record) {
	fs.mkdirSync(runDir, { recursive: true });
	const line = JSON.stringify({ ts: record.ts ?? Date.now(), ...record });
	fs.appendFileSync(path.join(runDir, "workers.jsonl"), `${line}\n`);
}

/**
 * The manifest path for a bound transcript, as it will read once the run has
 * finished. Transcripts live under SESSIONS (runs/.sessions-<runId>, a sibling
 * of RUN = runs/<runId>) while the run is live; finish() in supervisor.mjs
 * copies SESSIONS into RUN/sessions and deletes the original. A path recorded
 * relative to RUN at bind time (`../.sessions-<runId>/...`) would dangle after
 * that move, so the manifest instead stores the path the transcript will have
 * post-finish: `sessions/<relative from sessionsDir to p>`.
 */
export function transcriptManifestPath(sessionsDir, p) {
	return path.join("sessions", path.relative(sessionsDir, p)).replace(/\\/g, "/");
}

export function readManifest(runDir) {
	const file = path.join(runDir, "workers.jsonl");
	if (!fs.existsSync(file)) return [];
	const out = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// malformed line skipped
		}
	}
	return out;
}

/**
 * Fold manifest records into one row per worker id. `created` and `bound` fill in
 * fields once each; `completed`/`failed`/`resumed` set status to the event's own
 * status (the last one seen wins) and `outcome` to the raw pi-subagents status
 * string the lifecycle event carried (also last-one-wins) — a resumed run that
 * actually errored keeps `status: "resumed"` but carries `outcome: "error"`, so a
 * reader can tell the two apart without importing the terminal-error set itself;
 * `resuming` puts status back to "running" ahead of the next terminal event.
 *
 * `created` and `started` are the same initiating event from two different spawn
 * shapes (pi-subagents emits `created` only for a queued/background spawn and
 * `started` for every spawn — a foreground worker's first event is `started`, so
 * without folding it in here a foreground run's manifest row would never get a
 * description, background flag or specialist type). Whichever of the two arrives
 * first wins those fields (a queued job's later `started` must not clobber its
 * enqueue-time `createdTs` or overwrite `background: true` with a payload that
 * omits it); `type` — the specialist name — is idempotent across both, so either
 * one may set it.
 */
export function manifestJoin(records) {
	const rows = new Map();
	for (const record of records) {
		const wid = record?.wid;
		if (!wid) continue;
		if (!rows.has(wid)) {
			rows.set(wid, {
				wid,
				description: null,
				background: null,
				sessionId: null,
				transcriptPath: null,
				createdTs: null,
				boundTs: null,
				endedTs: null,
				status: "running",
				outcome: null,
				type: null,
			});
		}
		const row = rows.get(wid);
		switch (record.ev) {
			case "created":
			case "started":
				if (row.description === null) row.description = record.description ?? null;
				if (row.background === null) row.background = record.background ?? null;
				if (row.createdTs === null) row.createdTs = record.ts ?? null;
				row.type = record.type ?? row.type ?? null;
				break;
			case "bound":
				row.sessionId = record.sessionId ?? null;
				row.transcriptPath = record.transcriptPath ?? null;
				row.boundTs = record.ts ?? null;
				break;
			case "resuming":
				row.status = "running";
				break;
			case "completed":
			case "failed":
			case "resumed":
				row.status = record.status ?? record.ev;
				row.outcome = record.outcome ?? null;
				row.endedTs = record.ts ?? null;
				break;
			default:
				break;
		}
	}
	return rows;
}
