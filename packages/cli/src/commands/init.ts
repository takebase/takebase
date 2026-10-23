import type { CliIo } from "../errors.ts";
import { runStarterCommand, starterOptionsHelp } from "./starter-command.ts";

const usage = "takebase init [dir] [--name <name>] [--force]";

export const initCommand = (args: string[], io: CliIo) =>
	runStarterCommand(
		{
			command: "init",
			usage,
			defaultDir: ".",
			help: `Generate a Takebase starter in a directory (default: the current directory).\n\nUsage: ${usage}\n\n${starterOptionsHelp}`,
		},
		args,
		io,
	);
