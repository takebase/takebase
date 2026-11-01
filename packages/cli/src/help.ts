import { readFileSync } from "node:fs";
import { commandGroups } from "./config.ts";

export const version = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	}
).version;

const width = Math.max(...commandGroups.map((group) => group.name.length)) + 2;
const rows = commandGroups.map((group) => `  ${group.name.padEnd(width)}${group.summary}`).join("\n");

export const mainHelp = () => `Takebase CLI ${version}

Usage: takebase <command> [options]

Commands:
${rows}

Options:
  -h, --help     Show this help
  -v, --version  Show the CLI version

Run \`takebase <command> --help\` for command options.
`;
