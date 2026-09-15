// Reference for `raid-save`: canonical JSON, FNV-1a checksum, save/load with validation, save diffs.
import { makeChampion, MAX_LEVEL } from "./raid.mjs";

export const SAVE_VERSION = 1;
export const SAVE_PREFIX = "RAID1";

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function canonical(value) {
	const walk = (v, at) => {
		if (v === null) return "null";
		const t = typeof v;
		if (t === "boolean") return v ? "true" : "false";
		if (t === "number") {
			if (!Number.isFinite(v)) throw inv(`${at}: non-finite number`);
			return JSON.stringify(v);
		}
		if (t === "string") return JSON.stringify(v);
		if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") throw inv(`${at}: unsupported value of type ${t}`);
		if (Array.isArray(v)) return `[${v.map((x, i) => walk(x, `${at}[${i}]`)).join(",")}]`;
		if (isObj(v)) {
			const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
			return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k], `${at}.${k}`)}`).join(",")}}`;
		}
		throw inv(`${at}: unsupported value`);
	};
	return walk(value, "$");
}

export function fnv1a(str) {
	if (typeof str !== "string") throw inv("str must be a string");
	const bytes = new TextEncoder().encode(str);
	let h = 0x811c9dc5;
	for (const b of bytes) {
		h ^= b;
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function validateState(state) {
	if (!isObj(state)) throw inv("state must be an object");
	if (!Array.isArray(state.roster)) throw inv("state.roster must be an array");
	if (!isInt(state.silver) || state.silver < 0) throw inv("state.silver must be an integer >= 0");
	if (!isInt(state.stage) || state.stage < 1) throw inv("state.stage must be an integer >= 1");
	if (!isInt(state.seed)) throw inv("state.seed must be an integer");
	const ids = new Set();
	const roster = state.roster.map((c, i) => {
		const at = `state.roster[${i}]`;
		if (!isObj(c)) throw inv(`${at} must be an object`);
		if (!isInt(c.level) || c.level < 1 || c.level > MAX_LEVEL) throw inv(`${at}.level must be an integer in 1..${MAX_LEVEL}`);
		if (!isInt(c.xp) || c.xp < 0) throw inv(`${at}.xp must be an integer >= 0`);
		let fresh;
		try {
			fresh = makeChampion({ id: c.id, name: c.name, affinity: c.affinity, rarity: c.rarity, base: c.base, skills: c.skills }, c.level);
		} catch (e) {
			throw inv(`${at}: ${e.message}`);
		}
		if (ids.has(fresh.id)) throw inv(`${at}.id "${fresh.id}" is duplicated`);
		ids.add(fresh.id);
		if (!isInt(c.hp) || c.hp < 0 || c.hp > fresh.stats.hp) throw inv(`${at}.hp must be an integer in 0..${fresh.stats.hp}`);
		return { ...fresh, xp: c.xp, hp: c.hp };
	});
	return { version: SAVE_VERSION, roster, silver: state.silver, stage: state.stage, seed: state.seed };
}

export function saveGame(state) {
	const s = validateState(state);
	const payload = canonical({
		version: s.version,
		silver: s.silver,
		stage: s.stage,
		seed: s.seed,
		roster: s.roster.map((c) => ({ id: c.id, name: c.name, affinity: c.affinity, rarity: c.rarity, base: c.base, skills: c.skills, level: c.level, xp: c.xp, hp: c.hp })),
	});
	return `${SAVE_PREFIX}:${fnv1a(payload)}:${payload}`;
}

export function loadGame(text) {
	if (typeof text !== "string") throw inv("save must be a string");
	const m = /^([A-Z0-9]+):([0-9a-f]{8}):([\s\S]*)$/.exec(text);
	if (!m) throw new RangeError("malformed save: expected PREFIX:checksum:payload");
	const [, prefix, sum, payload] = m;
	if (prefix !== SAVE_PREFIX) throw new RangeError(`unsupported version: prefix ${prefix}`);
	if (fnv1a(payload) !== sum) throw new RangeError(`checksum mismatch: expected ${fnv1a(payload)}, found ${sum}`);
	let data;
	try {
		data = JSON.parse(payload);
	} catch (e) {
		throw new RangeError(`malformed save: payload is not JSON (${e.message})`);
	}
	if (!isObj(data) || data.version !== SAVE_VERSION) throw new RangeError(`unsupported version: ${isObj(data) ? data.version : "none"}`);
	const s = validateState({ roster: data.roster, silver: data.silver, stage: data.stage, seed: data.seed });
	return { roster: s.roster, silver: s.silver, stage: s.stage, seed: s.seed };
}

export function diffSaves(a, b) {
	const A = loadGame(a);
	const B = loadGame(b);
	const out = {};
	for (const k of ["silver", "stage", "seed"]) if (A[k] !== B[k]) out[k] = [A[k], B[k]];
	const byId = (r) => new Map(r.map((c) => [c.id, c]));
	const ma = byId(A.roster);
	const mb = byId(B.roster);
	const added = B.roster.filter((c) => !ma.has(c.id)).map((c) => c.id);
	const removed = A.roster.filter((c) => !mb.has(c.id)).map((c) => c.id);
	const leveled = A.roster.filter((c) => mb.has(c.id) && mb.get(c.id).level !== c.level).map((c) => ({ id: c.id, from: c.level, to: mb.get(c.id).level }));
	if (added.length || removed.length || leveled.length) out.roster = { added, removed, leveled };
	return out;
}
