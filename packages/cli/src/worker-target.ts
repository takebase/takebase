import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { parseJsonc } from "./jsonc.ts";

// The local D1 database a command acts on, resolved from the Worker's own
// wrangler.jsonc exactly as Wrangler resolves it: tenant or global is simply
// which Worker you point at, and --env selects a Wrangler environment.
export type WorkerTarget = {
	dir: string;
	env: string | undefined;
	binding: string;
	migrationsDir: string;
	migrationsTable: string;
	persistTo: string | undefined;
};

export type TargetOptions = {
	worker?: string;
	env?: string;
	database?: string;
	"persist-to"?: string;
	remote?: boolean;
};

export const targetOptions = {
	worker: { type: "string" },
	env: { type: "string" },
	database: { type: "string" },
	"persist-to": { type: "string" },
	remote: { type: "boolean" },
} as const;

export const targetOptionsHelp = `Target:
  --worker <dir>       Worker directory with wrangler.jsonc (default: the current directory)
  --env <name>         Wrangler environment, e.g. tenant-a
  --database <binding> D1 binding (default: the Worker's only D1 database)
  --persist-to <dir>   Local D1 state directory (default: Wrangler's .wrangler/state)
`;

type D1Config = {
	binding?: unknown;
	migrations_dir?: unknown;
	migrations_table?: unknown;
	migrations_pattern?: unknown;
};
type WranglerConfig = { d1_databases?: D1Config[]; env?: Record<string, { d1_databases?: D1Config[] }> };

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const resolveWorkerDir = (cwd: string, worker: string | undefined) => {
	const dir = resolve(cwd, worker ?? ".");
	if (!existsSync(join(dir, "wrangler.jsonc")) && !existsSync(join(dir, "wrangler.json"))) {
		throw new CliError(`No wrangler.jsonc in ${dir}`, {
			hint: "Run the command from a Worker directory or pass --worker <dir>.",
		});
	}
	return dir;
};

const readWranglerConfig = (dir: string) => {
	const file = existsSync(join(dir, "wrangler.jsonc")) ? "wrangler.jsonc" : "wrangler.json";
	try {
		return parseJsonc(readFileSync(join(dir, file), "utf8")) as WranglerConfig;
	} catch (error) {
		throw new CliError(`Cannot read ${join(dir, file)}: ${error instanceof Error ? error.message : String(error)}`);
	}
};

export const resolveTarget = (cwd: string, options: TargetOptions): WorkerTarget => {
	if (options.remote === true) {
		throw new CliError("Remote migrations are not supported by this command", {
			hint: "This version only targets local D1. Applying to a remote database needs a separately authorized release step.",
		});
	}
	const dir = resolveWorkerDir(cwd, options.worker);
	const config = readWranglerConfig(dir);
	let databases = config.d1_databases ?? [];
	if (options.env !== undefined) {
		const environment = config.env?.[options.env];
		if (!environment) throw new CliError(`Wrangler environment "${options.env}" is not defined in ${dir}`);
		// d1_databases is not inherited by Wrangler environments.
		databases = environment.d1_databases ?? [];
	}
	const where = options.env === undefined ? "" : ` in environment "${options.env}"`;
	const bindings = databases.map((database) => database.binding);
	const database =
		options.database === undefined
			? databases.length === 1
				? databases[0]
				: undefined
			: databases.find((candidate) => candidate.binding === options.database);
	if (!database) {
		throw new CliError(
			options.database === undefined
				? `Expected exactly one D1 database${where}, found ${databases.length}`
				: `No D1 binding "${options.database}"${where}`,
			{ hint: bindings.length > 0 ? `Bindings: ${bindings.join(", ")}. Pass --database <binding>.` : undefined },
		);
	}
	if (typeof database.binding !== "string") throw new CliError(`A D1 database${where} has no binding name`);
	if (database.migrations_pattern !== undefined) {
		throw new CliError(`D1 binding "${database.binding}" uses migrations_pattern, which takebase does not support yet`);
	}
	const migrationsDir = typeof database.migrations_dir === "string" ? database.migrations_dir : "migrations";
	const migrationsTable = typeof database.migrations_table === "string" ? database.migrations_table : "d1_migrations";
	if (!identifierPattern.test(migrationsTable)) throw new CliError(`Invalid migrations_table "${migrationsTable}"`);
	const persistTo = options["persist-to"];
	return {
		dir,
		env: options.env,
		binding: database.binding,
		migrationsDir: resolve(dir, migrationsDir),
		migrationsTable,
		persistTo: persistTo === undefined ? undefined : isAbsolute(persistTo) ? persistTo : resolve(cwd, persistTo),
	};
};

// Wrangler flags selecting the target's local database.
export const localDatabaseArgs = (target: WorkerTarget) => [
	target.binding,
	"--local",
	...(target.env === undefined ? [] : ["--env", target.env]),
	...(target.persistTo === undefined ? [] : ["--persist-to", target.persistTo]),
];

export type ToolResult = { status: number; stdout: string; output: string };

// Runs the Worker's own pinned tool from its node_modules, never a downloaded copy.
export const runTool = (dir: string, tool: "wrangler" | "drizzle-kit", args: string[]): ToolResult => {
	const bin = join(dir, "node_modules", ".bin", tool);
	if (!existsSync(bin)) {
		throw new CliError(`${tool} is not installed in ${dir}`, { hint: "Run `pnpm install` first." });
	}
	const result = spawnSync(bin, args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		timeout: 300_000,
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
	});
	if (result.error) throw new CliError(`Could not run ${tool}: ${result.error.message}`);
	const stdout = result.stdout ?? "";
	return { status: result.status ?? 1, stdout, output: `${stdout}${result.stderr ?? ""}` };
};

// The last lines of a tool's output, for error messages.
export const outputTail = (output: string, lines = 15) =>
	output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.slice(-lines)
		.map((line) => `  ${line}`)
		.join("\n");
