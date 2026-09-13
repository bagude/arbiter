// Call-argument elision: the file contents a model wrote sit in its own assistant
// messages for the rest of the run, re-sent on every request, even though the file is
// on disk and readable. After a couple of turns the `content` of a write (and the
// old/new text of an edit) is replaced in the projection by a stub naming the path
// and size. Pure; the session log is never edited.
//
// Evidence: on dw-explore-real workers, write arguments were 24–39% of the session's
// characters (docs/batch/working-context.md).

export const DEFAULTS = { afterTurns: 2, minChars: 1500 };
const FIELDS = { write: ["content"], edit: ["oldText", "newText", "old_string", "new_string"] };
const STUB = /^\[elided by the supervisor: /;

function stubFor(field, chars, path) {
	return `[elided by the supervisor: ${chars} chars of ${field}${path ? ` for ${path}` : ""}; the file is on disk — read it if you need it]`;
}

/**
 * elideCallArgs(messages, opts) → { messages, stats }
 * Never mutates the input; unchanged messages are returned by reference. Applying it
 * to its own output changes nothing.
 */
export function elideCallArgs(messages, opts = {}) {
	const { afterTurns, minChars } = { ...DEFAULTS, ...opts };
	const stats = { callsElided: 0, charsSaved: 0 };
	const assistantsAfter = new Array(messages.length).fill(0);
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		assistantsAfter[i] = count;
		if (messages[i]?.role === "assistant") count++;
	}
	const out = messages.map((m, i) => {
		if (m?.role !== "assistant" || !Array.isArray(m.content) || assistantsAfter[i] < afterTurns) return m;
		let changed = false;
		const content = m.content.map((c) => {
			if (c?.type !== "toolCall" || !FIELDS[c.name] || !c.arguments || typeof c.arguments !== "object") return c;
			let args = c.arguments;
			for (const field of FIELDS[c.name]) {
				const v = args[field];
				if (typeof v !== "string" || v.length < minChars || STUB.test(v)) continue;
				args = { ...args, [field]: stubFor(field, v.length, args.path) };
				stats.callsElided++;
				stats.charsSaved += v.length - args[field].length;
			}
			if (args === c.arguments) return c;
			changed = true;
			return { ...c, arguments: args };
		});
		return changed ? { ...m, content } : m;
	});
	return { messages: out, stats };
}
