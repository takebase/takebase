import { collectionCommand } from "./commands/collection.ts";
import { createCommand } from "./commands/create.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { findCommandGroup } from "./config.ts";
import { CliError, type CliIo } from "./errors.ts";
import { mainHelp, version } from "./help.ts";

export type { CommandGroup, CommandStatus } from "./config.ts";
export { commandGroups } from "./config.ts";
export type { CliIo } from "./errors.ts";
export { CliError } from "./errors.ts";

const commands: Record<string, (args: string[], io: CliIo) => number> = {
	init: initCommand,
	create: createCommand,
	collection: collectionCommand,
	migrate: migrateCommand,
};

const dispatch = (argv: string[], io: CliIo) => {
	const [first, ...rest] = argv;
	if (first === undefined || first === "-h" || first === "--help" || first === "help") {
		io.stdout(mainHelp());
		return 0;
	}
	if (first === "-v" || first === "--version") {
		io.stdout(`${version}\n`);
		return 0;
	}
	const command = commands[first];
	if (command) return command(rest, io);
	if (findCommandGroup(first)?.status === "planned") {
		throw new CliError(`\`takebase ${first}\` is planned but not implemented yet`, {
			hint: "Run `takebase --help` to see the commands this version supports.",
		});
	}
	throw new CliError(`Unknown command or option "${first}"`, {
		usage: true,
		hint: "Run `takebase --help` to list commands.",
	});
};

// Runs the CLI and returns its exit code; never calls process.exit, so it can run in-process.
export const run = (argv: string[], io: CliIo): number => {
	try {
		return dispatch(argv, io);
	} catch (error) {
		if (error instanceof CliError) {
			io.stderr(`Error: ${error.message}\n${error.hint === undefined ? "" : `${error.hint}\n`}`);
			return error.exitCode;
		}
		io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
};
