import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import { parseJsonc } from "../jsonc.ts";
import type { EnvironmentConfig } from "../project-config.ts";
import { readSecretsFile } from "../secrets-file.ts";
import { outputTail, runAnyTool, type ToolRunner } from "../worker-target.ts";

// What one Wrangler environment of a Worker resolves to, as Wrangler resolves
// it: `name` defaults to "<top-level name>-<env>"; vars, services and
// d1_databases are not inherited from the top level.

export type D1Binding = { binding: string; database_name: string; database_id: string; migrations_dir: string };
export type ServiceBinding = { binding: string; service: string; entrypoint: string | undefined };
export type WorkerEnvironment = {
	workerName: string;
	vars: Record<string, string>;
	services: ServiceBinding[];
	d1: D1Binding[];
};

type RawSection = { name?: unknown; vars?: unknown; services?: unknown; d1_databases?: unknown };
type RawConfig = RawSection & { env?: Record<string, RawSection> };

export const readWranglerFile = (dir: string): RawConfig => {
	const path = join(dir, "wrangler.jsonc");
	if (!existsSync(path)) throw new CliError(`No wrangler.jsonc in ${dir}`);
	return parseJsonc(readFileSync(path, "utf8")) as RawConfig;
};

const strings = (value: unknown) =>
	Object.fromEntries(
		Object.entries(typeof value === "object" && value !== null ? value : {}).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);

const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);

// Undefined when `env` is not defined in the Worker's wrangler.jsonc.
export const workerEnvironment = (dir: string, env: string | undefined): WorkerEnvironment | undefined => {
	const config = readWranglerFile(dir);
	const section = env === undefined ? config : config.env?.[env];
	if (!section) return undefined;
	const topName = typeof config.name === "string" ? config.name : "";
	return {
		workerName: typeof section.name === "string" ? section.name : env === undefined ? topName : `${topName}-${env}`,
		vars: strings(section.vars),
		services: list(section.services).map((service) => ({
			binding: String(service.binding),
			service: String(service.service),
			entrypoint: typeof service.entrypoint === "string" ? service.entrypoint : undefined,
		})),
		d1: list(section.d1_databases).map((database) => ({
			binding: String(database.binding),
			database_name: String(database.database_name),
			database_id: String(database.database_id),
			migrations_dir: String(database.migrations_dir ?? "migrations"),
		})),
	};
};

// Variables for every remote Wrangler call: CLOUDFLARE_ACCOUNT_ID pins the
// account, so a login with several accounts can never pick another one.
export const cloudflareEnv = (environment: EnvironmentConfig): Record<string, string> => {
	if (!environment.remote || environment.secretsFile === undefined) return {};
	const accountId = readSecretsFile(environment.secretsFile).values.CLOUDFLARE_ACCOUNT_ID;
	if (accountId === undefined) {
		throw new CliError(`CLOUDFLARE_ACCOUNT_ID is missing from ${environment.secretsFile}`, {
			hint: "Add CLOUDFLARE_ACCOUNT_ID=<account id> (from `wrangler whoami`) to that file.",
		});
	}
	return { CLOUDFLARE_ACCOUNT_ID: accountId };
};

// Runs one read-only SQL statement on a Worker's D1 database (local or remote).
export const queryD1 = (
	dir: string,
	env: string | undefined,
	environment: EnvironmentConfig,
	sql: string,
	run: ToolRunner = runAnyTool,
	// Local only: the D1 state directory (`takebase dev` keeps one per tenant).
	persistTo?: string,
): Record<string, unknown>[] => {
	const location = environment.remote ? "--remote" : "--local";
	const persist = !environment.remote && persistTo !== undefined ? ["--persist-to", persistTo] : [];
	const result = run(
		dir,
		"wrangler",
		[
			"d1",
			"execute",
			"DB",
			location,
			...(env === undefined ? [] : ["--env", env]),
			...persist,
			"--json",
			"--command",
			sql,
		],
		cloudflareEnv(environment),
	);
	const start = result.stdout.indexOf("[");
	let parsed: { results?: Record<string, unknown>[] }[] | undefined;
	try {
		parsed = start === -1 ? undefined : JSON.parse(result.stdout.slice(start));
	} catch {
		parsed = undefined;
	}
	if (result.status !== 0 || !parsed) {
		throw new CliError(
			`Could not query D1 (${location}${env === undefined ? "" : ` --env ${env}`}):\n${outputTail(result.output)}`,
		);
	}
	return parsed[0]?.results ?? [];
};

// "none" when Wrangler reports nothing to apply; otherwise the tail of its list.
export const remotePendingMigrations = (
	dir: string,
	env: string | undefined,
	environment: EnvironmentConfig,
	run: ToolRunner = runAnyTool,
) => {
	const result = run(
		dir,
		"wrangler",
		["d1", "migrations", "list", "DB", "--remote", ...(env === undefined ? [] : ["--env", env])],
		cloudflareEnv(environment),
	);
	if (result.status !== 0) throw new CliError(`wrangler d1 migrations list failed:\n${outputTail(result.output)}`);
	return result.output.includes("No migrations to apply") ? "none" : outputTail(result.output, 8);
};

// The deployed URL of a Worker on the account's workers.dev subdomain.
export const workerUrl = (environment: EnvironmentConfig, workerName: string) =>
	`https://${workerName}.${environment.workersSubdomain}.workers.dev`;

// Remote environments act only on names they own: every Cloudflare and
// Firebase resource name must start with the environment's namePrefix (the
// Cloudflare account is shared with other projects).
export const assertOwned = (environment: EnvironmentConfig, kind: string, name: string) => {
	const prefix = environment.namePrefix ?? "";
	if (!environment.remote || name.startsWith(prefix)) return;
	throw new CliError(
		`Refusing to touch ${kind} "${name}": environment "${environment.name}" owns only ${prefix}* names`,
		{
			hint: "Fix the name in wrangler.jsonc or takebase.jsonc; nothing was changed.",
		},
	);
};

// The JSON a tool printed, after any banner lines.
export const parseToolJson = (stdout: string): unknown => {
	const start = stdout.search(/[[{]/);
	if (start === -1) return undefined;
	try {
		return JSON.parse(stdout.slice(start));
	} catch {
		return undefined;
	}
};
