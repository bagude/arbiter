// Reference for `raid-gear`: artifacts, equipment slots, set bonuses, geared stats.

export const SLOTS = ["weapon", "helmet", "shield", "gloves", "chest", "boots"];
export const FLAT_STATS = ["hp", "atk", "def", "spd"];
export const PCT_STATS = ["hp%", "atk%", "def%", "spd%"];
export const SETS = {
	swift: { pieces: 2, bonus: { stat: "spd%", value: 12 } },
	sturdy: { pieces: 2, bonus: { stat: "def%", value: 15 } },
	fierce: { pieces: 2, bonus: { stat: "atk%", value: 15 } },
	vital: { pieces: 2, bonus: { stat: "hp%", value: 15 } },
	relentless: { pieces: 4, bonus: { stat: "atk%", value: 30 } },
};
export const MAX_SUBS = 4;

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isStat = (s) => FLAT_STATS.includes(s) || PCT_STATS.includes(s);

function validateLine(l, at) {
	if (!isObj(l)) throw inv(`${at} must be an object`);
	if (!isStat(l.stat)) throw inv(`${at}.stat must be one of ${[...FLAT_STATS, ...PCT_STATS].join(", ")}`);
	if (!isInt(l.value) || l.value < 1) throw inv(`${at}.value must be an integer >= 1`);
	return { stat: l.stat, value: l.value };
}

export function validateArtifact(a) {
	if (!isObj(a)) throw inv("artifact must be an object");
	if (!isStr(a.id)) throw inv("artifact.id must be a non-empty string");
	if (!SLOTS.includes(a.slot)) throw inv(`artifact.slot must be one of ${SLOTS.join(", ")}`);
	if (!(a.set in SETS)) throw inv(`artifact.set must be one of ${Object.keys(SETS).join(", ")}`);
	const main = validateLine(a.main, "artifact.main");
	const subs = a.subs === undefined ? [] : a.subs;
	if (!Array.isArray(subs) || subs.length > MAX_SUBS) throw inv(`artifact.subs must be an array of at most ${MAX_SUBS}`);
	return { id: a.id, slot: a.slot, set: a.set, main, subs: subs.map((s, i) => validateLine(s, `artifact.subs[${i}]`)) };
}

function validateChampion(c) {
	if (!isObj(c) || !isObj(c.stats) || !isObj(c.base) || !isInt(c.level)) throw inv("champion must be a champion object (stats, base, level)");
	if (c.gear !== undefined && !isObj(c.gear)) throw inv("champion.gear must be an object");
	for (const k of Object.keys(c.gear ?? {})) if (!SLOTS.includes(k)) throw inv(`champion.gear has an unknown slot ${k}`);
}

const cloneGear = (gear) => Object.fromEntries(Object.entries(gear ?? {}).map(([k, a]) => [k, { ...a, main: { ...a.main }, subs: a.subs.map((s) => ({ ...s })) }]));
const cloneChampion = (c) => ({ ...c, base: { ...c.base }, stats: { ...c.stats }, skills: c.skills.map((s) => ({ ...s, effects: (s.effects ?? []).map((e) => ({ ...e })) })), ...(c.gear ? { gear: cloneGear(c.gear) } : {}) });

export function equip(champion, artifact) {
	validateChampion(champion);
	const a = validateArtifact(artifact);
	const gear = cloneGear(champion.gear);
	gear[a.slot] = a;
	return { ...cloneChampion(champion), gear };
}

export function unequip(champion, slot) {
	validateChampion(champion);
	if (!SLOTS.includes(slot)) throw inv(`slot must be one of ${SLOTS.join(", ")}`);
	if (!champion.gear || !(slot in champion.gear)) throw new RangeError(`nothing equipped: ${slot}`);
	const gear = cloneGear(champion.gear);
	delete gear[slot];
	return { ...cloneChampion(champion), gear };
}

export function gearStats(champion) {
	validateChampion(champion);
	const flat = { hp: 0, atk: 0, def: 0, spd: 0 };
	const pct = { hp: 0, atk: 0, def: 0, spd: 0 };
	const counts = {};
	const add = (line) => {
		if (line.stat.endsWith("%")) pct[line.stat.slice(0, -1)] += line.value;
		else flat[line.stat] += line.value;
	};
	for (const slot of SLOTS) {
		const a = champion.gear?.[slot];
		if (!a) continue;
		add(a.main);
		for (const s of a.subs ?? []) add(s);
		counts[a.set] = (counts[a.set] ?? 0) + 1;
	}
	const sets = {};
	for (const name of Object.keys(SETS)) {
		const n = Math.floor((counts[name] ?? 0) / SETS[name].pieces);
		if (n > 0) {
			sets[name] = n;
			const b = SETS[name].bonus;
			pct[b.stat.slice(0, -1)] += b.value * n;
		}
	}
	return { flat, pct, sets };
}

export function gearedStats(champion) {
	const g = gearStats(champion);
	const s = champion.stats;
	const geared = (k) => Math.floor(((s[k] + g.flat[k]) * (100 + g.pct[k])) / 100);
	return { hp: geared("hp"), atk: geared("atk"), def: geared("def"), spd: geared("spd"), crit: s.crit, critDmg: s.critDmg };
}

export function applyGear(champion) {
	const stats = gearedStats(champion);
	return { ...cloneChampion(champion), stats, hp: stats.hp };
}

export function sampleArtifacts() {
	return [
		{ id: "ember-blade", slot: "weapon", set: "fierce", main: { stat: "atk", value: 40 }, subs: [{ stat: "atk%", value: 5 }, { stat: "spd", value: 3 }] },
		{ id: "ember-gloves", slot: "gloves", set: "fierce", main: { stat: "atk%", value: 10 }, subs: [{ stat: "def", value: 20 }] },
		{ id: "wind-boots", slot: "boots", set: "swift", main: { stat: "spd", value: 12 }, subs: [] },
		{ id: "wind-helm", slot: "helmet", set: "swift", main: { stat: "hp", value: 300 }, subs: [{ stat: "hp%", value: 6 }, { stat: "def%", value: 4 }] },
		{ id: "oak-shield", slot: "shield", set: "sturdy", main: { stat: "def", value: 50 }, subs: [{ stat: "hp", value: 150 }] },
		{ id: "oak-chest", slot: "chest", set: "sturdy", main: { stat: "def%", value: 12 }, subs: [] },
	];
}

