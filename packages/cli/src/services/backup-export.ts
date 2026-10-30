import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../errors.ts";
import { version } from "../help.ts";
import type { EnvironmentConfig, ProjectConfig, TenantConfig } from "../project-config.ts";
import { outputTail } from "../worker-target.ts";
import { type BackupScope, sha256 } from "./backup-manifest.ts";
import { type BackupStore, type CapturedPart, commitBackup, replayD1, verifyBackup } from "./backups.ts";
import { globalEndpoint, tenantEndpoint } from "./endpoints.ts";
import { assertOwned, cloudflareEnv, type WorkerEnvironment, workerEnvironment } from "./environment.ts";
import { wranglerStore } from "./key-lifecycle.ts";
import { getUrl, type RemoteDeps } from "./remote-workers.ts";
import { parseEnvelope } from "./secret-envelopes.ts";

// `takebase backup create` (SEGU-225): exports through Wrangler, run by the
// operator's own login and pinned to the environment's account, into the
// environment's private R2 bucket. Each part is captured at its own time: a
// D1 export, another D1 export and a KV listing are never one snapshot.
//
// What a backup holds: each selected D1 database as SQL (with its
// d1_migrations history), each tenant's SECRETS namespace as ciphertext
// envelopes with their metadata, and configuration metadata. Never a data key,
// the secrets or keys file, an escrow, a password, an API key or an account ID.

const encoder = new TextEncoder();

export const withTemp = <T>(use: (dir: string) => T) => {
	const dir = mkdtempSync(join(tmpdir(), "takebase-backup-"));
	try {
		return use(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const wrangler = (deps: RemoteDeps, dir: string, environment: EnvironmentConfig, args: string[]) =>
	deps.run(dir, "wrangler", args, cloudflareEnv(environment));

// The environment's backup bucket in R2: local (persisted in the global
// Worker's own .wrangler/state, where `takebase dev` serves it to the Worker's
// BACKUPS binding) or remote. Objects pass through mode-600 temporary files.
export const r2Store = (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig): BackupStore => {
	const bucket = backupBucketOf(environment);
	const location = environment.remote
		? ["--remote"]
		: ["--local", "--persist-to", join(project.workers.global, ".wrangler", "state")];
	const dir = project.workers.global;
	return {
		get: async (key) =>
			withTemp((temp) => {
				const file = join(temp, "object");
				const result = wrangler(deps, dir, environment, [
					"r2",
					"object",
					"get",
					`${bucket}/${key}`,
					"--file",
					file,
					...location,
				]);
				if (result.status !== 0) {
					if (result.output.includes("The specified key does not exist")) return null;
					throw new CliError(`wrangler r2 object get ${key} failed:\n${outputTail(result.output)}`);
				}
				return new Uint8Array(readFileSync(file));
			}),
		put: async (key, bytes, contentType) =>
			withTemp((temp) => {
				const file = join(temp, "object");
				writeFileSync(file, bytes, { mode: 0o600 });
				const result = wrangler(deps, dir, environment, [
					"r2",
					"object",
					"put",
					`${bucket}/${key}`,
					"--file",
					file,
					"--content-type",
					contentType,
					...location,
				]);
				if (result.status !== 0) {
					throw new CliError(`wrangler r2 object put ${key} failed:\n${outputTail(result.output)}`);
				}
			}),
		delete: async (key) => {
			const result = wrangler(deps, dir, environment, ["r2", "object", "delete", `${bucket}/${key}`, ...location]);
			if (result.status !== 0 && !result.output.includes("The specified key does not exist")) {
				throw new CliError(`wrangler r2 object delete ${key} failed:\n${outputTail(result.output)}`);
			}
		},
	};
};

export const backupBucketOf = (environment: EnvironmentConfig) => {
	const bucket = environment.backupBucket;
	if (bucket === undefined) {
		throw new CliError(`Environment "${environment.name}" has no backupBucket`, {
			hint: "Add backupBucket to it in takebase.jsonc.",
		});
	}
	assertOwned(environment, "R2 bucket", bucket);
	return bucket;
};

// `takebase backup init`: creates the remote bucket, private (no public access
// or r2.dev URL is ever enabled), without touching wrangler.jsonc.
export const createBucket = (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig) => {
	const bucket = backupBucketOf(environment);
	const result = wrangler(deps, project.workers.global, environment, [
		"r2",
		"bucket",
		"create",
		bucket,
		"--update-config=false",
	]);
	if (result.status !== 0 && !result.output.includes("already exists")) {
		throw new CliError(`wrangler r2 bucket create ${bucket} failed:\n${outputTail(result.output)}`, {
			hint: "If R2 is not enabled on the account yet, enable it in the Cloudflare dashboard first.",
		});
	}
	return { bucket, created: result.status === 0 };
};

export const worker = (dir: string, env: string | undefined, label: string): WorkerEnvironment => {
	const found = workerEnvironment(dir, env);
	const database = found?.d1[0];
	if (!found || database === undefined) throw new CliError(`No D1 database for ${label} in ${dir}/wrangler.jsonc`);
	return found;
};

// The repository's migration files for a Worker's database, with checksums.
export const migrationFiles = (dir: string, config: WorkerEnvironment) => {
	const migrationsDir = resolve(dir, config.d1[0]?.migrations_dir ?? "migrations");
	if (!existsSync(migrationsDir)) return [];
	return readdirSync(migrationsDir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, sha256: sha256(readFileSync(join(migrationsDir, name))) }));
};

// `wrangler d1 export` of one database. Locally, Wrangler reads only
// `<config dir>/.wrangler/state`, so the Worker's state (e.g. state-<tenant>)
// is copied with its configuration into a temporary directory first.
const exportD1 = (
	deps: RemoteDeps,
	environment: EnvironmentConfig,
	dir: string,
	env: string | undefined,
	binding: string,
	localState: string,
) =>
	withTemp((temp) => {
		const output = join(temp, "export.sql");
		const scope = env === undefined ? [] : ["--env", env];
		let config: string[] = [];
		if (!environment.remote) {
			const d1 = join(localState, "v3", "d1");
			if (!existsSync(d1)) {
				throw new CliError(`No local D1 state in ${localState}`, {
					hint: "Start the stack once with `pnpm dev:stack`.",
				});
			}
			cpSync(d1, join(temp, ".wrangler", "state", "v3", "d1"), { recursive: true });
			cpSync(join(dir, "wrangler.jsonc"), join(temp, "wrangler.jsonc"));
			config = ["-c", join(temp, "wrangler.jsonc")];
		}
		const result = wrangler(deps, dir, environment, [
			"d1",
			"export",
			binding,
			environment.remote ? "--remote" : "--local",
			...scope,
			...config,
			"--output",
			output,
		]);
		if (result.status !== 0 || !existsSync(output)) {
			throw new CliError(
				`wrangler d1 export ${binding}${env === undefined ? "" : ` (${env})`} failed:\n${outputTail(result.output)}`,
			);
		}
		return new Uint8Array(readFileSync(output));
	});

// The current export of a source database, read only: "global" or a tenant id.
export const exportD1Of = (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	target: string,
) => {
	const tenant = environment.tenants.find(({ id }) => id === target);
	if (target !== "global" && tenant === undefined) throw new CliError(`Unknown tenant "${target}"`);
	const dir = tenant === undefined ? project.workers.global : project.workers.tenant;
	const env = tenant === undefined ? environment.globalEnv : tenant.env;
	const state = join(dir, ".wrangler", tenant === undefined ? "state" : `state-${tenant.id}`);
	const binding = (worker(dir, env, target).d1[0] as { binding: string }).binding;
	return new TextDecoder().decode(exportD1(deps, environment, dir, env, binding, state));
};

const d1Part = (
	deps: RemoteDeps,
	environment: EnvironmentConfig,
	dir: string,
	env: string | undefined,
	target: string,
	file: string,
	localState: string,
): CapturedPart => {
	const config = worker(dir, env, target);
	const database = config.d1[0] as { binding: string; database_name: string };
	const capturedAt = new Date().toISOString();
	const bytes = exportD1(deps, environment, dir, env, database.binding, localState);
	const files = new Map(migrationFiles(dir, config).map((migration) => [migration.name, migration.sha256]));
	const applied = replayD1(new TextDecoder().decode(bytes));
	return {
		kind: "d1",
		target,
		database: database.database_name,
		capturedAt,
		schemaVersion: applied.at(-1) ?? null,
		migrations: applied.map((name) => ({ name, sha256: files.get(name) ?? null })),
		file,
		bytes,
	};
};

// The tenant's SECRETS namespace as JSON lines {name, value, metadata}. Every
// value must be a ciphertext envelope: anything else stops the backup.
const kvPart = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
): Promise<CapturedPart> => {
	const store = wranglerStore(deps, project, environment, tenant);
	const capturedAt = new Date().toISOString();
	const lines: string[] = [];
	const versions = new Set<number>();
	for (const { name, metadata } of await store.entries()) {
		const value = await store.get(name);
		if (value === null) {
			throw new CliError(`KV key ${name} of tenant ${tenant.id} was listed but could not be read`, {
				hint: "Remote KV is eventually consistent: run the backup again in a minute. Nothing was listed.",
			});
		}
		try {
			versions.add(parseEnvelope(value).keyVersion);
		} catch {
			throw new CliError(`KV key ${name} of tenant ${tenant.id} is not a ciphertext envelope; it was not backed up`);
		}
		lines.push(JSON.stringify({ name, value, metadata }));
	}
	return {
		kind: "kv",
		target: `tenant:${tenant.id}`,
		binding: "SECRETS",
		capturedAt,
		count: lines.length,
		keyVersions: [...versions].sort((a, b) => a - b),
		file: `tenants/${tenant.id}/kv-secrets.jsonl`,
		bytes: encoder.encode(lines.map((line) => `${line}\n`).join("")),
	};
};

// Only these vars are recorded; the others may hold settings that are not ours to copy.
const recordedVars = ["TENANT_ID", "TAKEBASE_ENV", "DATA_KEY_VERSION", "FIREBASE_DATABASE_NAMESPACE"];

const describeWorker = (config: WorkerEnvironment) => ({
	workerName: config.workerName,
	vars: Object.fromEntries(
		recordedVars.flatMap((name) => (config.vars[name] === undefined ? [] : [[name, config.vars[name]]])),
	),
	d1: config.d1.map(({ binding, database_name }) => ({ binding, database_name })),
	kv: config.kv.map(({ binding }) => binding),
	services: config.services.map(({ binding, service, entrypoint }) => ({ binding, service, entrypoint })),
});

// What a restore needs to know besides the data: environment and tenant
// declarations, Worker bindings, the data key versions in use, the
// repository's migrations and the CLI version. Never a secret or an ID.
const configPart = (project: ProjectConfig, environment: EnvironmentConfig): CapturedPart => {
	const global = worker(project.workers.global, environment.globalEnv, "the global Worker");
	const tenants = environment.tenants.map((tenant) => ({
		tenant,
		config: worker(project.workers.tenant, tenant.env, `tenant ${tenant.id}`),
	}));
	const metadata = {
		environment: {
			name: environment.name,
			remote: environment.remote,
			firebaseProject: environment.firebaseProject,
			namePrefix: environment.namePrefix ?? null,
			tenants: environment.tenants.map(({ id, name, env }) => ({ id, name, env })),
		},
		workers: {
			global: describeWorker(global),
			tenants: Object.fromEntries(tenants.map(({ tenant, config }) => [tenant.id, describeWorker(config)])),
		},
		migrations: {
			global: migrationFiles(project.workers.global, global),
			tenant: tenants[0] === undefined ? [] : migrationFiles(project.workers.tenant, tenants[0].config),
		},
		cliVersion: version,
	};
	return {
		kind: "config",
		target: "environment",
		capturedAt: new Date().toISOString(),
		file: "config.json",
		bytes: encoder.encode(`${JSON.stringify(metadata, null, "\t")}\n`),
	};
};

export type BackupSelection = { scope: BackupScope; tenantId?: string };

// Locally, the stack must be down: the copied SQLite files and KV are then quiescent.
export const refuseRunningStack = async (deps: RemoteDeps, project: ProjectConfig, environment: EnvironmentConfig) => {
	const urls = [
		globalEndpoint(project, environment).url,
		...environment.tenants.map(({ id }) => tenantEndpoint(project, environment, id).url),
	];
	for (const url of urls) {
		if ((await getUrl(deps, `${url}/health`)).status !== 0) {
			throw new CliError("The local stack is running", {
				hint: "Stop it with `pnpm dev:stack:stop` first, so the local databases are not changing. Nothing was written.",
			});
		}
	}
};

export const createBackup = async (
	deps: RemoteDeps,
	project: ProjectConfig,
	environment: EnvironmentConfig,
	selection: BackupSelection,
	now = new Date(),
) => {
	const store = r2Store(deps, project, environment);
	const tenants =
		selection.scope === "global"
			? []
			: selection.scope === "all"
				? environment.tenants
				: environment.tenants.filter((tenant) => tenant.id === selection.tenantId);
	if (selection.scope === "tenant" && tenants.length === 0) {
		throw new CliError(`Unknown tenant "${selection.tenantId}" in environment "${environment.name}"`);
	}
	if (!environment.remote) await refuseRunningStack(deps, project, environment);
	const parts: CapturedPart[] = [];
	if (selection.scope !== "tenant") {
		parts.push(
			d1Part(
				deps,
				environment,
				project.workers.global,
				environment.globalEnv,
				"global",
				"global/d1.sql",
				join(project.workers.global, ".wrangler", "state"),
			),
		);
	}
	for (const tenant of tenants) {
		parts.push(
			d1Part(
				deps,
				environment,
				project.workers.tenant,
				tenant.env,
				`tenant:${tenant.id}`,
				`tenants/${tenant.id}/d1.sql`,
				join(project.workers.tenant, ".wrangler", `state-${tenant.id}`),
			),
		);
		parts.push(await kvPart(deps, project, environment, tenant));
	}
	parts.push(configPart(project, environment));
	const manifest = await commitBackup(
		store,
		{
			created: now,
			environment: environment.name,
			scope: selection.scope,
			tenantId: selection.tenantId,
			cliVersion: version,
		},
		parts,
	);
	return { manifest, verification: await verifyBackup(store, manifest.backupId) };
};
