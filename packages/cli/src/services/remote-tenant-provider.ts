import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import {
	dispatcherEmail,
	dispatcherPasswordKey,
	type EnvironmentConfig,
	type ProjectConfig,
	type TenantConfig,
} from "../project-config.ts";
import { addSecret, readSecretsFile } from "../secrets-file.ts";
import { outputTail } from "../worker-target.ts";
import { assertOwned, cloudflareEnv, parseToolJson, queryD1, workerUrl } from "./environment.ts";
import type { TenantProvider } from "./provisioning.ts";
import {
	applyRemoteMigrations,
	defaultRemoteDeps,
	deployWorker,
	getUrl,
	healthy,
	pendingRemoteMigrations,
	type RemoteDeps,
	tenantSecrets,
	waitForUrl,
} from "./remote-workers.ts";
import { extendBindings, readBindings, writeBindings } from "./tenant-providers.ts";

// A remote environment's tenant: a Realtime Database instance in the Firebase
// project, the dispatcher user (Identity Toolkit with the web API key), rules
// deployed to that one instance with the operator's Firebase CLI login, a D1
// database, the tenant's Wrangler environment, the deployed Worker and its
// registration in remote global D1. Every name is checked against the
// environment's prefix before anything is called.

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const remoteTenantProvider = (
	project: ProjectConfig,
	environment: EnvironmentConfig,
	tenant: TenantConfig,
	deps: RemoteDeps = defaultRemoteDeps,
): TenantProvider => {
	const name = `${environment.namePrefix}${tenant.id}`;
	assertOwned(environment, "tenant resource", name);
	const secretsTitle = `${name}-secrets`;
	assertOwned(environment, "tenant secrets KV namespace", secretsTitle);
	const secretsFile = environment.secretsFile ?? "";
	const passwordKey = dispatcherPasswordKey(environment, tenant.id) ?? "";
	const email = dispatcherEmail(environment, tenant.id);
	const databaseUrl = `https://${name}.firebaseio.com`;
	const firebaseProject = ["--project", environment.firebaseProject];
	const health = `${workerUrl(environment, name)}/health`;

	const secret = (key: string) => readSecretsFile(secretsFile).values[key];
	const firebase = (args: string[], what: string, dir = project.root) => {
		const result = deps.run(dir, "firebase", args);
		if (result.status !== 0) throw new CliError(`${what} failed:\n${outputTail(result.output)}`);
		return result;
	};
	const wrangler = (args: string[], what: string) => {
		const result = deps.run(project.workers.tenant, "wrangler", args, cloudflareEnv(environment));
		if (result.status !== 0) throw new CliError(`${what} failed:\n${outputTail(result.output)}`);
		return result;
	};

	type Identity = { localId?: string; idToken?: string; error?: { message?: string } };
	const identity = async (method: "signInWithPassword" | "signUp", password: string) => {
		const key = secret("FIREBASE_API_KEY");
		if (key === undefined) throw new CliError(`FIREBASE_API_KEY is missing from ${secretsFile}`);
		const response = await deps.fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${key}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, returnSecureToken: true }),
		});
		return { ok: response.ok, body: (await response.json()) as Identity };
	};
	// The dispatcher's session, or null when it does not exist yet (or the
	// stored password is missing). Its token reads and clears the signals.
	const signIn = async () => {
		const password = secret(passwordKey);
		if (password === undefined) return null;
		const { ok, body } = await identity("signInWithPassword", password);
		return ok && body.localId && body.idToken ? { uid: body.localId, token: body.idToken } : null;
	};
	const dispatcherToken = async () => {
		const session = await signIn();
		if (session === null) throw new CliError(`The dispatcher ${email} cannot sign in`);
		return session.token;
	};

	const instances = () => {
		const result = firebase(
			["database:instances:list", ...firebaseProject, "--json"],
			"firebase database:instances:list",
		);
		return (parseToolJson(result.stdout) as { result?: { name?: string; state?: string }[] } | undefined)?.result ?? [];
	};
	const namespaces = () => {
		const result = wrangler(["kv", "namespace", "list"], "wrangler kv namespace list");
		return (parseToolJson(result.stdout) as { id?: string; title?: string }[] | undefined) ?? [];
	};
	const databases = () => {
		const result = wrangler(["d1", "list", "--json"], "wrangler d1 list");
		return (parseToolJson(result.stdout) as { name?: string; uuid?: string }[] | undefined) ?? [];
	};
	const globalQuery = (sql: string) =>
		queryD1(project.workers.global, environment.globalEnv, environment, sql, deps.run);
	const tenantQuery = (sql: string) => queryD1(project.workers.tenant, tenant.env, environment, sql, deps.run);

	return {
		realtimeDatabase: async () => instances().some((instance) => instance.name === name && instance.state === "ACTIVE"),
		createRealtimeDatabase: async () => {
			firebase(["database:instances:create", name, ...firebaseProject], "firebase database:instances:create");
		},
		dispatcher: async () => (await signIn())?.uid ?? null,
		createDispatcher: async () => {
			let password = secret(passwordKey);
			if (password === undefined) {
				password = randomBytes(24).toString("base64url");
				addSecret(secretsFile, passwordKey, password);
			}
			const { ok, body } = await identity("signUp", password);
			if (ok && body.localId) return body.localId;
			throw new CliError(`The dispatcher ${email} was not created: ${body.error?.message ?? "unknown error"}`, {
				hint:
					body.error?.message === "EMAIL_EXISTS"
						? `The user exists but does not accept ${passwordKey}; fix it in the Firebase console.`
						: undefined,
			});
		},
		rules: async () => {
			const result = firebase(
				["database:get", "/.settings/rules", "--instance", name, ...firebaseProject],
				"firebase database:get /.settings/rules",
			);
			return parseToolJson(result.stdout) ?? null;
		},
		// Deployed from a temporary firebase.json that lists this instance only.
		writeRules: async (rules) => {
			const temp = mkdtempSync(join(tmpdir(), "takebase-rules-"));
			try {
				writeFileSync(join(temp, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`);
				writeFileSync(
					join(temp, "firebase.json"),
					JSON.stringify({ database: [{ instance: name, rules: "rules.json" }] }),
				);
				firebase(
					[
						"deploy",
						"--only",
						"database",
						...firebaseProject,
						"--config",
						join(temp, "firebase.json"),
						"--non-interactive",
					],
					"firebase deploy --only database",
					temp,
				);
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		},
		database: async () => databases().find((database) => database.name === name)?.uuid ?? null,
		createDatabase: async () => {
			const result = wrangler(["d1", "create", name, "--update-config=false"], "wrangler d1 create");
			const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(result.output)?.[0];
			if (id === undefined)
				throw new CliError(`wrangler d1 create printed no database id:\n${outputTail(result.output)}`);
			return id;
		},
		secretsNamespace: async () => namespaces().find((namespace) => namespace.title === secretsTitle)?.id ?? null,
		createSecretsNamespace: async () => {
			const result = wrangler(
				["kv", "namespace", "create", secretsTitle, "--update-config=false"],
				"wrangler kv namespace create",
			);
			const id = /\b[0-9a-f]{32}\b/.exec(result.output)?.[0];
			if (id === undefined)
				throw new CliError(`wrangler kv namespace create printed no namespace id:\n${outputTail(result.output)}`);
			return id;
		},
		bindings: async () => readBindings(project.workers.tenant, tenant.env),
		writeBindings: async (bindings) => writeBindings(project.workers.tenant, tenant.env, bindings),
		extendBindings: async (additions) => extendBindings(project.workers.tenant, tenant.env, additions),
		pendingMigrations: async () =>
			pendingRemoteMigrations(deps, project.workers.tenant, tenant.env, environment).length,
		applyMigrations: async () => applyRemoteMigrations(deps, project.workers.tenant, tenant.env, environment),
		staleSignals: async () => {
			const token = await dispatcherToken();
			const response = await deps.fetch(`${databaseUrl}/collections.json?auth=${token}`);
			if (!response.ok) throw new CliError(`Reading ${name}'s signals failed: ${response.status}`);
			const signals = (await response.json()) as Record<string, { revision?: unknown }> | null;
			const published = Math.max(
				0,
				...Object.values(signals ?? {}).map(({ revision }) => (typeof revision === "number" ? revision : 0)),
			);
			const [row] = tenantQuery("select coalesce(max(seq), 0) as revision from takebase_outbox");
			return published > Number(row?.revision ?? 0);
		},
		// The rules let the dispatcher delete one collection signal at a time.
		clearSignals: async () => {
			const token = await dispatcherToken();
			const response = await deps.fetch(`${databaseUrl}/collections.json?shallow=true&auth=${token}`);
			if (!response.ok) throw new CliError(`Reading ${name}'s signals failed: ${response.status}`);
			for (const collection of Object.keys(((await response.json()) as Record<string, unknown> | null) ?? {})) {
				const deleted = await deps.fetch(
					`${databaseUrl}/collections/${encodeURIComponent(collection)}.json?auth=${token}`,
					{ method: "DELETE" },
				);
				await deleted.body?.cancel();
				if (!deleted.ok) throw new CliError(`Clearing ${name}'s ${collection} signal failed: ${deleted.status}`);
			}
		},
		// Deployed means its /health answers for this tenant; `takebase deploy` updates code.
		deployed: async () => healthy({ tenantId: tenant.id })(await getUrl(deps, health)),
		deploy: async () => {
			deployWorker(deps, project.workers.tenant, tenant.env, environment, tenantSecrets(environment, tenant.id));
			await waitForUrl(deps, health, healthy({ tenantId: tenant.id }));
		},
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
