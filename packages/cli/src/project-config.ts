import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { insertJsoncProperty, parseJsonc } from "./jsonc.ts";

// takebase.jsonc at the project root: the deployment environments the
// tenant, deploy and doctor commands act on. Nothing in it is secret.

// `port` (local only) is where `takebase dev` serves the tenant Worker, so its
// registered URL is http://localhost:<port>.
export type TenantConfig = { id: string; name: string; env: string; port: number | undefined };

export type EnvironmentConfig = {
	name: string;
	remote: boolean;
	firebaseProject: string;
	// Remote only: every Cloudflare and Firebase resource name must start with it.
	namePrefix: string | undefined;
	workersSubdomain: string | undefined;
	// Wrangler environments of the global Worker and the app; undefined is the top level.
	globalEnv: string | undefined;
	appEnv: string | undefined;
	// Remote only: the Cloudflare Pages project the admin deploys to, served at
	// https://<adminProject>.pages.dev.
	adminProject: string | undefined;
	// Absolute path of the untracked secrets file (remote only).
	secretsFile: string | undefined;
	// Absolute path of the untracked, mode-600 file holding the tenants' data
	// keys (SEGU-223), as `DATA_KEY_V<n>_<TENANT>`. Defaults to the secrets file.
	keysFile: string | undefined;
	// Absolute path of the directory escrow (SEGU-224), which stands in for an
	// external key manager: every data key is deposited there before it is
	// installed, and `takebase secrets recover` restores a lost key from it.
	escrowDir: string | undefined;
	// The private R2 bucket `takebase backup` writes to (SEGU-225): locally a
	// Wrangler-persisted bucket, remotely one the environment owns by name.
	backupBucket: string | undefined;
	dispatcherPasswordKey: string | undefined;
	// Each tenant's dispatcher user, e.g. "takebase-dispatcher+{tenant}@example.test".
	dispatcherEmail: string;
	// Local only: the emulators' fixed dispatcher password (never a real one).
	dispatcherPassword: string | undefined;
	// Local only: where `takebase dev` serves the global Worker, the app and the admin.
	globalPort: number | undefined;
	appPort: number | undefined;
	adminPort: number | undefined;
	tenants: TenantConfig[];
};

export type ProjectConfig = {
	root: string;
	file: string;
	// `admin` is the optional static admin app (built to files, not a Worker).
	workers: { global: string; tenant: string; app: string; admin: string | undefined };
	environments: Record<string, EnvironmentConfig>;
};

export const configFileName = "takebase.jsonc";

// Tenant ids become Worker, database and Realtime Database names.
export const tenantIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

export const findProjectConfig = (cwd: string) => {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const file = join(dir, configFileName);
		if (existsSync(file)) return file;
		if (dirname(dir) === dir) return undefined;
	}
};

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export const loadProjectConfig = (cwd: string): ProjectConfig => {
	const file = findProjectConfig(cwd);
	if (file === undefined) {
		throw new CliError(`No ${configFileName} in ${resolve(cwd)} or its parents`, {
			hint: `Run the command inside a Takebase project, or add ${configFileName} at its root.`,
		});
	}
	let raw: unknown;
	try {
		raw = parseJsonc(readFileSync(file, "utf8"));
	} catch (error) {
		throw new CliError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const root = dirname(file);
	const invalid = (message: string) => new CliError(`${file}: ${message}`);

	const text = (value: unknown, path: string) => {
		if (typeof value !== "string" || value === "") throw invalid(`${path} must be a non-empty string`);
		return value;
	};
	const optionalText = (value: unknown, path: string) => (value === undefined ? undefined : text(value, path));
	const port = (value: unknown, path: string) => {
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
			throw invalid(`${path} must be a port number from 1024 to 65535`);
		}
		return value;
	};

	if (!isObject(raw) || !isObject(raw.workers) || !isObject(raw.environments)) {
		throw invalid("expected an object with workers and environments");
	}
	const workers = {
		global: resolve(root, text(raw.workers.global, "workers.global")),
		tenant: resolve(root, text(raw.workers.tenant, "workers.tenant")),
		app: resolve(root, text(raw.workers.app, "workers.app")),
		admin: raw.workers.admin === undefined ? undefined : resolve(root, text(raw.workers.admin, "workers.admin")),
	};

	const environments: Record<string, EnvironmentConfig> = {};
	for (const [name, value] of Object.entries(raw.environments)) {
		const path = `environments.${name}`;
		if (!isObject(value)) throw invalid(`${path} must be an object`);
		if (typeof value.remote !== "boolean") throw invalid(`${path}.remote must be true or false`);
		if (!isObject(value.tenants)) throw invalid(`${path}.tenants must be an object`);
		const tenants = Object.entries(value.tenants).map(([id, tenant]): TenantConfig => {
			if (!tenantIdPattern.test(id)) throw invalid(`${path}.tenants: "${id}" is not a valid tenant id`);
			if (!isObject(tenant)) throw invalid(`${path}.tenants.${id} must be an object`);
			return {
				id,
				name: text(tenant.name, `${path}.tenants.${id}.name`),
				env: text(tenant.env, `${path}.tenants.${id}.env`),
				port: tenant.port === undefined ? undefined : port(tenant.port, `${path}.tenants.${id}.port`),
			};
		});
		const secretsFile = optionalText(value.secretsFile, `${path}.secretsFile`);
		const keysFile = optionalText(value.keysFile, `${path}.keysFile`) ?? secretsFile;
		const escrowDir = optionalText(value.escrowDir, `${path}.escrowDir`);
		const environment: EnvironmentConfig = {
			name,
			remote: value.remote,
			firebaseProject: text(value.firebaseProject, `${path}.firebaseProject`),
			namePrefix: optionalText(value.namePrefix, `${path}.namePrefix`),
			workersSubdomain: optionalText(value.workersSubdomain, `${path}.workersSubdomain`),
			globalEnv: optionalText(value.globalEnv, `${path}.globalEnv`),
			appEnv: optionalText(value.appEnv, `${path}.appEnv`),
			adminProject: optionalText(value.adminProject, `${path}.adminProject`),
			secretsFile: secretsFile === undefined ? undefined : resolve(root, secretsFile),
			keysFile: keysFile === undefined ? undefined : resolve(root, keysFile),
			escrowDir: escrowDir === undefined ? undefined : resolve(root, escrowDir),
			backupBucket: optionalText(value.backupBucket, `${path}.backupBucket`),
			dispatcherPasswordKey: optionalText(value.dispatcherPasswordKey, `${path}.dispatcherPasswordKey`),
			dispatcherEmail: text(value.dispatcherEmail, `${path}.dispatcherEmail`),
			dispatcherPassword: optionalText(value.dispatcherPassword, `${path}.dispatcherPassword`),
			globalPort: value.globalPort === undefined ? undefined : port(value.globalPort, `${path}.globalPort`),
			appPort: value.appPort === undefined ? undefined : port(value.appPort, `${path}.appPort`),
			adminPort: value.adminPort === undefined ? undefined : port(value.adminPort, `${path}.adminPort`),
			tenants,
		};
		// A remote environment without these could act on resources it does not own.
		if (environment.remote) {
			for (const key of ["namePrefix", "workersSubdomain", "secretsFile", "dispatcherPasswordKey"] as const) {
				if (environment[key] === undefined) throw invalid(`${path}.${key} is required for a remote environment`);
			}
			if (environment.firebaseProject.startsWith("demo-")) {
				throw invalid(`${path}.firebaseProject cannot be a demo-* project in a remote environment`);
			}
			if (workers.admin !== undefined && environment.adminProject === undefined) {
				throw invalid(`${path}.adminProject is required for a remote environment with an admin`);
			}
			// Real passwords live only in the secrets file.
			if (environment.dispatcherPassword !== undefined) {
				throw invalid(`${path}.dispatcherPassword is for local environments only`);
			}
		} else {
			if (!environment.firebaseProject.startsWith("demo-")) {
				throw invalid(`${path}.firebaseProject must be a demo-* project in a local environment`);
			}
			if (environment.dispatcherPassword === undefined) {
				throw invalid(`${path}.dispatcherPassword is required for a local environment`);
			}
			for (const key of ["globalPort", "appPort"] as const) {
				if (environment[key] === undefined) throw invalid(`${path}.${key} is required for a local environment`);
			}
			if (environment.adminProject !== undefined) {
				throw invalid(`${path}.adminProject is for remote environments only`);
			}
			if (workers.admin !== undefined && environment.adminPort === undefined) {
				throw invalid(`${path}.adminPort is required for a local environment with an admin`);
			}
			const missing = tenants.find((tenant) => tenant.port === undefined);
			if (missing) throw invalid(`${path}.tenants.${missing.id}.port is required for a local environment`);
		}
		if (!environment.dispatcherEmail.includes("{tenant}")) {
			throw invalid(`${path}.dispatcherEmail must contain {tenant}`);
		}
		environments[name] = environment;
	}
	return { root, file, workers, environments };
};

export const resolveEnvironment = (project: ProjectConfig, name: string | undefined) => {
	const environment = project.environments[name ?? "local"];
	if (!environment) {
		throw new CliError(`Environment "${name}" is not defined in ${project.file}`, {
			hint: `Environments: ${Object.keys(project.environments).join(", ")}.`,
			usage: true,
		});
	}
	return environment;
};

// The secrets-file key holding a tenant's dispatcher password, e.g.
// STAGING_PASSWORD_DISPATCHER_TENANT_A for tenant-a.
export const dispatcherPasswordKey = (environment: EnvironmentConfig, tenantId: string) =>
	environment.dispatcherPasswordKey?.replace("{TENANT}", tenantId.toUpperCase().replaceAll("-", "_"));

export const dispatcherEmail = (environment: EnvironmentConfig, tenantId: string) =>
	environment.dispatcherEmail.replace("{tenant}", tenantId);

// Declares a tenant in takebase.jsonc, keeping the file's comments and layout.
export const declareTenant = (project: ProjectConfig, environment: EnvironmentConfig, tenant: TenantConfig) => {
	const entry: Record<string, unknown> = { name: tenant.name, env: tenant.env };
	if (tenant.port !== undefined) entry.port = tenant.port;
	const text = readFileSync(project.file, "utf8");
	writeFileSync(
		project.file,
		insertJsoncProperty(text, ["environments", environment.name, "tenants"], tenant.id, entry),
	);
	return loadProjectConfig(project.root);
};
