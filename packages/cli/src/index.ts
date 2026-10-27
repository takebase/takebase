import { inviteCommand, roleCommand, userCommand } from "./commands/administration.ts";
import { collectionCommand } from "./commands/collection.ts";
import { createCommand } from "./commands/create.ts";
import { buildCommand, deployCommand } from "./commands/deploy.ts";
import { devCommand } from "./commands/dev.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { tenantCommand } from "./commands/tenant.ts";
import { findCommandGroup } from "./config.ts";
import { CliError, type CliIo } from "./errors.ts";
import { mainHelp, version } from "./help.ts";

export type { CommandGroup, CommandStatus } from "./config.ts";
export { commandGroups } from "./config.ts";
export type { CliIo } from "./errors.ts";
export { CliError } from "./errors.ts";

const commands: Record<string, (args: string[], io: CliIo) => number | Promise<number>> = {
	init: initCommand,
	create: createCommand,
	collection: collectionCommand,
	migrate: migrateCommand,
	doctor: doctorCommand,
	tenant: tenantCommand,
	dev: devCommand,
	build: buildCommand,
	deploy: deployCommand,
	user: userCommand,
	role: roleCommand,
	invite: inviteCommand,
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

const report = (io: CliIo, error: unknown) => {
	if (error instanceof CliError) {
		io.stderr(`Error: ${error.message}\n${error.hint === undefined ? "" : `${error.hint}\n`}`);
		return error.exitCode;
	}
	io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
};

// Runs the CLI and returns its exit code; never calls process.exit, so it can run in-process.
// Commands that talk to services (tenant, deploy, dev) are asynchronous and return a promise.
export const run = (argv: string[], io: CliIo): number | Promise<number> => {
	try {
		const code = dispatch(argv, io);
		return typeof code === "number" ? code : code.catch((error: unknown) => report(io, error));
	} catch (error) {
		return report(io, error);
	}
};
