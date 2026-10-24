// Parses JSON with comments and trailing commas, as Wrangler accepts in
// wrangler.jsonc. Kept here because the CLI has no runtime dependencies.

// Index of the next character that is neither whitespace nor inside a comment.
const skipInsignificant = (text: string, start: number) => {
	let i = start;
	while (i < text.length) {
		if (/\s/.test(text[i] ?? "")) i++;
		else if (text.startsWith("//", i)) {
			const end = text.indexOf("\n", i);
			i = end === -1 ? text.length : end + 1;
		} else if (text.startsWith("/*", i)) {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else break;
	}
	return i;
};

export const parseJsonc = (text: string): unknown => {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
			out += text.slice(start, ++i);
			continue;
		}
		const next = skipInsignificant(text, i);
		if (next !== i) {
			out += " ";
			i = next;
			continue;
		}
		// A comma followed only by a closing bracket is a trailing comma.
		if (char === "," && "}]".includes(text[skipInsignificant(text, i + 1)] ?? "")) {
			i++;
			continue;
		}
		out += char;
		i++;
	}
	return JSON.parse(out);
};
