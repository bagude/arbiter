// Reference implementation — used only to prove the oracle is self-consistent. Never shown to agents.
const UNIT = { d: 86400, h: 3600, m: 60, s: 1 };

export function parseDuration(input) {
	if (typeof input !== "string") throw new RangeError("invalid duration: not a string");
	const s = input.trim();
	if (s === "") throw new RangeError("invalid duration: empty");
	if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
	const re = /(\d+(?:\.\d+)?)([dhms])/giy;
	let total = 0;
	let pos = 0;
	const seen = new Set();
	let m;
	while (pos < s.length) {
		while (s[pos] === " " || s[pos] === "\t") pos++;
		if (pos >= s.length) break;
		re.lastIndex = pos;
		m = re.exec(s);
		if (!m) throw new RangeError(`invalid duration: unexpected "${s.slice(pos)}"`);
		const unit = m[2].toLowerCase();
		if (seen.has(unit)) throw new RangeError(`invalid duration: repeated unit ${unit}`);
		seen.add(unit);
		total += Number(m[1]) * UNIT[unit];
		pos = re.lastIndex;
	}
	return Math.round(total);
}
