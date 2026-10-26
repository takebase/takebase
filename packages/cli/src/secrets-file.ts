import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

// An environment's untracked KEY=value secrets file (mode 600). Values are
// handed to tools through files or environment variables and never printed.

export type SecretsFile = {
	path: string;
	exists: boolean;
	// Permission bits, e.g. 0o600; undefined when the file is missing.
	mode: number | undefined;
	values: Record<string, string>;
};

export const readSecretsFile = (path: string): SecretsFile => {
	if (!existsSync(path)) return { path, exists: false, mode: undefined, values: {} };
	const values: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.startsWith("#") || !line.includes("=")) continue;
		const key = line.slice(0, line.indexOf("=")).trim();
		const value = line.slice(line.indexOf("=") + 1);
		if (key !== "" && value !== "") values[key] = value;
	}
	return { path, exists: true, mode: statSync(path).mode & 0o777, values };
};

// Adds one KEY=value line (provisioning's generated dispatcher passwords) and
// keeps the file at mode 600. Never replaces an existing key.
export const addSecret = (path: string, key: string, value: string) => {
	const current = readSecretsFile(path);
	if (key in current.values) throw new Error(`${key} is already set in ${path}`);
	const text = current.exists ? readFileSync(path, "utf8") : "";
	writeFileSync(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${key}=${value}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
};
