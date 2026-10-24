import { relative } from "node:path";
import { parseCommandArgs } from "../args.ts";
import { CliError, type CliIo } from "../errors.ts";
import {
	applyMigrations,
	generateMigration,
	historyError,
	readHistory,
	readMigration,
} from "../services/migration-service.ts";
import { resolveTarget, targetOptions, targetOptionsHelp, type WorkerTarget } from "../worker-target.ts";

// Laravel's make:migration, migrate:status / migrate --pretend and migrate,
// over drizzle-kit (generation) and Wrangler (local D1 application).

const usage = "takebase migrate <generate|inspect|apply> [options]";

const help = `Generate, inspect and apply D1 migrations for one Worker's local database.

Usage: ${usage}

Commands:
  generate --name <name>  Generate SQL from the Worker's Drizzle schema (drizzle-kit generate)
  inspect [--sql]         List applied and pending migrations, check history, print pending SQL with --sql
  apply                   Check history, apply pending migrations locally (wrangler d1 migrations apply --local)

${targetOptionsHelp}
Only local databases are supported. Applied migrations are never rewritten or rolled back automatically.
`;

const options = {
	...targetOptions,
	name: { type: "string" },
	sql: { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

const migrationNamePattern = /^[a-z0-9_]{1,60}$/;

const describeTarget = (io: CliIo, target: WorkerTarget) => {
	const env = target.env === undefined ? "" : `, env ${target.env}`;
	return `${target.binding} (local${env}) in ${relative(io.cwd, target.dir) || "the current directory"}`;
};

const generate = (io: CliIo, target: WorkerTarget, name: string | undefined) => {
	if (name === undefined || !migrationNamePattern.test(name)) {
		throw new CliError("migrate generate needs --name with lowercase letters, digits and underscores", {
			usage: true,
			hint: "Example: takebase migrate generate --name create_claims",
		});
	}
	const created = generateMigration(target, name);
	if (created.length === 0) {
		io.stdout("No schema changes; nothing generated.\n");
		return 0;
	}
	const dir = relative(io.cwd, target.migrationsDir) || ".";
	io.stdout(
		`Generated:\n${created.map((file) => `  ${dir}/${file}`).join("\n")}\n\n` +
			"Review the SQL, then run `takebase migrate inspect --sql` and `takebase migrate apply`.\n",
	);
	return 0;
};

const inspect = (io: CliIo, target: WorkerTarget, sql: boolean) => {
	const history = readHistory(target);
	const rows = history.files.map((file) => `  ${history.applied.includes(file) ? "applied" : "pending"}  ${file}`);
	io.stdout(
		`Migrations for ${describeTarget(io, target)}\n${rows.length > 0 ? rows.join("\n") : "  (no migration files)"}\n` +
			`${history.applied.length} applied, ${history.pending.length} pending.\n`,
	);
	if (sql) {
		for (const file of history.pending) io.stdout(`\n-- ${file}\n${readMigration(target, file).trimEnd()}\n`);
	}
	if (history.problems.length > 0) throw historyError(target, history);
	return 0;
};

const apply = (io: CliIo, target: WorkerTarget) => {
	const { applied } = applyMigrations(target);
	io.stdout(
		applied.length === 0
			? `Nothing to migrate for ${describeTarget(io, target)}.\n`
			: `Applied to ${describeTarget(io, target)}:\n${applied.map((file) => `  ${file}`).join("\n")}\n`,
	);
	return 0;
};

export const migrateCommand = (args: string[], io: CliIo) => {
	const { values, positionals } = parseCommandArgs("migrate", args, options);
	const [subcommand, ...extra] = positionals;
	if (values.help === true) {
		io.stdout(help);
		return 0;
	}
	const usageError = (message: string) => new CliError(message, { usage: true, hint: `Usage: ${usage}` });
	if (subcommand === undefined) throw usageError("Missing migrate command");
	if (!["generate", "inspect", "apply"].includes(subcommand))
		throw usageError(`Unknown migrate command "${subcommand}"`);
	if (extra.length > 0) throw usageError(`Unexpected arguments: ${extra.join(" ")}`);
	if (values.name !== undefined && subcommand !== "generate") throw usageError("--name is only for migrate generate");
	if (values.sql !== undefined && subcommand !== "inspect") throw usageError("--sql is only for migrate inspect");
	const target = resolveTarget(io.cwd, values);
	if (subcommand === "generate") return generate(io, target, values.name);
	if (subcommand === "inspect") return inspect(io, target, values.sql === true);
	return apply(io, target);
};
