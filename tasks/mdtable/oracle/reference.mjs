// Reference implementation — proves the oracle is self-consistent. Never shown to agents.

function cellText(v) {
	if (v === null || v === undefined) return "";
	const s = typeof v === "string" ? v : String(v);
	return s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function padCell(text, width, align) {
	const gap = width - text.length;
	if (gap <= 0) return text;
	if (align === "right") return " ".repeat(gap) + text;
	if (align === "center") {
		const left = Math.floor(gap / 2);
		const right = gap - left;
		return " ".repeat(left) + text + " ".repeat(right);
	}
	return text + " ".repeat(gap);
}

export function renderTable(header, rows, options = {}) {
	if (!Array.isArray(header)) throw new TypeError("header must be an array");
	if (header.length === 0) throw new RangeError("header must not be empty");
	const columnCount = header.length;

	const alignOpt = options ? options.align : undefined;
	const align = new Array(columnCount).fill("left");
	if (alignOpt !== undefined) {
		if (!Array.isArray(alignOpt)) throw new RangeError("invalid align: align must be an array");
		for (let j = 0; j < columnCount && j < alignOpt.length; j++) {
			const v = alignOpt[j];
			if (v !== "left" && v !== "right" && v !== "center") {
				throw new RangeError(`invalid align: ${JSON.stringify(v)} at column ${j}`);
			}
			align[j] = v;
		}
	}

	if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
	const rowCells = rows.map((row, i) => {
		if (!Array.isArray(row)) throw new TypeError(`row ${i} must be an array`);
		if (row.length > columnCount) {
			throw new RangeError(`row ${i} has too many cells (${row.length} > ${columnCount})`);
		}
		const cells = new Array(columnCount);
		for (let j = 0; j < columnCount; j++) cells[j] = cellText(j < row.length ? row[j] : undefined);
		return cells;
	});

	const headerCells = header.map((h) => cellText(h));

	const widths = new Array(columnCount);
	for (let j = 0; j < columnCount; j++) {
		let w = Math.max(3, headerCells[j].length);
		for (const cells of rowCells) w = Math.max(w, cells[j].length);
		widths[j] = w;
	}

	const buildRow = (cells) => "| " + cells.map((c, j) => padCell(c, widths[j], align[j])).join(" | ") + " |";

	const sepCells = widths.map((w, j) => {
		if (align[j] === "right") return "-".repeat(w - 1) + ":";
		if (align[j] === "center") return ":" + "-".repeat(w - 2) + ":";
		return "-".repeat(w);
	});

	const lines = [buildRow(headerCells), buildRow(sepCells), ...rowCells.map(buildRow)];
	return lines.join("\n");
}

function unescapeCell(s) {
	return s.replace(/\\\|/g, "|").replace(/<br>/g, "\n");
}

// Split one table line into raw cell tokens: split on unescaped "|", drop a
// leading/trailing empty token produced by an outer pipe, keep "\|" intact
// (unescaped later), trim each token, then unescape.
function tokenize(line) {
	const s = line.trim();
	const tokens = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && s[i + 1] === "|") {
			cur += "\\|";
			i++;
			continue;
		}
		if (c === "|") {
			tokens.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	tokens.push(cur);
	if (tokens.length > 1 && tokens[0] === "") tokens.shift();
	if (tokens.length > 1 && tokens[tokens.length - 1] === "") tokens.pop();
	return tokens.map((t) => unescapeCell(t.trim()));
}

export function parseTable(text) {
	if (typeof text !== "string") throw new SyntaxError("not a table: text must be a string");
	const lines = text.split("\n");
	if (lines.length < 2) throw new SyntaxError("not a table: fewer than 2 lines");

	const header = tokenize(lines[0]);
	const sepCells = tokenize(lines[1]);
	if (sepCells.length !== header.length) {
		throw new SyntaxError("not a table: separator row column count mismatch");
	}

	const align = sepCells.map((cell, j) => {
		if (/^-{3,}$/.test(cell)) return "left";
		if (/^-{2,}:$/.test(cell)) return "right";
		if (/^:-{1,}:$/.test(cell)) return "center";
		throw new SyntaxError(`not a table: invalid separator cell ${JSON.stringify(cell)} at column ${j}`);
	});

	const rows = lines.slice(2).map((line) => tokenize(line));
	return { header, rows, align };
}
