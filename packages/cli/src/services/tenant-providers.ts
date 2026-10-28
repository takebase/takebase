import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CliError } from "../errors.ts";
import { insertJsoncProperty } from "../jsonc.ts";
import { dispatcherEmail, type EnvironmentConfig, type ProjectConfig, type TenantConfig } from "../project-config.ts";
import { localDatabaseArgs, outputTail, resolveTarget, runTool } from "../worker-target.ts";
import { pagesUrl, queryD1, readWranglerFile, workerEnvironment, workerUrl } from "./environment.ts";
import { applyMigrations, readHistory } from "./migration-service.ts";
import type { BindingAdditions, TenantPlan, TenantProvider, WorkerBindings } from "./provisioning.ts";

// The rules renderer comes from the tenant Worker's own realtime adapter
// (`@takebase/adapter-firebase/rules`), resolved from the Worker's directory:
// the CLI itself depends on no framework package.
const loadRules = async (tenantDir: string) => {
	let path: string;
	try {
		path = realpathSync(createRequire(join(tenantDir, "package.json")).resolve("@takebase/adapter-firebase/rules"));
	} catch {
		throw new CliError(`The tenant Worker in ${tenantDir} does not depend on @takebase/adapter-firebase`, {
			hint: "Provisioning renders realtime rules with the Worker's own adapter; run `pnpm install` there.",
		});
	}
	const module = (await import(pathToFileURL(path).href)) as { databaseRules?: (uid: string) => unknown };
	if (typeof module.databaseRules !== "function") throw new CliError(`${path} does not export databaseRules`);
	return module.databaseRules;
};

const tenantMigrationsDir = (project: ProjectConfig) => {
	const top = readWranglerFile(project.workers.tenant).d1_databases;
	const dir = Array.isArray(top) ? (top[0] as { migrations_dir?: unknown })?.migrations_dir : undefined;
	if (typeof dir !== "string") throw new CliError("The tenant Worker's top-level D1 binding has no migrations_dir");
	return dir;
};

const localNamespace = (environment: EnvironmentConfig, tenant: TenantConfig) =>
	`${environment.firebaseProject}-${tenant.id}`;

export const localDatabaseId = (tenant: TenantConfig) => `local-takebase-${tenant.id}`;
export const localSecretsNamespaceId = (tenant: TenantConfig) => `local-takebase-${tenant.id}-secrets`;

// The data key version new secrets use; rotation (a later wave) raises it.
export const dataKeyVersion = "1";

// What one tenant of one environment must look like once provisioned.
export const tenantPlan = async (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
): Promise<TenantPlan> => {
	const databaseRules = await loadRules(project.workers.tenant);
	const global = workerEnvironment(project.workers.global, environment.globalEnv);
	if (!global) throw new CliError(`The global Worker has no Wrangler environment "${environment.globalEnv}"`);
	const migrations_dir = tenantMigrationsDir(project);
	const services = [{ binding: "GLOBAL", service: global.workerName, entrypoint: "MembershipEntrypoint" }];

	if (!environment.remote) {
		return {
			rules: databaseRules,
			bindings: (database_id, secretsNamespaceId) => ({
				vars: {
					TENANT_ID: tenant.id,
					FIREBASE_DATABASE_URL: "http://127.0.0.1:9000",
					FIREBASE_API_KEY: "demo-api-key",
					FIREBASE_DATABASE_NAMESPACE: localNamespace(environment, tenant),
					TAKEBASE_ENV: environment.name,
					DATA_KEY_VERSION: dataKeyVersion,
				},
				services,
				d1_databases: [{ binding: "DB", database_name: `takebase-${tenant.id}`, database_id, migrations_dir }],
				kv_namespaces: [{ binding: "SECRETS", id: secretsNamespaceId }],
			}),
			url: `http://localhost:${tenant.port}`,
		};
	}

	const name = `${environment.namePrefix}${tenant.id}`;
	const app = workerEnvironment(project.workers.app, environment.appEnv);
	if (!app) throw new CliError(`The app has no Wrangler environment "${environment.appEnv}"`);
	return {
		rules: databaseRules,
		bindings: (database_id, secretsNamespaceId) => ({
			name,
			vars: {
				TENANT_ID: tenant.id,
				FIREBASE_DATABASE_URL: `https://${name}.firebaseio.com`,
				// The app and, when there is one, the admin on Cloudflare Pages.
				CORS_ORIGINS: [
					workerUrl(environment, app.workerName),
					...(project.workers.admin !== undefined && environment.adminProject !== undefined
						? [pagesUrl(environment.adminProject)]
						: []),
				].join(","),
				TAKEBASE_ENV: environment.name,
				DATA_KEY_VERSION: dataKeyVersion,
			},
			services,
			d1_databases: [{ binding: "DB", database_name: name, database_id, migrations_dir }],
			kv_namespaces: [{ binding: "SECRETS", id: secretsNamespaceId }],
		}),
		url: workerUrl(environment, name),
	};
};

// The raw Wrangler environment, exactly as written, for comparison.
export const readBindings = (dir: string, env: string): WorkerBindings | null =>
	(readWranglerFile(dir).env?.[env] as WorkerBindings | undefined) ?? null;

export const writeBindings = (dir: string, env: string, bindings: WorkerBindings) => {
	const path = join(dir, "wrangler.jsonc");
	writeFileSync(path, insertJsoncProperty(readFileSync(path, "utf8"), ["env"], env, bindings));
};

// Inserts only missing members; insertJsoncProperty refuses any that exist.
export const extendBindings = (dir: string, env: string, { vars, kv_namespaces }: BindingAdditions) => {
	const path = join(dir, "wrangler.jsonc");
	let text = readFileSync(path, "utf8");
	for (const [key, value] of Object.entries(vars)) text = insertJsoncProperty(text, ["env", env, "vars"], key, value);
	if (kv_namespaces !== undefined) text = insertJsoncProperty(text, ["env", env], "kv_namespaces", kv_namespaces);
	writeFileSync(path, text);
};

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Emulators (inside `firebase emulators:exec`) and local D1. The tenant's
// local database lives in its own state directory, as with `pnpm dev:stack`.
export const localTenantProvider = (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
): TenantProvider => {
	const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
	const database = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
	if (!auth || !database) {
		throw new CliError("Local provisioning needs the Firebase emulators", {
			hint: "Run it inside `firebase emulators:exec --only auth,database --project demo-takebase '<command>'`.",
		});
	}
	const namespace = localNamespace(environment, tenant);
	const email = dispatcherEmail(environment, tenant.id);
	const password = environment.dispatcherPassword ?? "";
	const rtdb = (path: string, init: RequestInit = {}) =>
		fetch(`http://${database}/${path}.json?ns=${namespace}`, {
			...init,
			headers: { authorization: "Bearer owner" },
		});
	const identity = async (method: string) => {
		const response = await fetch(
			`http://${auth}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=demo-api-key`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email, password, returnSecureToken: true }),
			},
		);
		return { ok: response.ok, body: (await response.json()) as { localId?: string } };
	};
	const target = () =>
		resolveTarget(project.root, {
			worker: project.workers.tenant,
			env: tenant.env,
			"persist-to": join(project.workers.tenant, ".wrangler", `state-${tenant.id}`),
		});
	const tenantQuery = (sql: string) => {
		const result = runTool(project.workers.tenant, "wrangler", [
			"d1",
			"execute",
			...localDatabaseArgs(target()),
			"--json",
			"--command",
			sql,
		]);
		const start = result.stdout.indexOf("[");
		if (result.status !== 0 || start === -1)
			throw new CliError(`Tenant D1 query failed:\n${outputTail(result.output)}`);
		return (JSON.parse(result.stdout.slice(start)) as { results: Record<string, unknown>[] }[])[0]?.results ?? [];
	};
	const globalQuery = (sql: string) => queryD1(project.workers.global, environment.globalEnv, environment, sql);

	return {
		// The emulator serves every namespace; "exists" means it answers.
		realtimeDatabase: async () => (await rtdb("")).ok,
		createRealtimeDatabase: async () => {
			throw new CliError(`The Realtime Database emulator at ${database} does not answer`);
		},
		dispatcher: async () => {
			const { ok, body } = await identity("signInWithPassword");
			return ok && body.localId ? body.localId : null;
		},
		createDispatcher: async () => {
			const { ok, body } = await identity("signUp");
			if (!ok || !body.localId) throw new CliError(`The Auth emulator did not create ${email}`);
			return body.localId;
		},
		rules: async () => {
			const response = await rtdb(".settings/rules");
			return response.ok ? JSON.parse(await response.text()) : null;
		},
		writeRules: async (rules) => {
			const response = await rtdb(".settings/rules", { method: "PUT", body: JSON.stringify(rules) });
			if (!response.ok) throw new CliError(`Rules for ${tenant.id} were not accepted: ${await response.text()}`);
		},
		// Local D1 databases exist as soon as Wrangler opens them.
		database: async () => localDatabaseId(tenant),
		createDatabase: async () => localDatabaseId(tenant),
		// Local KV namespaces exist as soon as Wrangler opens them, like D1.
		secretsNamespace: async () => localSecretsNamespaceId(tenant),
		createSecretsNamespace: async () => localSecretsNamespaceId(tenant),
		bindings: async () => readBindings(project.workers.tenant, tenant.env),
		writeBindings: async (bindings) => writeBindings(project.workers.tenant, tenant.env, bindings),
		extendBindings: async (additions) => extendBindings(project.workers.tenant, tenant.env, additions),
		pendingMigrations: async () => readHistory(target()).pending.length,
		applyMigrations: async () => {
			applyMigrations(target());
		},
		staleSignals: async () => {
			const response = await rtdb("collections");
			const signals = response.ok ? ((await response.json()) as Record<string, { revision?: unknown }> | null) : null;
			const published = Math.max(
				0,
				...Object.values(signals ?? {}).map(({ revision }) => (typeof revision === "number" ? revision : 0)),
			);
			const [row] = tenantQuery("select coalesce(max(seq), 0) as revision from takebase_outbox");
			return published > Number(row?.revision ?? 0);
		},
		clearSignals: async () => {
			const response = await rtdb("collections", { method: "DELETE" });
			if (!response.ok) throw new CliError(`Could not clear ${tenant.id}'s realtime signals`);
		},
		// `takebase dev` runs local tenant Workers; nothing is deployed.
		deployed: null,
		deploy: async () => {},
		registration: async () => {
			const [row] = globalQuery(`select status, url from tenants where id = ${sqlText(tenant.id)}`);
			return row ? { status: String(row.status), url: String(row.url) } : null;
		},
		register: async (url) => {
			const now = sqlText(new Date().toISOString());
			globalQuery(
				`insert into tenants (id, name, url, status, created, updated) values (${sqlText(tenant.id)}, ${sqlText(tenant.name)}, ${sqlText(url)}, 'active', ${now}, ${now}) on conflict(id) do nothing`,
			);
		},
	};
};
