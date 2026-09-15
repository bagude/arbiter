// Reference for `raid-timeline`: deterministic animation keyframes for a battle log,
// and the animated state at any time. Pure data — the page consumes it.
export const TURN_MS = 600;
export const LUNGE_MS = 150;
export const HIT_GAP_MS = 100;
export const FLASH_MS = 80;
export const LUNGE_X = 0.6;

const inv = (m) => new TypeError(`invalid argument: ${m}`);
const isInt = (v) => Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validateUnits(units) {
	if (!Array.isArray(units) || units.length === 0) throw inv("units must be a non-empty array");
	units.forEach((u, i) => {
		if (!isObj(u)) throw inv(`units[${i}] must be an object`);
		if (u.side !== 0 && u.side !== 1) throw inv(`units[${i}].side must be 0 or 1`);
		if (!isInt(u.hp) || u.hp < 0) throw inv(`units[${i}].hp must be an integer >= 0`);
	});
}

function validateEntry(entry, n) {
	if (!isObj(entry)) throw inv("entry must be an object");
	if (!isInt(entry.turn) || entry.turn < 1) throw inv("entry.turn must be an integer >= 1");
	if (!isInt(entry.actor) || entry.actor < 0 || entry.actor >= n) throw inv("entry.actor must index units");
	if (!isInt(entry.skill) || entry.skill < 0) throw inv("entry.skill must be an integer >= 0");
	if (!Array.isArray(entry.hits)) throw inv("entry.hits must be an array");
	entry.hits.forEach((h, i) => {
		if (!isObj(h) || !isInt(h.target) || h.target < 0 || h.target >= n) throw inv(`entry.hits[${i}].target must index units`);
		if (!isInt(h.damage) || h.damage < 0) throw inv(`entry.hits[${i}].damage must be an integer >= 0`);
		if (typeof h.crit !== "boolean" || typeof h.killed !== "boolean") throw inv(`entry.hits[${i}] needs boolean crit and killed`);
	});
}

/** Keyframes for one log entry, times relative to the turn start; `hp` values are absolute (computed from `units`). */
export function turnTimeline(entry, units) {
	validateUnits(units);
	validateEntry(entry, units.length);
	const hp = units.map((u) => u.hp);
	const frames = [];
	const actor = entry.actor;
	const dir = units[actor].side === 0 ? LUNGE_X : -LUNGE_X;
	frames.push({ t: 0, unit: actor, prop: "offsetX", value: dir });
	frames.push({ t: LUNGE_MS, unit: actor, prop: "offsetX", value: 0 });
	entry.hits.forEach((h, i) => {
		const at = LUNGE_MS + i * HIT_GAP_MS;
		hp[h.target] = Math.max(0, hp[h.target] - h.damage);
		frames.push({ t: at, unit: h.target, prop: "flash", value: h.crit ? "crit" : "hit" });
		frames.push({ t: at, unit: h.target, prop: "hp", value: hp[h.target] });
		frames.push({ t: at + FLASH_MS, unit: h.target, prop: "flash", value: null });
		if (h.killed) frames.push({ t: at + FLASH_MS, unit: h.target, prop: "visible", value: false });
	});
	const last = frames[frames.length - 1].t;
	return { frames, duration: Math.max(TURN_MS, last + HIT_GAP_MS), hp };
}

/** Absolute timeline for a whole battle: turns run back to back, each taking its own duration. */
export function battleTimeline(battle, initialUnits) {
	if (!isObj(battle) || !Array.isArray(battle.log)) throw inv("battle must have a log array");
	validateUnits(initialUnits);
	let units = initialUnits.map((u) => ({ side: u.side, hp: u.hp }));
	let offset = 0;
	const frames = [];
	const turns = [];
	for (const entry of battle.log) {
		const tl = turnTimeline(entry, units);
		turns.push({ turn: entry.turn, start: offset, duration: tl.duration });
		for (const f of tl.frames) frames.push({ ...f, t: offset + f.t, turn: entry.turn });
		units = units.map((u, i) => ({ ...u, hp: tl.hp[i] }));
		offset += tl.duration;
	}
	return { frames, turns, total: offset };
}

/** The animated state of every unit at time `t` (ms): the last frame at or before `t` wins per (unit, prop). */
export function stateAt(timeline, initialUnits, t) {
	if (!isObj(timeline) || !Array.isArray(timeline.frames)) throw inv("timeline must have a frames array");
	validateUnits(initialUnits);
	if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw inv("t must be a finite number >= 0");
	const state = initialUnits.map((u) => ({ offsetX: 0, flash: null, hp: u.hp, visible: u.hp > 0 }));
	for (const f of timeline.frames) {
		if (f.t > t) continue;
		state[f.unit][f.prop] = f.value;
	}
	return state;
}

/** Which turn is playing at time `t`, or null after the end. */
export function turnAt(timeline, t) {
	if (!isObj(timeline) || !Array.isArray(timeline.turns)) throw inv("timeline must have a turns array");
	if (typeof t !== "number" || !Number.isFinite(t) || t < 0) throw inv("t must be a finite number >= 0");
	for (const tr of timeline.turns) if (t >= tr.start && t < tr.start + tr.duration) return tr.turn;
	return null;
}
