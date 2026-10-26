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

// Edits that keep a JSONC file's comments and layout: the CLI adds a property
// to one object (a tenant, a Wrangler environment) and never rewrites the rest.

const stringEnd = (text: string, start: number) => {
	let i = start + 1;
	while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
	return i + 1;
};

// Index just past the value starting at (or after insignificant text from) `start`.
const valueEnd = (text: string, start: number): number => {
	const i = skipInsignificant(text, start);
	const char = text[i];
	if (char === '"') return stringEnd(text, i);
	if (char === "{" || char === "[") {
		const close = char === "{" ? "}" : "]";
		let j = i + 1;
		for (;;) {
			j = skipInsignificant(text, j);
			if (j >= text.length) throw new Error("Unterminated object or array");
			if (text[j] === close) return j + 1;
			if (char === "{") j = skipInsignificant(text, stringEnd(text, j)) + 1;
			j = skipInsignificant(text, valueEnd(text, j));
			if (text[j] === ",") j++;
		}
	}
	let j = i;
	while (j < text.length && !/[\s,\]}/]/.test(text[j] ?? "")) j++;
	return j;
};

// The object at `path` (keys from the root): where it opens, and where its last
// member's value ends (undefined when it has no members).
const locateObject = (text: string, path: string[]) => {
	let open = skipInsignificant(text, 0);
	if (text[open] !== "{") return undefined;
	const members = (start: number) => {
		const found: { key: string; value: number; end: number }[] = [];
		let j = start + 1;
		for (;;) {
			j = skipInsignificant(text, j);
			if (text[j] === "}") return found;
			const keyEnd = stringEnd(text, j);
			const key = JSON.parse(text.slice(j, keyEnd)) as string;
			const value = skipInsignificant(text, skipInsignificant(text, keyEnd) + 1);
			const end = valueEnd(text, value);
			found.push({ key, value, end });
			j = skipInsignificant(text, end);
			if (text[j] === ",") j++;
		}
	};
	for (const key of path) {
		const member = members(open).find((candidate) => candidate.key === key);
		if (!member || text[member.value] !== "{") return undefined;
		open = member.value;
	}
	return { open, lastEnd: members(open).at(-1)?.end };
};

// Adds `"key": value` as the last member of the object at `path`, indented with
// tabs at that depth. Throws when the object is missing or already has `key`.
export const insertJsoncProperty = (text: string, path: string[], key: string, value: unknown) => {
	const target = locateObject(text, path);
	if (!target) throw new Error(`No object at ${path.join(".") || "the root"}`);
	const existing = parseJsonc(text) as Record<string, unknown>;
	const object = path.reduce<Record<string, unknown>>((node, part) => node[part] as Record<string, unknown>, existing);
	if (key in object) throw new Error(`${[...path, key].join(".")} already exists`);
	const indent = "\t".repeat(path.length + 1);
	const body = JSON.stringify(value, null, "\t").replaceAll("\n", `\n${indent}`);
	const member = `\n${indent}${JSON.stringify(key)}: ${body}`;
	if (target.lastEnd === undefined) {
		return `${text.slice(0, target.open + 1)}${member}\n${"\t".repeat(path.length)}${text.slice(target.open + 1).trimStart()}`;
	}
	const after = skipInsignificant(text, target.lastEnd);
	const insertAt = text[after] === "," ? after + 1 : target.lastEnd;
	const comma = text[after] === "," ? "" : ",";
	return `${text.slice(0, insertAt)}${comma}${member}${text.slice(insertAt)}`;
};
