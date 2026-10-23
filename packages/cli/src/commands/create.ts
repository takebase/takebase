import type { CliIo } from "../errors.ts";
import { runStarterCommand, starterOptionsHelp } from "./starter-command.ts";

const usage = "takebase create <dir> [--name <name>] [--force]";

export const createCommand = (args: string[], io: CliIo) =>
	runStarterCommand(
		{
			command: "create",
			usage,
			defaultDir: undefined,
			help: `Generate a Takebase starter in a new directory.\n\nUsage: ${usage}\n\n${starterOptionsHelp}`,
		},
		args,
		io,
	);
