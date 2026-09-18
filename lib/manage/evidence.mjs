// evidence — §6's four check kinds, verified by the harness against a checkpoint.
//
// §6's whole point: "the manager decides whether the required evidence is present and asks for
// acceptance; the harness verifies it against the criterion as written." So nothing in this file
// takes the instruction's word for anything. A criterion names a kind and a target; the answer
// comes from the run's own records, the checkpoint's own files, a script's exit code, or a
// human's signed ledger row — never from the args that asked for acceptance.
//
// Pure but for three things it cannot be: it reads files, it runs the playthrough script (through
// an injected `spawn`, so a dry validation can answer without executing anything), and it writes
// that script's output to the checkpoint's own evidence log, which is the artefact §6 requires
// ("with its log attached").
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpointDir, finalWorkspaceOf, workspaceHash, readManifest } from "./checkpoint.mjs";
import { readLedger, reversedSeqs } from "./ledger.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A playthrough is a whole run of the product under test; ten minutes is the ceiling, after
 * which the script is the failure rather than the checkpoint. */
export const PLAYTHROUGH_TIMEOUT_MS = 10 * 60 * 1000;

export const EVIDENCE_KINDS = ["oracle", "playthrough", "artifact", "review"];

/** `<kind>:<rest>` — the shape createTask already enforces on every criterion's `check`. */
export function parseCheck(check) {
	const m = /^([a-z]+):([\s\S]*)$/.exec(String(check ?? ""));
	if (!m || !EVIDENCE_KINDS.includes(m[1])) return null;
	return { kind: m[1], rest: m[2] };
}

const slash = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

const fail = (reason) => ({ ok: false, reason, artefacts: [] });
const pass = (artefacts) => ({ ok: true, reason: null, artefacts });

/** A path as an artefact should read it: relative to the repo root when it is inside. */
const relRoot = (p) => (path.resolve(p).startsWith(path.resolve(ROOT) + path.sep) ? path.relative(ROOT, p).split(path.sep).join("/") : slash(p));

/**
 * The oracle verdicts a run's audit recorded, in order: `Oracle run #n: pass/total passed.`
 *
 * audit.jsonl is the authority rather than summary.json, for the reason packet.mjs's liveSummary
 * gives — the summary is written in finish() and the per-attempt results are not in it at all.
 * The `0/0` line a validator that produced nothing parseable leaves (supervisor.mjs, "treating as
 * 0/0 (fail-closed)") parses here like any other and fails `total > 0` below, which is the point:
 * a run whose oracle never reported has not passed it.
 */
export function oracleResults(runDir) {
	const f = path.join(runDir, "audit.jsonl");
	if (!fs.existsSync(f)) return [];
	const out = [];
	for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row?.type !== "oracle" || typeof row.msg !== "string") continue;
		const m = /^Oracle run #(\d+): (\d+)\/(\d+)\b/.exec(row.msg);
		if (m) out.push({ attempt: Number(m[1]), pass: Number(m[2]), total: Number(m[3]) });
	}
	return out;
}

/** The oracle directory a run exercised, from the task it ran: `tasks/<task>/oracle`. That is
 * the layout every task on disk has, and summary.json's `task` is the only record of which one a
 * run used — the config path it also carries can be anywhere and can be edited afterwards. */
export const oracleDirOfRun = (summary) => (summary?.task ? `tasks/${summary.task}/oracle` : null);

/** The four validators §6 allows, as a whole tail. `grep=` swallows the rest of the string. */
const VALIDATOR = /^(exists|nonempty|json|grep=[\s\S]*)$/;

/**
 * `artifact:<path>[:<validator>]` — the first colon whose tail IS a validator splits it.
 *
 * Neither end alone works. Splitting at the LAST colon breaks `artifact:docs/a.md:grep=a:b`,
 * whose regex is allowed to contain one and whose tail is then `b`; splitting at the first colon
 * unconditionally breaks a file called `docs/a:b.md`. So the tail decides, scanning left to
 * right, and a path with no validator-shaped tail is a path.
 */
export function parseArtifact(rest) {
	for (let at = rest.indexOf(":"); at > 0; at = rest.indexOf(":", at + 1)) {
		const tail = rest.slice(at + 1);
		if (VALIDATOR.test(tail)) return { file: rest.slice(0, at), validator: tail };
	}
	return { file: rest, validator: "exists" };
}

function checkArtifact(rest, ckDir) {
	const { file, validator } = parseArtifact(rest);
	// Containment, checked on the resolved path: a criterion is human-written, but the checkpoint
	// is the only tree this kind may speak about, and `../../etc` would otherwise let one accept a
	// milestone on a file the run never produced.
	const target = path.resolve(ckDir, file);
	if (target !== path.resolve(ckDir) && !target.startsWith(path.resolve(ckDir) + path.sep)) return fail(`artifact ${file} resolves outside the checkpoint`);
	if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(`no file ${file} in the checkpoint`);
	if (validator === "exists") return pass([`artifact:${slash(file)}`]);
	if (validator === "nonempty") {
		const size = fs.statSync(target).size;
		return size > 0 ? pass([`artifact:${slash(file)}:nonempty`]) : fail(`${file} is empty`);
	}
	const text = fs.readFileSync(target, "utf8");
	if (validator === "json") {
		try {
			JSON.parse(text);
		} catch (err) {
			return fail(`${file} is not valid JSON: ${err.message}`);
		}
		return pass([`artifact:${slash(file)}:json`]);
	}
	const src = validator.slice("grep=".length);
	let re;
	try {
		re = new RegExp(src);
	} catch (err) {
		return fail(`${file}: grep=${src} is not a valid regular expression (${err.message})`);
	}
	return re.test(text) ? pass([`artifact:${slash(file)}:grep=${src}`]) : fail(`${file} does not match /${src}/`);
}

function checkOracle(rest, criterion, { runsDir, evidence, checkpoint, taskDir }) {
	const want = slash(rest);
	const manifest = readManifest(taskDir, checkpoint);
	if (!manifest) return fail(`checkpoint ${checkpoint} has no manifest`);
	if (!runsDir) return fail("no runs directory to verify an oracle result against");
	const why = [];
	for (const runId of evidence ?? []) {
		const runDir = path.join(runsDir, runId);
		const summaryFile = path.join(runDir, "summary.json");
		if (!fs.existsSync(summaryFile)) {
			why.push(`${runId}: no summary.json`);
			continue;
		}
		let summary;
		try {
			summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
		} catch (err) {
			why.push(`${runId}: summary.json is unreadable (${err.message})`);
			continue;
		}
		const got = slash(oracleDirOfRun(summary) ?? "");
		if (got !== want) {
			why.push(`${runId}: ran ${got || "no task"}, not ${want}`);
			continue;
		}
		const results = oracleResults(runDir);
		const last = results[results.length - 1];
		if (!last) {
			why.push(`${runId}: no oracle verdict in audit.jsonl`);
			continue;
		}
		if (!(last.total > 0 && last.pass === last.total)) {
			why.push(`${runId}: oracle run #${last.attempt} was ${last.pass}/${last.total}`);
			continue;
		}
		// The run passed its oracle — but on WHICH tree? A passing run whose workspace is not the
		// one being accepted is evidence for a different state, and this is the only check that
		// ties the two together (§6: "on the checkpoint being accepted").
		const ws = finalWorkspaceOf(runsDir, runId);
		if (!ws) {
			why.push(`${runId}: no final workspace on disk (neither runs/${runId}/ws-builder nor runs/.ws-${runId}/ws-builder)`);
			continue;
		}
		const hash = workspaceHash(ws);
		if (hash !== manifest.treeHash) {
			why.push(`${runId}: its final workspace (${relRoot(ws)}) hashes ${hash}, and ${checkpoint} is ${manifest.treeHash}`);
			continue;
		}
		return pass([`oracle:runs/${runId}/oracle-${last.attempt}`]);
	}
	return fail(`no run in the evidence passed ${want} on ${checkpoint}${why.length ? ` — ${why.join("; ")}` : " (no runs named)"}`);
}

function checkPlaythrough(rest, criterion, { taskDir, checkpoint, spawn }) {
	const script = path.isAbsolute(rest) ? rest : path.join(ROOT, rest);
	if (!fs.existsSync(script)) return fail(`playthrough script ${rest} does not exist (resolved to ${script})`);
	const ckDir = checkpointDir(taskDir, checkpoint);
	const r = spawn(process.execPath, [script, ckDir], { encoding: "utf8", timeout: PLAYTHROUGH_TIMEOUT_MS });
	// The log is written whatever the exit code: a failed playthrough is exactly the output a
	// human reading the refusal needs, and §6 requires the passing one attached as the artefact.
	const logDir = path.join(ckDir, "evidence");
	fs.mkdirSync(logDir, { recursive: true });
	const log = path.join(logDir, `${criterion.id}.log`);
	fs.writeFileSync(log, `${r.stdout ?? ""}${r.stderr ?? ""}`);
	const rel = `${checkpoint}/evidence/${criterion.id}.log`;
	if (r.error) return fail(`playthrough ${rest} could not run: ${r.error.message} (log: ${rel})`);
	if (r.status !== 0) return fail(`playthrough ${rest} exited ${r.status ?? `on signal ${r.signal}`} (log: ${rel})`);
	return pass([`playthrough:${slash(rest)}`, `log:${rel}`]);
}

/**
 * §6's `review:human`: a signed ledger row naming this criterion AND this checkpoint.
 *
 * Retracted rows are subtracted (reversedSeqs) like everywhere else that reads the ledger — a row
 * a later `reversed` row names is something that did not happen, and a human review is no
 * exception. `signed === true` strictly: a truthy string is a row somebody wrote by hand without
 * reading the shape.
 */
function checkReview(rest, criterion, { taskDir, checkpoint }) {
	if (rest !== "human") return fail(`unknown review target ${JSON.stringify(rest)} — the only one is review:human`);
	const rows = readLedger(taskDir);
	const reversed = reversedSeqs(rows);
	const row = rows.find((r) => r.kind === "review" && !reversed.has(r.seq) && r.criterion === criterion.id && r.checkpoint === checkpoint && r.signed === true);
	if (!row) return fail(`no signed review row for ${criterion.id} on ${checkpoint} in the ledger`);
	if (!row.by) return fail(`the review row for ${criterion.id} on ${checkpoint} names no reviewer`);
	return pass([`review:${row.by}`]);
}

/**
 * Does this criterion's evidence exist, for this checkpoint? → `{ ok, reason, artefacts }`.
 *
 * `ctx`: `{ taskDir, checkpoint, runsDir, evidence, spawn }`. `evidence` is the run ids the
 * instruction named (§3's `accept` args); `artefacts` is what actually satisfied the criterion,
 * which is what §1's `milestones[].evidence` records — the two are not the same list, and a
 * manager naming three runs proves nothing about which one passed.
 */
export function checkEvidence(criterion, ctx) {
	const parsed = parseCheck(criterion?.check);
	if (!parsed) return fail(`criterion ${criterion?.id ?? "?"}: ${JSON.stringify(criterion?.check)} is not one of ${EVIDENCE_KINDS.map((k) => `${k}:`).join(" ")}`);
	// `?? spawnSync` rather than a spread default: the caller passes `spawn` as a key whether or
	// not it injected one, and a spread would overwrite the default with undefined.
	const c = { ...ctx, spawn: ctx?.spawn ?? spawnSync };
	if (parsed.kind === "oracle") return checkOracle(parsed.rest, criterion, c);
	if (parsed.kind === "playthrough") return checkPlaythrough(parsed.rest, criterion, c);
	if (parsed.kind === "artifact") return checkArtifact(parsed.rest, checkpointDir(c.taskDir, c.checkpoint));
	return checkReview(parsed.rest, criterion, c);
}
