// Grounding checks shared by validate.mjs (the oracle) and probe.mjs for the
// review-guard task. Beyond "quotes are verbatim", this oracle can check one factual
// claim: what the policy REALLY returns for the finding's input. It still cannot
// judge whether that verdict was wrong — that is the human's ruling.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRISTINE_CORPUS = path.resolve(here, "..", "ws-builder", "corpus");

export const MIN_FINDINGS = 4;
export const MIN_QUOTE = 30;
export const TOOLS = ["read", "edit", "write", "ls", "grep", "find", "bash"];
export const KINDS = ["false_positive", "false_negative"];

export function corpusDirFor(wsDir) {
	const local = path.join(wsDir, "corpus");
	return fs.existsSync(local) ? local : PRISTINE_CORPUS;
}

export async function loadPolicy(corpusDir) {
	const mod = await import(pathToFileURL(path.join(corpusDir, "path-policy.mjs")).href);
	return mod.decidePath;
}

export function loadFindings(wsDir) {
	const file = path.join(wsDir, "src", "findings.json");
	if (!fs.existsSync(file)) return { error: "src/findings.json not found" };
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return { error: `findings.json is not valid JSON: ${err.message}` };
	}
	if (!doc || typeof doc !== "object" || !Array.isArray(doc.findings)) return { error: "findings.json must be an object with a findings array" };
	return { doc };
}

export function checkEvidence(corpusDir, e) {
	if (!e || typeof e !== "object") return "evidence entry is not an object";
	if (typeof e.file !== "string" || !e.file) return "evidence has no file";
	const file = path.resolve(corpusDir, e.file);
	if (!file.startsWith(corpusDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return `file "${e.file}" does not exist in corpus/`;
	const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines.length) return `line ${JSON.stringify(e.line)} is outside ${e.file} (${lines.length} lines)`;
	if (typeof e.quote !== "string" || e.quote.length < MIN_QUOTE) return `quote is shorter than ${MIN_QUOTE} characters`;
	if (!text.includes(e.quote)) return `quote is not found verbatim in ${e.file}`;
	return null;
}

/** Ordered checks for one finding; `policy` is decidePath, `root` the workspace. */
export function checkFinding({ corpusDir, policy, root }, f) {
	const tag = f?.id ?? "?";
	const checks = [];
	let verdict = null;
	const ok = (cond, label) => checks.push({ ok: Boolean(cond), label: `${tag}: ${label}` });
	const isStr = (v) => typeof v === "string" && v.trim().length > 0;
	if (!f || typeof f !== "object") {
		ok(false, "finding is not an object");
		return { checks, verdict };
	}
	ok(isStr(f.id) && KINDS.includes(f.kind), `id is non-empty and kind is one of ${KINDS.join("|")}`);
	ok(TOOLS.includes(f.tool), `tool is one of ${TOOLS.join(", ")}`);
	ok(f.input && typeof f.input === "object" && !Array.isArray(f.input), "input is the tool's argument object");
	ok(["allow", "deny"].includes(f.expected) && ["allow", "deny"].includes(f.actual), "expected and actual are allow|deny");
	ok(f.expected !== f.actual, "expected and actual differ");
	if (TOOLS.includes(f.tool) && f.input && typeof f.input === "object") {
		try {
			verdict = policy({ root, tool: f.tool, input: f.input }).ok ? "allow" : "deny";
		} catch (err) {
			verdict = `error: ${err.message}`;
		}
	}
	ok(verdict === f.actual, `actual matches the policy (policy returns ${verdict ?? "nothing"})`);
	const evidence = Array.isArray(f.evidence) ? f.evidence : [];
	ok(evidence.length >= 1, "at least one evidence entry");
	evidence.forEach((e, i) => {
		const why = checkEvidence(corpusDir, e);
		ok(why === null, `evidence[${i}] ${why ?? "grounded"}`);
	});
	ok(isStr(f.why) && isStr(f.proposed_fix), "why and proposed_fix are non-empty");
	ok(typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1, "confidence is a number in [0, 1]");
	return { checks, verdict };
}
