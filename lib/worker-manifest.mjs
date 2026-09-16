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
 * status (the last one seen wins); `resuming` puts status back to "running" ahead of
 * the next terminal event.
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
			});
		}
		const row = rows.get(wid);
		switch (record.ev) {
			case "created":
				row.description = record.description ?? null;
				row.background = record.background ?? null;
				row.createdTs = record.ts ?? null;
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
				row.endedTs = record.ts ?? null;
				break;
			default:
				break;
		}
	}
	return rows;
}
