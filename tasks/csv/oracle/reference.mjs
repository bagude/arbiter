// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function checkDelimiter(delimiter) {
	if (typeof delimiter !== "string" || delimiter.length !== 1) {
		throw new RangeError(`invalid delimiter: ${JSON.stringify(delimiter)}`);
	}
}

// Scans text into records of {fields: string[], line: number}, line being the
// 1-based line on which that record starts.
function tokenize(text, delimiter) {
	const records = [];
	if (text === "") return records;

	const n = text.length;
	let i = 0;
	let line = 1;
	let recordStartLine = 1;
	let field = "";
	let record = [];
	let inQuotes = false;
	let afterQuote = false;
	let quoteStartLine = 0;
	let touched = false;

	const flushField = () => {
		record.push(field);
		field = "";
		afterQuote = false;
	};
	const flushRecord = () => {
		flushField();
		records.push({ fields: record, line: recordStartLine });
		record = [];
		touched = false;
	};

	while (i < n) {
		touched = true;
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				afterQuote = true;
				i++;
				continue;
			}
			if (c === "\n") line++;
			field += c;
			i++;
			continue;
		}

		if (afterQuote) {
			if (c === delimiter) {
				flushField();
				i++;
				continue;
			}
			if (c === "\r" && text[i + 1] === "\n") {
				line++;
				flushRecord();
				recordStartLine = line;
				i += 2;
				continue;
			}
			if (c === "\n") {
				line++;
				flushRecord();
				recordStartLine = line;
				i++;
				continue;
			}
			throw new SyntaxError(`unexpected character after quote at line ${line}`);
		}

		if (c === '"' && field === "") {
			inQuotes = true;
			quoteStartLine = line;
			i++;
			continue;
		}
		if (c === delimiter) {
			flushField();
			i++;
			continue;
		}
		if (c === "\r" && text[i + 1] === "\n") {
			line++;
			flushRecord();
			recordStartLine = line;
			i += 2;
			continue;
		}
		if (c === "\n") {
			line++;
			flushRecord();
			recordStartLine = line;
			i++;
			continue;
		}
		field += c;
		i++;
	}

	if (inQuotes) throw new SyntaxError(`unterminated quote at line ${quoteStartLine}`);
	if (touched) {
		flushField();
		records.push({ fields: record, line: recordStartLine });
	}
	return records;
}

export function parseCSV(text, { delimiter = ",", header = false } = {}) {
	if (typeof text !== "string") throw new TypeError(`text must be a string, got ${typeof text}`);
	checkDelimiter(delimiter);

	const records = tokenize(text, delimiter);
	if (!header) return records.map((r) => r.fields);

	if (records.length === 0) return [];
	const names = records[0].fields;
	const seen = new Set();
	for (const name of names) {
		if (seen.has(name)) throw new SyntaxError(`duplicate header: ${JSON.stringify(name)}`);
		seen.add(name);
	}

	const out = [];
	for (let r = 1; r < records.length; r++) {
		const { fields, line } = records[r];
		if (fields.length > names.length) throw new SyntaxError(`too many fields at line ${line}`);
		const obj = {};
		for (let k = 0; k < names.length; k++) obj[names[k]] = fields[k] ?? "";
		out.push(obj);
	}
	return out;
}

function formatCell(cell, delimiter) {
	const s = cell === null || cell === undefined ? "" : String(cell);
	const needsQuote =
		s.includes(delimiter) ||
		s.includes('"') ||
		s.includes("\n") ||
		s.includes("\r") ||
		(s.length > 0 && (s[0] === " " || s[s.length - 1] === " "));
	return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows, { delimiter = "," } = {}) {
	if (!Array.isArray(rows)) throw new TypeError(`rows must be an array, got ${typeof rows}`);
	checkDelimiter(delimiter);

	const lines = rows.map((row) => {
		if (!Array.isArray(row)) throw new TypeError("each row must be an array");
		return row.map((cell) => formatCell(cell, delimiter)).join(delimiter);
	});
	return lines.join("\n");
}
