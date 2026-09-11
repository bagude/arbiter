import fs from "node:fs";
import path from "node:path";

export function childTranscriptDir(orchestratorSessionDir) {
	if (!fs.existsSync(orchestratorSessionDir)) return null;
	const file = fs.readdirSync(orchestratorSessionDir).find((f) => f.endsWith(".jsonl"));
	if (!file) return null;
	return path.join(orchestratorSessionDir, file.slice(0, -".jsonl".length), "tasks");
}

export function workerIdFromTranscript(filePath) {
	return path.basename(filePath, ".jsonl");
}

export class JsonlTailer {
	constructor(filePath) {
		this.filePath = filePath;
		this.offset = 0;
		this.buf = "";
	}
	readNew() {
		const size = fs.statSync(this.filePath).size;
		if (size <= this.offset) return [];
		const fd = fs.openSync(this.filePath, "r");
		const chunk = Buffer.alloc(size - this.offset);
		fs.readSync(fd, chunk, 0, chunk.length, this.offset);
		fs.closeSync(fd);
		this.offset = size;
		this.buf += chunk.toString("utf8");
		const out = [];
		let i;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
		}
		return out;
	}
}
