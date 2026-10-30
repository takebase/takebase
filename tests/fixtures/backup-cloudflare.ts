import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliIo } from "../../packages/cli/src/errors.ts";
import type { RemoteDeps } from "../../packages/cli/src/services/remote-workers.ts";
import { importDataKey, sealEnvelope } from "../../packages/cli/src/services/secret-envelopes.ts";

// A throwaway remote project and a FAKE Wrangler for the backup and restore
// tests (SEGU-225, SEGU-226): D1 exports, each tenant's KV and one R2 bucket
// in memory, answering the calls the CLI makes. It proves what the CLI asks
// for, not that Cloudflare accepts it (that is the smoke journey with real
// local Wrangler, and staging). Keys and values are random per run.

export const account = "acct-pinned";

const write = (root: string, path: string, text: string) => {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), text);
};

export const exportSql = (migrations: string[], table: string) =>
	[
		"PRAGMA defer_foreign_keys=TRUE;",
		'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
		// Literal applied_at, as wrangler d1 export writes it: a defaulted
		// CURRENT_TIMESTAMP would differ between two replays a second apart.
		...migrations.map(
			(name, i) =>
				`INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(${i + 1},'${name}','2026-10-28 12:00:00');`,
		),
		`CREATE TABLE \`${table}\` (\`id\` text PRIMARY KEY NOT NULL);`,
		`INSERT INTO "${table}" ("id") VALUES('row-1');`,
		`CREATE TRIGGER \`${table}_no_delete\` BEFORE DELETE ON \`${table}\` BEGIN SELECT RAISE(ABORT, 'no'); END;`,
	].join("\n");

export const globalMigrations = ["0000_tenants.sql", "0001_access.sql"];
export const tenantMigrations = ["0000_policies.sql"];

export const backupProject = (root: string, bucket: string, secrets: Record<string, string>) => {
	const put = (path: string, text: string) => write(root, path, text);
	put(
		"takebase.jsonc",
		JSON.stringify({
			workers: { global: "global", tenant: "tenant", app: "app" },
			environments: {
				staging: {
					remote: true,
					firebaseProject: "takebase-test",
					namePrefix: "takebase-staging-",
					workersSubdomain: "sub",
					globalEnv: "staging",
					appEnv: "staging",
					secretsFile: "secrets.env",
					backupBucket: bucket,
					dispatcherPasswordKey: "PASSWORD_DISPATCHER_{TENANT}",
					dispatcherEmail: "dispatcher-{tenant}@example.test",
					tenants: {
						"tenant-a": { name: "A", env: "staging-tenant-a" },
						"tenant-b": { name: "B", env: "staging-tenant-b" },
					},
				},
			},
		}),
	);
	put(
		"secrets.env",
		`${Object.entries(secrets)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
	);
	const d1 = (name: string, dir: string) => [
		{ binding: "DB", database_name: name, database_id: `id-${name}`, migrations_dir: dir },
	];
	put(
		"global/wrangler.jsonc",
		JSON.stringify({
			name: "example-global",
			env: {
				staging: {
					name: "takebase-staging-global",
					vars: { TAKEBASE_ENV: "staging" },
					d1_databases: d1("takebase-staging-global", "../migrations/global"),
				},
			},
		}),
	);
	const tenantEnv = (id: string) => ({
		name: `takebase-staging-${id}`,
		vars: { TENANT_ID: id, TAKEBASE_ENV: "staging", DATA_KEY_VERSION: "2", FIREBASE_API_KEY: secrets.FIREBASE_API_KEY },
		d1_databases: d1(`takebase-staging-${id}`, "../migrations/tenant"),
		kv_namespaces: [{ binding: "SECRETS", id: `kv-${id}` }],
	});
	put(
		"tenant/wrangler.jsonc",
		JSON.stringify({
			name: "example-tenant",
			env: { "staging-tenant-a": tenantEnv("tenant-a"), "staging-tenant-b": tenantEnv("tenant-b") },
		}),
	);
	for (const name of globalMigrations) put(`migrations/global/${name}`, `-- ${name}\n`);
	for (const name of tenantMigrations) put(`migrations/tenant/${name}`, `-- ${name}\n`);
};

// A fake Wrangler: D1 exports, each tenant's KV and one R2 bucket in memory,
// plus the D1 databases and KV namespaces a restore creates (by name), where
// an import is kept as its SQL and exported back as it is.
// `existing`: D1 databases and KV namespaces the account already has, by name.
// `faults`: make the next import fail (leaving the database empty or, with
// "partial", with tables), the next bulk puts fail, or the export change.
export const fakeCloudflare = (
	kv: Record<string, Map<string, { value: string; metadata: unknown }>>,
	existing: string[] = [],
) => {
	const r2 = new Map<string, Buffer>();
	const databases = new Map<string, { uuid: string; sql: string | null }>();
	const namespaces = new Map<string, { id: string; title: string; entries: Map<string, string> }>();
	const faults: { import?: "fail" | "partial"; bulk?: number; export?: (sql: string) => string } = {};
	const known = () => {
		for (const name of existing) {
			if (!databases.has(name)) databases.set(name, { uuid: `uuid-${name}`, sql: null });
			if (![...namespaces.values()].some(({ title }) => title === name)) {
				namespaces.set(`id-${name}`, { id: `id-${name}`, title: name, entries: new Map() });
			}
		}
	};
	// The database a temporary restore configuration (-c) binds as DB.
	const configured = (args: string[]) => {
		const config = JSON.parse(readFileSync(flag(args, "-c"), "utf8")) as {
			d1_databases: { database_name: string }[];
		};
		return databases.get(config.d1_databases[0]?.database_name ?? "");
	};
	const calls: { args: string[]; env: Record<string, string> | undefined }[] = [];
	const ok = (stdout = "") => ({ status: 0, stdout, output: stdout });
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	const deps: RemoteDeps = {
		run: (_dir, tool, args, env) => {
			calls.push({ args, env });
			if (tool !== "wrangler") throw new Error(`unexpected tool ${tool}`);
			if (args[0] === "whoami") return ok(JSON.stringify({ loggedIn: true, accounts: [{ id: account }] }));
			known();
			if (args[0] === "d1" && args.includes("-c") && args.includes("--remote")) {
				const database = configured(args);
				if (database === undefined) throw new Error(`no such database in ${args.join(" ")}`);
				if (args[1] === "execute" && args.includes("--command")) {
					return ok(JSON.stringify([{ results: [{ tables: database.sql === null ? 0 : 1 }] }]));
				}
				if (args[1] === "execute" && args.includes("--file")) {
					const fault = faults.import;
					faults.import = undefined;
					if (fault === "partial") database.sql = "-- partial";
					if (fault !== undefined) return { status: 1, stdout: "", output: "D1_ERROR: import interrupted" };
					database.sql = readFileSync(flag(args, "--file"), "utf8");
					return ok("Executed");
				}
				if (args[1] === "export") {
					const sql = database.sql ?? "";
					writeFileSync(flag(args, "--output"), faults.export ? faults.export(sql) : sql);
					return ok("Done!");
				}
			}
			if (args[0] === "d1" && args[1] === "create") {
				databases.set(args[2] ?? "", { uuid: `uuid-${args[2]}`, sql: null });
				return ok("Created");
			}
			if (args[0] === "d1" && args[1] === "delete") {
				databases.delete(args[2] ?? "");
				return ok("Deleted");
			}
			if (args[0] === "kv" && args[1] === "namespace" && args[2] === "create") {
				namespaces.set(`id-${args[3]}`, { id: `id-${args[3]}`, title: args[3] ?? "", entries: new Map() });
				return ok("Created");
			}
			if (args[0] === "kv" && args[1] === "namespace" && args[2] === "delete") {
				namespaces.delete(flag(args, "--namespace-id"));
				return ok("Deleted");
			}
			if (args[0] === "kv" && args.includes("--namespace-id")) {
				const namespace = namespaces.get(flag(args, "--namespace-id"));
				if (namespace === undefined) throw new Error(`no such namespace in ${args.join(" ")}`);
				if (args[1] === "bulk" && args[2] === "put") {
					if ((faults.bulk ?? 0) > 0) {
						faults.bulk = (faults.bulk ?? 0) - 1;
						return { status: 1, stdout: "", output: "500 Internal Server Error" };
					}
					const entries = JSON.parse(readFileSync(args[3] ?? "", "utf8")) as { key: string; value: string }[];
					for (const { key, value } of entries) namespace.entries.set(key, value);
					return ok("Success!");
				}
				if (args[2] === "list") return ok(JSON.stringify([...namespace.entries.keys()].map((name) => ({ name }))));
				if (args[2] === "get") return ok(namespace.entries.get(args[3] ?? "") ?? "Value not found");
			}
			if (args[0] === "d1" && args[1] === "export") {
				const env = flag(args, "--env");
				const text =
					env === "staging" ? exportSql(globalMigrations, "tenants") : exportSql(tenantMigrations, "policies");
				writeFileSync(flag(args, "--output"), text);
				return ok("Done!");
			}
			if (args[0] === "d1" && args[1] === "list") {
				return ok(JSON.stringify([...databases].map(([name, { uuid }]) => ({ name, uuid }))));
			}
			if (args[0] === "kv" && args[1] === "namespace" && args[2] === "list") {
				return ok(JSON.stringify([...namespaces.values()].map(({ id, title }) => ({ id, title }))));
			}
			if (args[0] === "kv") {
				const namespace = kv[flag(args, "--env")] ?? new Map();
				if (args[2] === "list") {
					return ok(JSON.stringify([...namespace].map(([name, { metadata }]) => ({ name, metadata }))));
				}
				if (args[2] === "get") return ok(namespace.get(args[3] ?? "")?.value ?? "Value not found");
			}
			if (args[0] === "r2" && args[1] === "object") {
				const key = args[3] ?? "";
				if (args[2] === "put") {
					r2.set(key, readFileSync(flag(args, "--file")));
					return ok("Upload complete.");
				}
				if (args[2] === "delete") {
					r2.delete(key);
					return ok("Delete complete.");
				}
				if (args[2] === "get") {
					const bytes = r2.get(key);
					if (bytes === undefined) return { status: 1, stdout: "", output: "The specified key does not exist." };
					writeFileSync(flag(args, "--file"), bytes);
					return ok("Download complete.");
				}
			}
			throw new Error(`unexpected wrangler ${args.join(" ")}`);
		},
		fetch: () => Promise.reject(new Error("no network")),
		wait: async () => {},
	};
	return { deps, r2, calls, databases, namespaces, faults };
};

export const cliIo = (root: string) => {
	const out: string[] = [];
	const value: CliIo = { stdout: (text) => out.push(text), stderr: (text) => out.push(text), cwd: root };
	return { io: value, text: () => out.join("") };
};

export const secretsKv = async (key: string, plaintexts: string[]) => {
	const dataKey = await importDataKey(key);
	const map = new Map<string, { value: string; metadata: unknown }>();
	for (const [i, plaintext] of plaintexts.entries()) {
		const binding = { tenantId: "tenant-a", environment: "staging", keyVersion: 2, purpose: "smtp", name: `n${i}` };
		map.set(`secret/smtp/n${i}`, {
			value: await sealEnvelope(dataKey, binding, new TextEncoder().encode(plaintext)),
			metadata: { kv: 2, updated: "2026-10-28T00:00:00.000Z" },
		});
	}
	return map;
};
